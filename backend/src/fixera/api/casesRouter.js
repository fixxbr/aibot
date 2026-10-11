import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import * as z from 'zod/v4';
import { asyncHandler, badRequest, conflict, HttpError, notFound, parseBody, paymentRequired } from '../../middleware/errors.js';
import { assertCaseAccess, assertPropertyAccess, isUuid } from '../access.js';
import { addMessage, loadCaseView, newPublicRef } from '../cases/caseRepo.js';
import { STATUS, transition } from '../cases/caseStatus.js';
import { addHistory } from '../memory/passport.js';
import { ACCEPTED_TYPES, imageDimensions, qualityFlags, sniffImageType } from '../media/imageInspect.js';

const CreateCase = z.object({
  property_id: z.string(),
  category: z.string().min(1),
  description: z.string().trim().min(5).max(4000),
  equipment_id: z.string().nullable().optional(),
});
const Message = z.object({ content: z.string().trim().min(1).max(4000), media_ids: z.array(z.string()).max(6).optional() });
const StepResult = z.object({
  result: z.enum(['done', 'worked', 'not_worked', 'need_help', 'unexpected_condition', 'skipped']),
  note: z.string().max(2000).optional(),
  media_ids: z.array(z.string()).max(6).optional(),
});
const Feedback = z.object({ rating: z.number().int().min(1).max(5).optional(), helpful: z.boolean().optional(), comment: z.string().max(2000).optional() });
const Outcome = z.object({ resolution: z.enum(['resolved', 'unresolved']), note: z.string().max(2000).optional() });
const HirePro = z.object({
  preferred_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferred_window: z.enum(['morning', 'midday', 'afternoon', 'evening']),
  notes: z.string().max(2000).optional(),
});

const ASSESSED = [STATUS.MORE_INFORMATION_REQUIRED, STATUS.DIY_AVAILABLE, STATUS.PROFESSIONAL_REQUIRED, STATUS.EMERGENCY, STATUS.ANALYSIS_FAILED, STATUS.UNRESOLVED];

