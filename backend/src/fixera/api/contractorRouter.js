import express from 'express';
import * as z from 'zod/v4';
import { asyncHandler, notFound, parseBody } from '../../middleware/errors.js';
import { isUuid } from '../access.js';

export const Completion = z.object({
  final_diagnosis: z.string().trim().min(3).max(2000),
  work_performed: z.string().trim().min(3).max(4000),
  parts_replaced: z.array(z.object({ name: z.string().max(200), part_number: z.string().max(120).optional(), quantity: z.number().int().positive().optional() })).max(50).default([]),
  invoice_cents: z.number().int().nonnegative().optional(),
  resolved: z.boolean(),
  ai_accuracy: z.enum(['correct', 'partially_correct', 'incorrect', 'not_assessed']).default('not_assessed'),
  recommendations: z.string().max(2000).optional(),
  equipment_id: z.string().optional(),
  equipment_update: z.object({ brand: z.string().optional(), model_number: z.string().optional(), serial_number: z.string().optional(), installed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional(),
  maintenance_reminders: z.array(z.object({ title: z.string().max(200), due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), recurrence_days: z.number().int().positive().optional() })).max(10).optional(),
});

export function createContractorRouter({ db, handoff }) {
  const r = express.Router();

  r.get('/jobs', asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, category, status, preferred_date, preferred_window, created_at, fixera_case_id
         FROM service_requests WHERE assigned_contractor_id = $1 ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ jobs: rows });
  }));

  r.get('/jobs/:id', asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Job not found');
    const { rows } = await db.query('SELECT * FROM service_requests WHERE id = $1 AND assigned_contractor_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) throw notFound('Job not found');
    const sr = rows[0];
    res.json({
      id: sr.id,
      status: sr.status,
      category: sr.category,
      description: sr.description,
      preferred_date: sr.preferred_date,
      preferred_window: sr.preferred_window,
      handoff: sr.handoff,
      contractor_quote_cents: sr.contractor_quote_cents,
    });
  }));

  r.post('/jobs/:id/complete', asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Job not found');
    const body = parseBody(Completion, req.body);
    if (body.equipment_id && !isUuid(body.equipment_id)) body.equipment_id = undefined;
    res.status(201).json(await handoff.completeJob(req.params.id, req.user, body));
  }));

  return r;
}
