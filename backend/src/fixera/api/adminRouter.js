import express from 'express';
import * as z from 'zod/v4';
import { asyncHandler, badRequest, notFound, parseBody } from '../../middleware/errors.js';
import { isUuid } from '../access.js';
import { redactPII } from '../knowledge/redact.js';
import { HAZARD_RULES, POLICY_VERSION, PROHIBITED_ACTIONS } from '../safety/policy.js';
import { Completion } from './contractorRouter.js';

const ProviderConfig = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  model: z.string().max(200).nullable().optional(),
  timeout_ms: z.number().int().min(5_000).max(600_000).nullable().optional(),
});
const KnowledgeDoc = z.object({
  title: z.string().min(3).max(300),
  source_type: z.enum(['manufacturer_manual', 'repair_guide', 'reviewed_case', 'safety_rule', 'parts_reference', 'decision_tree']),
  source_ref: z.string().max(500).optional(),
  category: z.string().optional(),
  equipment_type: z.string().max(120).optional(),
  brand: z.string().max(120).optional(),
  model_pattern: z.string().max(120).optional(),
  text: z.string().min(20).max(500_000),
});
const PricingRule = z.object({
  category: z.string(),
  issue_key: z.string().regex(/^[a-z0-9_.]+$/),
  description: z.string().min(3).max(300),
  zip_prefix: z.string().regex(/^\d{3,5}$/).nullable().optional(),
  parts_min_cents: z.number().int().nonnegative().nullable().optional(),
  parts_max_cents: z.number().int().nonnegative().nullable().optional(),
  labor_min_cents: z.number().int().nonnegative().nullable().optional(),
  labor_max_cents: z.number().int().nonnegative().nullable().optional(),
  source: z.string().min(3).max(300),
});
const Review = z.object({
  action: z.enum(['verify', 'dismiss', 'promote']),
  generalized_summary: z.string().min(20).max(20_000).optional(),
});

