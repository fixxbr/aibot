// Fixera Core orchestration. One pipeline serves every entry point (initial analysis,
// follow-up messages, new photos, step results), so case context is never rebuilt from a
// blank prompt and the same safety rules always apply.
//
//  1 validate (done by the API layer: auth, property access, entitlement)
//  2 screen for hazards            -> safety.prescreen
//  3-5 understand + retrieve context -> passport, knowledge, conversation, photos
//  6-7 reason                       -> provider router (vision model, structured output)
//  8 enforce safety + ground claims  -> assemble.groundProposal, safety.enforce
//  9 structured result + pricing     -> pricing.estimate, decideStatus
// 10 persist                         -> assessment, steps, message, case status

import { logger } from '../logger.js';
import { activeSteps, addMessage, latestAssessment, listMedia } from './cases/caseRepo.js';
import { STATUS, transition } from './cases/caseStatus.js';
import { loadPassport } from './memory/passport.js';
import { NoProviderAvailableError } from './providers/router.js';
import { decideStatus, groundProposal } from './reasoning/assemble.js';
import { buildMessages, SYSTEM_PROMPT } from './reasoning/prompts.js';
import { ModelAssessment, modelAssessmentJsonSchema, PROMPT_VERSION } from './reasoning/schemas.js';
import { enforce, POLICY_VERSION, prescreen, safetyMessage } from './safety/safetyEngine.js';

const jsonSchema = modelAssessmentJsonSchema();