export function createCasesRouter({ db, platform, storage, orchestrator, handoff, config }) {
  const r = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.media.maxBytes, files: 6 },
  });

  // Paid AI actions are limited per user to control provider cost.
  const aiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.analysis.rateLimitPerHour,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many analysis requests. Please try again later.' } },
  });

  async function requireEntitlement(user) {
    const ent = await platform.getAnalysisEntitlement(user.id);
    if (!ent.eligible) throw paymentRequired('An active HomeCare Pro subscription is required for AI analysis');
    return ent;
  }

  async function startTurn(req, res, caseId, args) {
    const { done } = await orchestrator.start(caseId, { ...args, actorId: req.user.id });
    if (req.query.wait === 'true') {
      await done;
      const c = (await db.query('SELECT * FROM fixera_cases WHERE id = $1', [caseId])).rows[0];
      return res.status(200).json(await loadCaseView(db, c));
    }
    return res.status(202).json({ case_id: caseId, status: STATUS.ANALYZING, poll: `/api/fixera/cases/${caseId}/status` });
  }

  async function assertOwnMedia(caseId, ids) {
    if (!ids?.length) return [];
    if (!ids.every(isUuid)) throw badRequest('Invalid media id');
    const { rows } = await db.query('SELECT id FROM fixera_media WHERE case_id = $1 AND id = ANY($2::uuid[])', [caseId, ids]);
    if (rows.length !== new Set(ids).size) throw badRequest('Media does not belong to this case');
    return ids;
  }

  r.get('/categories', asyncHandler(async (req, res) => res.json({ categories: await platform.listServiceCategories() })));

  r.get('/entitlement', asyncHandler(async (req, res) => res.json(await platform.getAnalysisEntitlement(req.user.id))));

  r.get('/cases', asyncHandler(async (req, res) => {
    const params = [req.user.id];
    let filter = '';
    if (req.query.property_id) {
      await assertPropertyAccess(db, req.user, String(req.query.property_id));
      params.push(String(req.query.property_id));
      filter = 'AND c.property_id = $2';
    }
    const { rows } = await db.query(
      `SELECT c.id, c.public_ref AS ref, c.property_id, c.category, c.status, c.description, c.created_at, c.updated_at
         FROM fixera_cases c JOIN properties p ON p.id = c.property_id
         LEFT JOIN property_access pa ON pa.property_id = p.id AND pa.user_id = $1
        WHERE (p.owner_user_id = $1 OR pa.user_id IS NOT NULL) ${filter}
        ORDER BY c.updated_at DESC LIMIT 100`,
      params,
    );
    res.json({ cases: rows });
  }));

  r.post('/cases', asyncHandler(async (req, res) => {
    const body = parseBody(CreateCase, req.body);
    const property = await assertPropertyAccess(db, req.user, body.property_id, 'manage');
    if (!(await platform.getServiceCategory(body.category))) throw badRequest('Unknown service category');
    if (body.equipment_id) {
      const { rows } = await db.query('SELECT 1 FROM property_equipment WHERE id = $1 AND property_id = $2', [isUuid(body.equipment_id) ? body.equipment_id : null, property.id]);
      if (!rows.length) throw badRequest('Equipment does not belong to this property');
    }
    const { rows } = await db.query(
      `INSERT INTO fixera_cases (public_ref, property_id, customer_id, category, equipment_id, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,'DRAFT') RETURNING *`,
      [newPublicRef(), property.id, req.user.id, body.category, body.equipment_id || null, body.description],
    );
    res.status(201).json(await loadCaseView(db, rows[0]));
  }));

  r.get('/cases/:id', asyncHandler(async (req, res) => {
    const c = await assertCaseAccess(db, req.user, req.params.id);
    res.json(await loadCaseView(db, c));
  }));

  r.get('/cases/:id/status', asyncHandler(async (req, res) => {
    const c = await assertCaseAccess(db, req.user, req.params.id);
    res.json({ case_id: c.id, status: c.status, status_detail: c.status_detail, latest_assessment_id: c.latest_assessment_id, updated_at: c.updated_at, retryable: c.status === STATUS.ANALYSIS_FAILED });
  }));

  r.post('/cases/:id/media', upload.array('photos', 6), asyncHandler(async (req, res) => {
    const c = await assertCaseAccess(db, req.user, req.params.id, 'write');
    if ([STATUS.RESOLVED, STATUS.REFERRED].includes(c.status)) throw conflict('Photos cannot be added to a closed case');
    const files = req.files || [];
    if (!files.length) throw badRequest('Attach at least one photo in the "photos" field');
    const capture = req.body.capture_source === 'camera' ? 'camera' : 'upload';
    const intakeMax = Number(await platform.getSetting('max_photos_per_case', 6));
    const totalMax = Number(await platform.getSetting('max_photos_total_per_case', intakeMax * 2));
    const { rows: cnt } = await db.query('SELECT count(*)::int AS n FROM fixera_media WHERE case_id = $1', [c.id]);
    const limit = [STATUS.DRAFT, STATUS.UPLOADED].includes(c.status) ? intakeMax : totalMax;
    if (cnt[0].n + files.length > limit) throw new HttpError(413, 'too_many_photos', `A case can have up to ${limit} photos at this stage`);

    const inspected = files.map((f) => {
      const type = sniffImageType(f.buffer);
      if (type === 'image/heic') throw new HttpError(415, 'unsupported_media_type', 'HEIC photos are not supported yet. Please upload JPEG or PNG.');
      if (!type || !ACCEPTED_TYPES.includes(type)) throw new HttpError(415, 'unsupported_media_type', 'Only JPEG, PNG, WebP or GIF photos are accepted');
      const dims = imageDimensions(f.buffer, type);
      return { f, type, dims, flags: qualityFlags({ ...dims, byteSize: f.size }) };
    });

    const saved = [];
    let n = cnt[0].n;
    for (const it of inspected) {
      const id = randomUUID();
      const key = `fixera/${c.property_id}/${c.id}/${id}`;
      await storage.put(key, it.f.buffer, it.type);
      n += 1;
      const { rows } = await db.query(
        `INSERT INTO fixera_media (id, case_id, uploaded_by, storage_driver, storage_key, content_type, byte_size, width, height, sha256, capture_source, label, quality_flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         RETURNING id, label, content_type, byte_size, width, height, capture_source, quality_flags, created_at`,
        [id, c.id, req.user.id, storage.driver, key, it.type, it.f.size, it.dims.width, it.dims.height,
          createHash('sha256').update(it.f.buffer).digest('hex'), capture, `photo_${n}`, JSON.stringify(it.flags)],
      );
      saved.push({ ...rows[0], url: `/api/fixera/cases/${c.id}/media/${id}` });
    }
    if (c.status === STATUS.DRAFT) await db.tx((q) => transition(q, c.id, STATUS.UPLOADED, { actorId: req.user.id, reason: 'media' }));
    res.status(201).json({ media: saved });
  }));

  r.get('/cases/:id/media/:mediaId', asyncHandler(async (req, res) => {
    const c = await assertCaseAccess(db, req.user, req.params.id);
    if (!isUuid(req.params.mediaId)) throw notFound();
    const { rows } = await db.query('SELECT storage_key, content_type FROM fixera_media WHERE id = $1 AND case_id = $2', [req.params.mediaId, c.id]);
    if (!rows[0]) throw notFound();
    const buf = await storage.get(rows[0].storage_key);
    res.set({ 'content-type': rows[0].content_type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
    res.send(buf);
  }));

  r.post('/cases/:id/analyze', aiLimiter, asyncHandler(async (req, res) => {
    const c = await assertCaseAccess(db, req.user, req.params.id, 'write');
    await requireEntitlement(req.user);
    if (![STATUS.DRAFT, STATUS.UPLOADED, STATUS.ANALYSIS_FAILED, ...ASSESSED].includes(c.status)) throw conflict(`Case is ${c.status}`);
    await startTurn(req, res, c.id, {
      trigger: c.latest_assessment_id ? 'rerun' : 'initial',
      turnNote: c.latest_assessment_id ? 'The homeowner asked for the assessment to be run again with everything on file.' : 'Initial assessment of a new case.',
    });
  }));

  r.post('/cases/:id/messages', aiLimiter, asyncHandler(async (req, res) => {
    const body = parseBody(Message, req.body);
    const c = await assertCaseAccess(db, req.user, req.params.id, 'write');
    await requireEntitlement(req.user);
    if (!ASSESSED.includes(c.status)) throw conflict(c.status === STATUS.ANALYZING ? 'Fixera is still working on your last message' : `Case is ${c.status}`);
    const mediaIds = await assertOwnMedia(c.id, body.media_ids);
    await addMessage(db, c.id, { role: 'homeowner', kind: mediaIds.length ? 'photo_added' : 'text', content: body.content, mediaIds, authorId: req.user.id });
    await startTurn(req, res, c.id, {
      trigger: mediaIds.length ? 'photo' : 'message',
      turnNote: mediaIds.length ? 'The homeowner sent a message with new photos. Review all photos together with the earlier evidence.' : 'The homeowner sent a new message. Continue the conversation from where it is.',
    });
  }));

  r.post('/cases/:id/steps/:stepId/result', asyncHandler(async (req, res) => {
    const body = parseBody(StepResult, req.body);
    const c = await assertCaseAccess(db, req.user, req.params.id, 'write');
    if (!isUuid(req.params.stepId)) throw notFound('Step not found');
    const { rows } = await db.query(`SELECT * FROM fixera_steps WHERE id = $1 AND case_id = $2 AND status <> 'superseded'`, [req.params.stepId, c.id]);
    const step = rows[0];
    if (!step) throw notFound('Step not found');
    const mediaIds = await assertOwnMedia(c.id, body.media_ids);
    const needsAi = ['not_worked', 'need_help', 'unexpected_condition'].includes(body.result) || mediaIds.length > 0;
    if (needsAi) {
      await requireEntitlement(req.user);
      if (!ASSESSED.includes(c.status)) throw conflict(`Case is ${c.status}`);
    }
    await db.query('UPDATE fixera_steps SET status = $2, result_note = $3, completed_at = now() WHERE id = $1', [step.id, body.result, body.note || null]);
    const label = { done: 'Done', worked: 'That worked', not_worked: 'That did not work', need_help: 'I need help with this step', unexpected_condition: 'I found something unexpected', skipped: 'Skipped' }[body.result];
    await addMessage(db, c.id, {
      role: 'homeowner',
      kind: 'step_result',
      content: `Step ${step.seq} "${step.title}": ${label}.${body.note ? ` ${body.note}` : ''}`,
      mediaIds,
      authorId: req.user.id,
    });
    if (needsAi) {
      return startTurn(req, res, c.id, {
        trigger: 'step_result',
        turnNote: `The homeowner reported "${label}" on step ${step.seq} ("${step.title}"). Explain, reassess or adjust the plan from this point. If they found something unexpected, reassess safety before continuing.`,
      });
    }
    const { rows: remaining } = await db.query(`SELECT count(*)::int AS n FROM fixera_steps WHERE case_id = $1 AND status = 'pending'`, [c.id]);
    res.json({ step_id: step.id, status: body.result, remaining_steps: remaining[0].n, next: remaining[0].n ? 'next_step' : 'confirm_outcome' });
  }));

  r.post('/cases/:id/feedback', asyncHandler(async (req, res) => {
    const body = parseBody(Feedback, req.body);
    const c = await assertCaseAccess(db, req.user, req.params.id, 'write');
    const { rows } = await db.query(
      `INSERT INTO fixera_feedback (case_id, assessment_id, kind, rating, helpful, comment, author_id)
       VALUES ($1,$2,'homeowner_rating',$3,$4,$5,$6) RETURNING id, created_at`,
      [c.id, c.latest_assessment_id, body.rating ?? null, body.helpful ?? null, body.comment || null, req.user.id],
    );
    res.status(201).json(rows[0]);
  }));

  // Homeowner's claim about the outcome. Stored as homeowner_reported, never as verified.
  r.post('/cases/:id/outcome', asyncHandler(async (req, res) => {
    const body = parseBody(Outcome, req.body);
    const c = await assertCaseAccess(db, req.user, req.params.id, 'write');
    if (c.status === STATUS.REFERRED) throw conflict('This case is with a professional; the outcome is recorded when the job is completed');
    const steps = (await db.query(`SELECT title, status FROM fixera_steps WHERE case_id = $1 AND status <> 'superseded' ORDER BY seq`, [c.id])).rows;
    const assessment = c.latest_assessment_id ? (await db.query('SELECT result FROM fixera_assessments WHERE id = $1', [c.latest_assessment_id])).rows[0]?.result : null;
    const result = await db.tx(async (q) => {
      const { rows } = await q.query(
        `INSERT INTO fixera_outcomes (case_id, resolution, verification_status, source, reported_by, notes, ai_accuracy)
         VALUES ($1,$2,'homeowner_reported','homeowner',$3,$4,'not_assessed') RETURNING *`,
        [c.id, body.resolution, req.user.id, body.note || null],
      );
      await addHistory(q, {
        propertyId: c.property_id,
        equipmentId: c.equipment_id,
        category: c.category,
        eventType: 'diy_outcome',
        summary: `${assessment?.problem_summary || c.description.slice(0, 120)}: homeowner reports ${body.resolution === 'resolved' ? 'resolved' : 'not resolved'} after Fixera DIY guidance`,
        details: { steps: steps.map((s) => ({ title: s.title, status: s.status })), likely_causes: (assessment?.possible_causes || []).map((x) => x.name), note: body.note || null },
        verificationStatus: 'homeowner_reported',
        caseId: c.id,
      });
      await transition(q, c.id, body.resolution === 'resolved' ? STATUS.RESOLVED : STATUS.UNRESOLVED, { actorId: req.user.id, reason: 'homeowner_outcome' });
      await addMessage(q, c.id, { role: 'homeowner', kind: 'outcome', content: body.resolution === 'resolved' ? 'The problem is resolved.' : 'The problem is still not resolved.', authorId: req.user.id });
      return rows[0];
    });
    res.status(201).json({ outcome: result, next: body.resolution === 'resolved' ? 'done' : 'offer_professional' });
  }));

  // Works with or without an AI assessment: a DRAFT case is simply a direct booking.
  r.post('/cases/:id/hire-pro', asyncHandler(async (req, res) => {
    const body = parseBody(HirePro, req.body);
    const c = await assertCaseAccess(db, req.user, req.params.id, 'write');
    if (c.status === STATUS.ANALYZING) throw conflict('Please wait for the current analysis to finish');
    const sr = await handoff.hirePro(c, req.user, { preferredDate: body.preferred_date, preferredWindow: body.preferred_window, notes: body.notes });
    res.status(201).json({ service_request: sr });
  }));

  return r;
}