export function createAdminRouter({ db, router, knowledge, platform, handoff }) {
  const r = express.Router();
  const audit = (actor, action, target, details = {}) =>
    db.query('INSERT INTO fixera_audit_log (actor_id, action, target, details) VALUES ($1,$2,$3,$4::jsonb)', [actor, action, target, JSON.stringify(details)]);

  // Providers: configuration only. API keys live in server environment variables.
  r.get('/providers', asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM fixera_provider_config ORDER BY priority');
    res.json({ configured: router.health(), overrides: rows });
  }));
  r.put('/providers/:name', asyncHandler(async (req, res) => {
    const body = parseBody(ProviderConfig, req.body);
    if (!Object.keys(router.health()).includes(req.params.name)) throw badRequest('Provider is not configured on this server');
    const { rows } = await db.query(
      `INSERT INTO fixera_provider_config (provider, enabled, priority, model, timeout_ms, updated_by, updated_at)
       VALUES ($1, coalesce($2, true), coalesce($3, 100), $4, $5, $6, now())
       ON CONFLICT (provider) DO UPDATE SET enabled = coalesce($2, fixera_provider_config.enabled), priority = coalesce($3, fixera_provider_config.priority),
         model = $4, timeout_ms = $5, updated_by = $6, updated_at = now()
       RETURNING *`,
      [req.params.name, body.enabled ?? null, body.priority ?? null, body.model ?? null, body.timeout_ms ?? null, req.user.id],
    );
    await audit(req.user.id, 'provider.update', req.params.name, body);
    res.json(rows[0]);
  }));

  // Knowledge Base ingestion and review.
  r.post('/knowledge', asyncHandler(async (req, res) => {
    const body = parseBody(KnowledgeDoc, req.body);
    const doc = await knowledge.ingest({
      title: body.title, sourceType: body.source_type, sourceRef: body.source_ref, category: body.category, equipmentType: body.equipment_type,
      brand: body.brand, modelPattern: body.model_pattern, text: body.text, createdBy: req.user.id,
    });
    await audit(req.user.id, 'knowledge.ingest', doc.id, { title: body.title });
    res.status(201).json(doc);
  }));
  r.get('/knowledge', asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT d.*, (SELECT count(*)::int FROM knowledge_chunks k WHERE k.document_id = d.id) AS chunk_count
         FROM knowledge_documents d ORDER BY created_at DESC LIMIT 200`,
    );
    res.json({ documents: rows });
  }));
  r.post('/knowledge/:id/review', asyncHandler(async (req, res) => {
    const { state } = parseBody(z.object({ state: z.enum(['approved', 'retired', 'draft']) }), req.body);
    if (!isUuid(req.params.id)) throw notFound();
    const doc = await knowledge.setReviewState(req.params.id, state, req.user.id);
    if (!doc) throw notFound();
    await audit(req.user.id, `knowledge.${state}`, doc.id);
    res.json(doc);
  }));

  // Pricing rules used by the deterministic pricing service.
  r.get('/pricing-rules', asyncHandler(async (req, res) => {
    res.json({ rules: (await db.query('SELECT * FROM pricing_rules ORDER BY category, issue_key, zip_prefix NULLS FIRST')).rows });
  }));
  r.post('/pricing-rules', asyncHandler(async (req, res) => {
    const b = parseBody(PricingRule, req.body);
    const { rows } = await db.query(
      `INSERT INTO pricing_rules (category, issue_key, description, zip_prefix, parts_min_cents, parts_max_cents, labor_min_cents, labor_max_cents, source, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.category, b.issue_key, b.description, b.zip_prefix ?? null, b.parts_min_cents ?? null, b.parts_max_cents ?? null, b.labor_min_cents ?? null, b.labor_max_cents ?? null, b.source, req.user.id],
    );
    await audit(req.user.id, 'pricing.create', rows[0].id, b);
    res.status(201).json(rows[0]);
  }));

  r.put('/settings/:key', asyncHandler(async (req, res) => {
    const allowed = ['dispatch_fee_default_cents', 'homecare_pro_plan', 'max_photos_per_case', 'max_photos_total_per_case'];
    if (!allowed.includes(req.params.key)) throw badRequest('Unknown setting');
    const value = req.body?.value;
    if (value === undefined) throw badRequest('value is required');
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = now()`,
      [req.params.key, JSON.stringify(value), req.user.id],
    );
    await audit(req.user.id, 'setting.update', req.params.key, { value });
    res.json({ key: req.params.key, value });
  }));

  r.get('/safety-policy', (req, res) => {
    res.json({
      policy_version: POLICY_VERSION,
      hazard_rules: HAZARD_RULES.map((h) => ({ id: h.id, level: h.level })),
      prohibited_actions: PROHIBITED_ACTIONS.map((p) => p.id),
    });
  });

  // Dispatch stand-in: FixBridge's real dispatch assigns verified contractors.
  r.post('/service-requests/:id/assign', asyncHandler(async (req, res) => {
    const { contractor_id } = parseBody(z.object({ contractor_id: z.string() }), req.body);
    if (!isUuid(req.params.id)) throw notFound();
    const { rows: u } = await db.query(`SELECT id FROM users WHERE id = $1 AND role = 'contractor'`, [contractor_id]);
    if (!u[0]) throw badRequest('Not a contractor');
    const { rows } = await db.query(
      `UPDATE service_requests SET assigned_contractor_id = $2, status = CASE WHEN status = 'pending_payment' THEN status ELSE 'assigned' END, updated_at = now()
        WHERE id = $1 RETURNING id, status, assigned_contractor_id`,
      [req.params.id, contractor_id],
    );
    if (!rows[0]) throw notFound();
    await audit(req.user.id, 'service_request.assign', req.params.id, { contractor_id });
    res.json(rows[0]);
  }));
  r.post('/service-requests/:id/complete', asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    res.status(201).json(await handoff.completeJob(req.params.id, req.user, parseBody(Completion, req.body)));
  }));

  // Review queue: diagnosis mismatches, corrections and safety concerns.
  r.get('/review-queue', asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT f.id, f.kind, f.comment, f.review_state, f.created_at, c.public_ref, c.category, c.id AS case_id,
              a.result->'possible_causes' AS ai_causes,
              (SELECT final_diagnosis FROM fixera_outcomes o WHERE o.case_id = c.id ORDER BY created_at DESC LIMIT 1) AS final_diagnosis
         FROM fixera_feedback f JOIN fixera_cases c ON c.id = f.case_id
         LEFT JOIN fixera_assessments a ON a.id = f.assessment_id
        WHERE f.review_state = 'open' AND f.kind <> 'homeowner_rating'
        ORDER BY f.created_at`,
    );
    res.json({ items: rows });
  }));

  r.post('/review-queue/:id', asyncHandler(async (req, res) => {
    const body = parseBody(Review, req.body);
    if (!isUuid(req.params.id)) throw notFound();
    const { rows } = await db.query('SELECT f.*, c.category, c.equipment_id FROM fixera_feedback f JOIN fixera_cases c ON c.id = f.case_id WHERE f.id = $1', [req.params.id]);
    const item = rows[0];
    if (!item) throw notFound();
    let documentId = null;
    if (body.action === 'promote') {
      if (!body.generalized_summary) throw badRequest('generalized_summary is required to promote a case into the Knowledge Base');
      const { rows: eq } = item.equipment_id ? await db.query('SELECT equipment_type, brand FROM property_equipment WHERE id = $1', [item.equipment_id]) : { rows: [] };
      const summary = redactPII(body.generalized_summary);
      const doc = await knowledge.ingest({
        title: `Reviewed case: ${summary.slice(0, 80)}`,
        sourceType: 'reviewed_case',
        sourceRef: `review:${item.id}`,
        category: item.category,
        equipmentType: eq[0]?.equipment_type,
        brand: eq[0]?.brand,
        text: summary,
        createdBy: req.user.id,
        reviewState: 'approved',
      });
      documentId = doc.id;
    }
    const result = await db.tx(async (q) => {
      if (body.action === 'verify' || body.action === 'promote') {
        // Reviewed resolution: the contractor finding becomes the verified outcome.
        const { rows: o } = await q.query(`SELECT * FROM fixera_outcomes WHERE case_id = $1 AND source = 'contractor' ORDER BY created_at DESC LIMIT 1`, [item.case_id]);
        if (o[0]) {
          await q.query(
            `INSERT INTO fixera_outcomes (case_id, resolution, verification_status, source, reported_by, final_diagnosis, work_performed, parts_replaced, actual_cost_cents, ai_accuracy, notes)
             VALUES ($1,$2,'verified','admin',$3,$4,$5,$6::jsonb,$7,$8,$9)`,
            [item.case_id, o[0].resolution, req.user.id, o[0].final_diagnosis, o[0].work_performed, JSON.stringify(o[0].parts_replaced), o[0].actual_cost_cents, o[0].ai_accuracy, `Verified from review item ${item.id}`],
          );
        }
      }
      const state = body.action === 'dismiss' ? 'dismissed' : body.action === 'promote' ? 'promoted' : 'reviewed';
      await q.query('UPDATE fixera_feedback SET review_state = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1', [item.id, state, req.user.id]);
      await q.query('INSERT INTO fixera_audit_log (actor_id, action, target, details) VALUES ($1,$2,$3,$4::jsonb)', [req.user.id, `review.${body.action}`, item.id, JSON.stringify({ document_id: documentId })]);
      return { id: item.id, review_state: state, knowledge_document_id: documentId };
    });
    res.json(result);
  }));

  // Quality and cost reporting.
  r.get('/evaluation/summary', asyncHandler(async (req, res) => {
    const [runs, statuses, accuracy, feedback] = await Promise.all([
      db.query(
        `SELECT provider, model, status, count(*)::int AS n, avg(latency_ms)::int AS avg_latency_ms,
                sum(coalesce(cost_usd_micros, 0))::bigint AS cost_usd_micros, sum(coalesce(input_tokens,0))::bigint AS input_tokens, sum(coalesce(output_tokens,0))::bigint AS output_tokens
           FROM fixera_provider_runs WHERE created_at > now() - interval '30 days' GROUP BY provider, model, status ORDER BY provider, status`,
      ),
      db.query(`SELECT result_status, risk_level, count(*)::int AS n FROM fixera_assessments WHERE created_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1`),
      db.query(`SELECT ai_accuracy, verification_status, count(*)::int AS n FROM fixera_outcomes GROUP BY 1, 2`),
      db.query(`SELECT avg(rating)::float AS avg_rating, avg(CASE WHEN helpful THEN 1 ELSE 0 END)::float AS helpful_rate, count(*)::int AS n FROM fixera_feedback WHERE kind = 'homeowner_rating'`),
    ]);
    res.json({ provider_runs: runs.rows, assessments: statuses.rows, outcome_accuracy: accuracy.rows, homeowner_feedback: feedback.rows[0] });
  }));

  return r;
}
