// Professional handoff and contractor outcomes.
// The contractor sees AI output labelled as unverified hypotheses, never as a diagnosis.

import { conflict, notFound } from '../middleware/errors.js';
import { addMessage, latestAssessment, listMedia, activeSteps } from './cases/caseRepo.js';
import { STATUS, transition } from './cases/caseStatus.js';
import { addHistory, loadPassport } from './memory/passport.js';

export function createHandoffService({ db, platform }) {
  async function buildHandoff(c) {
    const [assessment, media, steps, passport, property] = await Promise.all([
      latestAssessment(db, c.id),
      listMedia(db, c.id),
      activeSteps(db, c.id),
      loadPassport(db, c.property_id, { category: c.category, excludeCaseId: c.id }),
      db.query('SELECT address_line1, city, state, zip FROM properties WHERE id = $1', [c.property_id]),
    ]);
    const a = assessment?.result;
    return {
      case_id: c.id,
      case_ref: c.public_ref,
      assessment_id: assessment?.id || null,
      service_location: property.rows[0],
      category: c.category,
      original_description: c.description,
      photos: media.map((m) => ({ id: m.id, label: m.label, url: `/api/fixera/cases/${c.id}/media/${m.id}` })),
      ai_assessment: a
        ? {
            label: 'AI-generated preliminary hypotheses. Not verified. Your own inspection takes precedence.',
            problem_summary: a.problem_summary,
            possible_causes: a.possible_causes.map((x) => ({ ...x, verified: false })),
            observations: a.observations,
            visual_analysis_performed: a.visual_analysis_performed,
            generated_at: a.provenance?.generated_at,
          }
        : null,
      safety: a ? { level: a.safety.level, hazards: a.safety.hazards } : null,
      troubleshooting_attempted: steps
        .filter((s) => s.status !== 'pending')
        .map((s) => ({ step: s.title, result: s.status, homeowner_note: s.result_note })),
      equipment_history: passport.equipment
        .filter((e) => e.category === c.category || e.id === c.equipment_id)
        .map((e) => ({ ...e, history: passport.history.filter((h) => h.equipment_id === e.id).map((h) => ({ date: h.occurred_on, summary: h.summary, verification: h.verification_status })) })),
      ai_cost_estimate: a?.cost_estimate ? { ...a.cost_estimate, label: 'AI market estimate, not a quote' } : null,
    };
  }

  /** Transfers the case (description, photos, assessment, steps) into a service request. */
  async function hirePro(c, user, { preferredDate, preferredWindow, notes }) {
    if (c.service_request_id) throw conflict('A professional has already been requested for this case', { service_request_id: c.service_request_id });
    const handoff = await buildHandoff(c);
    if (notes) handoff.homeowner_notes = notes;
    const fee = await platform.getDispatchFeeCents(c.category);
    return db.tx(async (q) => {
      const sr = await platform.createServiceRequest(q, {
        propertyId: c.property_id,
        customerId: c.customer_id,
        category: c.category,
        description: c.description,
        preferredDate,
        preferredWindow,
        caseId: c.id,
        assessmentId: handoff.assessment_id,
        handoff,
        fee,
      });
      await transition(q, c.id, STATUS.REFERRED, { actorId: user.id, reason: 'hire_pro', extraSet: ', service_request_id = $5', extraParams: [sr.id] });
      await addMessage(q, c.id, { role: 'system', kind: 'handoff', content: 'Your case was sent to FixBridge professional booking with your description, photos and troubleshooting history.', authorId: user.id });
      return sr;
    });
  }

  /** Contractor (or admin) records what was actually found and done. */
  async function completeJob(serviceRequestId, user, body) {
    const { rows } = await db.query('SELECT * FROM service_requests WHERE id = $1', [serviceRequestId]);
    const sr = rows[0];
    if (!sr || (user.role === 'contractor' && sr.assigned_contractor_id !== user.id)) throw notFound('Job not found');
    if (sr.status === 'completed') throw conflict('Job already completed');

    if (body.equipment_id) {
      const { rows: eq } = await db.query('SELECT 1 FROM property_equipment WHERE id = $1 AND property_id = $2', [body.equipment_id, sr.property_id]);
      if (!eq.length) body = { ...body, equipment_id: undefined };
    }
    const c = sr.fixera_case_id ? (await db.query('SELECT * FROM fixera_cases WHERE id = $1', [sr.fixera_case_id])).rows[0] : null;
    const assessment = c ? await latestAssessment(db, c.id) : null;
    const mismatch = assessment ? detectMismatch(assessment.result, body) : null;

    return db.tx(async (q) => {
      await q.query(`UPDATE service_requests SET status = 'completed', updated_at = now() WHERE id = $1`, [sr.id]);
      const historyId = await addHistory(q, {
        propertyId: sr.property_id,
        equipmentId: body.equipment_id || c?.equipment_id,
        category: sr.category,
        eventType: 'contractor_completion',
        summary: `${body.final_diagnosis}. Work: ${body.work_performed}`,
        details: { parts_replaced: body.parts_replaced, recommendations: body.recommendations, completed_by: user.id },
        verificationStatus: 'contractor_recorded',
        costCents: body.invoice_cents ?? null,
        caseId: c?.id,
        serviceRequestId: sr.id,
      });
      if (body.equipment_update && (body.equipment_id || c?.equipment_id)) {
        const u = body.equipment_update;
        await q.query(
          `UPDATE property_equipment SET brand = coalesce($2, brand), model_number = coalesce($3, model_number),
             serial_number = coalesce($4, serial_number), installed_on = coalesce($5::date, installed_on), updated_at = now()
           WHERE id = $1 AND property_id = $6`,
          [body.equipment_id || c.equipment_id, u.brand ?? null, u.model_number ?? null, u.serial_number ?? null, u.installed_on ?? null, sr.property_id],
        );
      }
      for (const r of body.maintenance_reminders || []) {
        await q.query(
          `INSERT INTO property_reminders (property_id, equipment_id, title, due_on, recurrence_days, source) VALUES ($1,$2,$3,$4,$5,'contractor')`,
          [sr.property_id, body.equipment_id || c?.equipment_id || null, r.title, r.due_on, r.recurrence_days ?? null],
        );
      }
      let outcome = null;
      if (c) {
        const { rows: o } = await q.query(
          `INSERT INTO fixera_outcomes (case_id, resolution, verification_status, source, reported_by, final_diagnosis, work_performed,
              parts_replaced, actual_cost_cents, ai_accuracy, notes)
           VALUES ($1,$2,'contractor_recorded','contractor',$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
          [c.id, body.resolved ? 'resolved' : 'unresolved', user.id, body.final_diagnosis, body.work_performed,
            JSON.stringify(body.parts_replaced || []), body.invoice_cents ?? null, body.ai_accuracy || 'not_assessed', body.recommendations || null],
        );
        outcome = o[0];
        if (mismatch?.flag) {
          await q.query(
            `INSERT INTO fixera_feedback (case_id, assessment_id, kind, comment, author_id) VALUES ($1,$2,'diagnosis_mismatch',$3,$4)`,
            [c.id, assessment.id, mismatch.reason, user.id],
          );
        }
        await transition(q, c.id, body.resolved ? STATUS.RESOLVED : STATUS.UNRESOLVED, { actorId: user.id, reason: 'contractor_completion' });
        await addMessage(q, c.id, { role: 'system', kind: 'contractor_completion', content: `A FixBridge professional completed the visit. Finding: ${body.final_diagnosis}`, authorId: user.id });
      }
      return { service_request_id: sr.id, history_id: historyId, outcome, mismatch_flagged: Boolean(mismatch?.flag) };
    });
  }

  return { buildHandoff, hirePro, completeJob };
}

/**
 * Flags an assessment for review when the contractor says the AI was wrong, or when the
 * contractor's finding shares no meaningful words with any AI hypothesis.
 */
export function detectMismatch(assessment, body) {
  if (['incorrect', 'partially_correct'].includes(body.ai_accuracy)) {
    return { flag: true, reason: `Contractor marked AI assessment ${body.ai_accuracy}. Final diagnosis: ${body.final_diagnosis}` };
  }
  if (body.ai_accuracy === 'correct') return { flag: false };
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
  const finding = words(body.final_diagnosis);
  const overlap = (assessment.possible_causes || []).some((c) => [...words(c.name)].some((w) => finding.has(w)));
  return overlap || !(assessment.possible_causes || []).length
    ? { flag: false }
    : { flag: true, reason: `Contractor finding "${body.final_diagnosis}" does not match AI hypotheses: ${(assessment.possible_causes || []).map((c) => c.name).join('; ')}` };
}
