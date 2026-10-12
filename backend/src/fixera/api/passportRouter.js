import express from 'express';
import * as z from 'zod/v4';
import { asyncHandler, notFound, parseBody } from '../../middleware/errors.js';
import { assertPropertyAccess, isUuid } from '../access.js';
import { equipmentAgeYears, loadPassport } from '../memory/passport.js';

const Equipment = z.object({
  category: z.string().min(1),
  equipment_type: z.string().min(1).max(120),
  brand: z.string().max(120).nullable().optional(),
  model_number: z.string().max(120).nullable().optional(),
  serial_number: z.string().max(120).nullable().optional(),
  installed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export function createPassportRouter({ db }) {
  const r = express.Router();

  r.get('/properties', asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.id, p.external_ref, p.nickname, p.address_line1, p.city, p.state, p.zip, p.property_type, p.year_built,
              CASE WHEN p.owner_user_id = $1 THEN 'owner' ELSE pa.access_level END AS access
         FROM properties p LEFT JOIN property_access pa ON pa.property_id = p.id AND pa.user_id = $1
        WHERE p.owner_user_id = $1 OR pa.user_id IS NOT NULL ORDER BY p.created_at`,
      [req.user.id],
    );
    res.json({ properties: rows });
  }));

  r.get('/properties/:id/passport', asyncHandler(async (req, res) => {
    const property = await assertPropertyAccess(db, req.user, req.params.id);
    const passport = await loadPassport(db, property.id);
    const { rows: reminders } = await db.query('SELECT id, equipment_id, title, due_on, recurrence_days FROM property_reminders WHERE property_id = $1 ORDER BY due_on', [property.id]);
    res.json({
      property: { id: property.id, nickname: property.nickname, address_line1: property.address_line1, city: property.city, state: property.state, zip: property.zip, property_type: property.property_type, year_built: property.year_built },
      equipment: passport.equipment.map((e) => ({ ...e, age_years: equipmentAgeYears(e.installed_on) })),
      history: passport.history,
      cases: passport.priorCases,
      reminders,
    });
  }));

  r.post('/properties/:id/equipment', asyncHandler(async (req, res) => {
    const body = parseBody(Equipment, req.body);
    const property = await assertPropertyAccess(db, req.user, req.params.id, 'manage');
    const { rows } = await db.query(
      `INSERT INTO property_equipment (property_id, category, equipment_type, brand, model_number, serial_number, installed_on, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [property.id, body.category, body.equipment_type, body.brand ?? null, body.model_number ?? null, body.serial_number ?? null, body.installed_on ?? null, body.location ?? null, body.notes ?? null],
    );
    res.status(201).json(rows[0]);
  }));

  r.patch('/properties/:id/equipment/:equipmentId', asyncHandler(async (req, res) => {
    const body = parseBody(Equipment.partial(), req.body);
    const property = await assertPropertyAccess(db, req.user, req.params.id, 'manage');
    if (!isUuid(req.params.equipmentId)) throw notFound('Equipment not found');
    const fields = Object.keys(body);
    if (!fields.length) return res.json({ updated: false });
    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const { rows } = await db.query(
      `UPDATE property_equipment SET ${sets}, updated_at = now() WHERE id = $1 AND property_id = $2 RETURNING *`,
      [req.params.equipmentId, property.id, ...fields.map((f) => body[f])],
    );
    if (!rows[0]) throw notFound('Equipment not found');
    res.json(rows[0]);
  }));

  return r;
}
