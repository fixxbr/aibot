// Property Passport: per-property long-term memory. Every function takes an already
// authorized property ID; callers must run assertPropertyAccess first.

export async function loadPassport(db, propertyId, { category, excludeCaseId } = {}) {
  const [property, equipment, history, priorCases] = await Promise.all([
    db.query('SELECT id, zip, property_type, year_built, state FROM properties WHERE id = $1', [propertyId]),
    db.query(
      `SELECT id, category, equipment_type, brand, model_number, installed_on, location, notes
         FROM property_equipment WHERE property_id = $1 ORDER BY category = $2 DESC, created_at`,
      [propertyId, category || ''],
    ),
    db.query(
      `SELECT id, equipment_id, category, event_type, summary, verification_status, cost_cents, occurred_on
         FROM property_service_history WHERE property_id = $1
        ORDER BY (category = $2) DESC, occurred_on DESC LIMIT 25`,
      [propertyId, category || ''],
    ),
    db.query(
      `SELECT c.id, c.public_ref, c.category, c.equipment_id, c.status, c.created_at,
              a.result->>'problem_summary' AS problem_summary,
              o.resolution, o.verification_status, o.final_diagnosis
         FROM fixera_cases c
         LEFT JOIN fixera_assessments a ON a.id = c.latest_assessment_id
         LEFT JOIN LATERAL (SELECT * FROM fixera_outcomes WHERE case_id = c.id ORDER BY created_at DESC LIMIT 1) o ON true
        WHERE c.property_id = $1 AND c.id <> $2::uuid
        ORDER BY (c.category = $3) DESC, c.created_at DESC LIMIT 10`,
      [propertyId, excludeCaseId || '00000000-0000-0000-0000-000000000000', category || ''],
    ),
  ]);
  return { property: property.rows[0], equipment: equipment.rows, history: history.rows, priorCases: priorCases.rows };
}

export function equipmentAgeYears(installedOn, today = new Date()) {
  if (!installedOn) return null;
  const d = new Date(installedOn);
  return Math.max(0, Math.floor((today - d) / (365.25 * 24 * 3600 * 1000)));
}

export async function addHistory(q, entry) {
  const { rows } = await q.query(
    `INSERT INTO property_service_history
       (property_id, equipment_id, category, event_type, summary, details, verification_status, cost_cents, source_case_id, source_service_request_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING id`,
    [entry.propertyId, entry.equipmentId || null, entry.category || null, entry.eventType, entry.summary, JSON.stringify(entry.details || {}),
      entry.verificationStatus, entry.costCents ?? null, entry.caseId || null, entry.serviceRequestId || null],
  );
  return rows[0].id;
}