export function createOrchestrator({ db, router, storage, knowledge, pricing, config }) {
  const running = new Map(); // caseId -> Promise

  /** Marks the case ANALYZING and runs the pipeline in the background. */
  async function start(caseId, { trigger, turnNote, actorId }) {
    await db.tx((q) => transition(q, caseId, STATUS.ANALYZING, { actorId, reason: trigger }));
    const p = runTurn(caseId, { trigger, turnNote, actorId })
      .catch((err) => logger.error({ caseId, err: { message: err.message, stack: err.stack } }, 'analysis crashed'))
      .finally(() => running.delete(caseId));
    running.set(caseId, p);
    // Wrapped so callers can respond 202 without awaiting the analysis itself.
    return { done: p };
  }

  async function runTurn(caseId, { trigger, turnNote, actorId }) {
    try {
      return await pipeline(caseId, { trigger, turnNote });
    } catch (err) {
      const reason = err instanceof NoProviderAvailableError ? 'no_provider_available' : 'internal_error';
      logger.warn({ caseId, reason, attempts: err.attempts }, 'analysis failed');
      await db.tx(async (q) => {
        await transition(q, caseId, STATUS.ANALYSIS_FAILED, { actorId, reason, detail: reason });
        await addMessage(q, caseId, {
          role: 'system',
          kind: 'analysis_failed',
          content: 'Fixera could not complete a reliable analysis right now. Your description and photos are saved. You can try again in a few minutes, or book a professional without re-entering anything.',
        });
      });
      return null;
    }
  }

  async function pipeline(caseId, { trigger, turnNote }) {
    const { rows } = await db.query('SELECT * FROM fixera_cases WHERE id = $1', [caseId]);
    const c = rows[0];
    const { rows: msgRows } = await db.query(
      `SELECT role, kind, content, created_at FROM (
         SELECT * FROM fixera_messages WHERE case_id = $1 ORDER BY seq DESC LIMIT $2
       ) m ORDER BY seq`,
      [caseId, config.analysis.maxHistoryMessages],
    );
    const { rows: allHomeownerText } = await db.query(`SELECT content FROM fixera_messages WHERE case_id = $1 AND role = 'homeowner'`, [caseId]);
    const steps = await activeSteps(db, caseId);

    // Stage 2: deterministic hazard screen over everything the homeowner has said.
    const screen = prescreen({
      texts: [c.description, ...allHomeownerText.map((m) => m.content), ...steps.map((s) => s.result_note).filter(Boolean)],
      category: c.category,
    });

    if (screen.emergency) return persistEmergency(c, screen, trigger);

    // Stages 3-5: context.
    const passport = await loadPassport(db, c.property_id, { category: c.category, excludeCaseId: c.id });
    const caseEquipment = passport.equipment.find((e) => e.id === c.equipment_id);
    const recentHomeowner = msgRows.filter((m) => m.role === 'homeowner').slice(-3).map((m) => m.content).join(' ');
    const [knowledgeChunks, pricingCatalog, prior, mediaRows] = await Promise.all([
      knowledge.retrieve({
        query: `${c.description} ${recentHomeowner}`,
        category: c.category,
        equipmentType: caseEquipment?.equipment_type,
        brand: caseEquipment?.brand,
        limit: config.analysis.maxKnowledgeChunks,
      }),
      pricing.catalog(c.category),
      latestAssessment(db, caseId),
      listMedia(db, caseId),
    ]);
    const media = await Promise.all(mediaRows.map(async (m) => ({ ...m, base64: (await storage.get(m.storage_key)).toString('base64') })));

    const ctx = { case: c, passport, knowledge: knowledgeChunks, pricingCatalog, latestAssessment: prior, steps, screen, messages: msgRows, media, trigger, turnNote };

    // Stages 6-7: reasoning through the provider router.
    const result = await router.run({
      task: 'diagnose',
      caseId,
      system: SYSTEM_PROMPT,
      buildMessages: (includeImages) => buildMessages(ctx, includeImages),
      imageCount: media.length,
      schema: ModelAssessment,
      jsonSchema,
      promptVersion: PROMPT_VERSION,
      policyVersion: POLICY_VERSION,
    });

    // Stage 8: ground claims, then enforce safety deterministically.
    const grounded = groundProposal(result.output, ctx, { visionUsed: result.visionUsed });
    const { proposal, safety } = enforce({ screen, proposal: grounded.proposal, category: c.category });
    const status = decideStatus({ safety, proposal, evidenceInsufficient: grounded.evidenceInsufficient });

    // Stage 9: deterministic pricing.
    const cost = await pricing.estimate({
      category: c.category,
      issueKey: proposal.pricing_key,
      zip: passport.property?.zip,
      professionalRequired: status === STATUS.PROFESSIONAL_REQUIRED || proposal.professional_recommended,
    });

    const reply = proposal.reply_to_homeowner || safetyMessage(safety);
    const knowledgeById = new Map(knowledgeChunks.map((k) => [k.id, k]));
    const assessment = {
      case_ref: c.public_ref,
      status,
      reply,
      problem_summary: proposal.problem_summary,
      category: c.category,
      equipment: proposal.equipment,
      equipment_id: proposal.equipment_id,
      visual_analysis_performed: result.visionUsed && media.length > 0,
      photos_analyzed: result.visionUsed ? media.map((m) => m.label) : [],
      image_findings: proposal.image_findings,
      observations: proposal.observations,
      possible_causes: proposal.possible_causes,
      history_considered: proposal.history_considered,
      history_available: passport.equipment.length + passport.history.length + passport.priorCases.length > 0,
      knowledge_sources: proposal.knowledge_used.map((id) => ({ id, title: knowledgeById.get(id)?.title, source_type: knowledgeById.get(id)?.source_type, source_ref: knowledgeById.get(id)?.source_ref })),
      missing_information: proposal.missing_information,
      photo_requests: proposal.photo_requests,
      next_question: proposal.next_question,
      safety,
      diy: {
        permitted: safety.diy_permitted && status !== STATUS.PROFESSIONAL_REQUIRED,
        scope: status === STATUS.PROFESSIONAL_REQUIRED ? 'none' : safety.diy_scope,
        difficulty: proposal.difficulty,
        estimated_minutes: proposal.estimated_minutes,
        tools: proposal.tools,
        parts: proposal.parts,
        preparation: proposal.preparation,
        escalation_signs: proposal.escalation_signs,
      },
      cost_estimate: cost,
      professional_recommended: proposal.professional_recommended || safety.professional_required || status === STATUS.PROFESSIONAL_REQUIRED,
      validation: { notes: grounded.notes, evidence_insufficient: grounded.evidenceInsufficient },
      provenance: {
        provider: result.provider,
        model: result.model,
        provider_run_id: result.runId,
        prompt_version: PROMPT_VERSION,
        policy_version: POLICY_VERSION,
        generated_at: new Date().toISOString(),
      },
    };
    // Professional-required cases never carry DIY steps.
    const newSteps = status === STATUS.PROFESSIONAL_REQUIRED || status === STATUS.EMERGENCY ? [] : proposal.steps;
    return persist(c, { assessment, status, steps: newSteps, trigger, prior, media, provider: result });
  }

  async function persistEmergency(c, screen, trigger) {
    const safety = {
      level: 'EMERGENCY',
      diy_permitted: false,
      diy_scope: 'none',
      professional_required: true,
      hazards: screen.hazards.map(({ rule_id, level, source }) => ({ rule_id, level, source })),
      guidance: screen.guidance,
      removed_actions: [],
      reply_replaced: true,
      policy_version: POLICY_VERSION,
    };
    const assessment = {
      case_ref: c.public_ref,
      status: STATUS.EMERGENCY,
      reply: safetyMessage(safety),
      problem_summary: 'Possible emergency reported',
      category: c.category,
      equipment: null,
      equipment_id: null,
      visual_analysis_performed: false,
      photos_analyzed: [],
      image_findings: [],
      observations: [],
      possible_causes: [],
      history_considered: [],
      history_available: null,
      knowledge_sources: [],
      missing_information: [],
      photo_requests: [],
      next_question: null,
      safety,
      diy: { permitted: false, scope: 'none', difficulty: null, estimated_minutes: null, tools: [], parts: [], preparation: [], escalation_signs: [] },
      cost_estimate: null,
      professional_recommended: true,
      validation: { notes: ['emergency_short_circuit_no_model_call'], evidence_insufficient: false },
      provenance: { provider: null, model: null, provider_run_id: null, prompt_version: PROMPT_VERSION, policy_version: POLICY_VERSION, generated_at: new Date().toISOString() },
    };
    return persist(c, { assessment, status: STATUS.EMERGENCY, steps: [], trigger, prior: null, media: [], provider: null });
  }

  async function persist(c, { assessment, status, steps, trigger, prior, media, provider }) {
    return db.tx(async (q) => {
      const { rows: v } = await q.query('SELECT coalesce(max(version), 0) + 1 AS v FROM fixera_assessments WHERE case_id = $1', [c.id]);
      const { rows } = await q.query(
        `INSERT INTO fixera_assessments
           (case_id, version, trigger, result_status, risk_level, diy_permitted, visual_analysis_performed, result,
            provider, model, provider_run_id, prompt_version, policy_version, evidence_media_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`,
        [c.id, v[0].v, trigger, status, assessment.safety.level, assessment.diy.permitted, assessment.visual_analysis_performed,
          JSON.stringify(assessment), provider?.provider || null, provider?.model || null, provider?.runId || null,
          PROMPT_VERSION, POLICY_VERSION, JSON.stringify(assessment.visual_analysis_performed ? media.map((m) => m.id) : [])],
      );
      const saved = rows[0];

      // Step continuity: new steps replace the old plan; a turn that only answers a question
      // keeps the current plan unless the risk went up.
      const riskRose = prior && rank(assessment.safety.level) > rank(prior.risk_level);
      if (steps.length || riskRose || status === STATUS.PROFESSIONAL_REQUIRED || status === STATUS.EMERGENCY) {
        await q.query(`UPDATE fixera_steps SET status = 'superseded' WHERE case_id = $1 AND status <> 'superseded'`, [c.id]);
      }
      for (const [i, s] of steps.entries()) {
        await q.query(
          `INSERT INTO fixera_steps (assessment_id, case_id, seq, action_type, title, instruction, caution, stop_condition, verification)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [saved.id, c.id, i + 1, s.action_type, s.title, s.instruction, s.caution, s.stop_condition, s.verification],
        );
      }
      await addMessage(q, c.id, { role: 'assistant', kind: 'assessment', content: assessment.reply, assessmentId: saved.id });
      await transition(q, c.id, status, {
        reason: `assessment_v${saved.version}`,
        extraSet: ', latest_assessment_id = $5, equipment_id = coalesce(equipment_id, $6)',
        extraParams: [saved.id, assessment.equipment_id],
      });
      return saved;
    });
  }

  return {
    start,
    /** Test/ops helper: resolves when the case's current analysis finishes. */
    wait: (caseId) => running.get(caseId) || Promise.resolve(null),
    waitAll: () => Promise.all([...running.values()]),
    /** On boot, cases left ANALYZING by a crash become recoverable failures. */
    async recoverInterrupted() {
      const { rows } = await db.query(`SELECT id FROM fixera_cases WHERE status = 'ANALYZING' AND updated_at < now() - interval '10 minutes'`);
      for (const r of rows) await db.tx((q) => transition(q, r.id, STATUS.ANALYSIS_FAILED, { reason: 'interrupted', detail: 'interrupted' }));
      return rows.length;
    },
  };
}

const rank = (l) => ['LOW', 'MODERATE', 'HIGH', 'EMERGENCY'].indexOf(l);
