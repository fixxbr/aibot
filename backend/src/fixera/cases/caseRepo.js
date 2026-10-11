import { randomBytes } from 'node:crypto';

export const newPublicRef = () => `FX-${randomBytes(5).toString('hex').toUpperCase()}`;

export async function addMessage(q, caseId, { role, kind = 'text', content, mediaIds = [], assessmentId = null, authorId = null }) {
  // Sequence numbers are allocated inside the insert; the UNIQUE(case_id, seq) constraint
  // rejects a concurrent duplicate, which we retry once.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rows } = await q.query(
        `INSERT INTO fixera_messages (case_id, seq, role, kind, content, media_ids, assessment_id, author_id)
         VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM fixera_messages WHERE case_id = $1), $2, $3, $4, $5::jsonb, $6, $7)
         RETURNING id, seq, role, kind, content, media_ids, assessment_id, created_at`,
        [caseId, role, kind, content, JSON.stringify(mediaIds), assessmentId, authorId],
      );
      return rows[0];
    } catch (err) {
      if (err.code !== '23505' || attempt === 2) throw err;
    }
  }
}

export async function activeSteps(db, caseId) {
  const { rows } = await db.query(
    `SELECT id, assessment_id, seq, action_type, title, instruction, caution, stop_condition, verification, status, result_note, completed_at
       FROM fixera_steps WHERE case_id = $1 AND status <> 'superseded'
      ORDER BY seq`,
    [caseId],
  );
  return rows;
}

export async function latestAssessment(db, caseId) {
  const { rows } = await db.query(
    `SELECT a.* FROM fixera_assessments a JOIN fixera_cases c ON c.latest_assessment_id = a.id WHERE c.id = $1`,
    [caseId],
  );
  return rows[0] || null;
}

export async function listMedia(db, caseId) {
  const { rows } = await db.query(
    `SELECT id, label, content_type, byte_size, width, height, capture_source, quality_flags, created_at, storage_key
       FROM fixera_media WHERE case_id = $1 ORDER BY created_at, label`,
    [caseId],
  );
  return rows;
}

const mediaView = (caseId) => (m) => ({
  id: m.id,
  label: m.label,
  content_type: m.content_type,
  byte_size: m.byte_size,
  width: m.width,
  height: m.height,
  capture_source: m.capture_source,
  quality_flags: m.quality_flags,
  created_at: m.created_at,
  // Authorized download route; there is no public URL.
  url: `/api/fixera/cases/${caseId}/media/${m.id}`,
});

/** Everything the frontend needs to restore a case after the browser was closed. */
export async function loadCaseView(db, c) {
  const [media, messages, assessment, steps, outcomes, sr] = await Promise.all([
    listMedia(db, c.id),
    db.query('SELECT id, seq, role, kind, content, media_ids, assessment_id, created_at FROM fixera_messages WHERE case_id = $1 ORDER BY seq', [c.id]),
    latestAssessment(db, c.id),
    activeSteps(db, c.id),
    db.query('SELECT id, resolution, verification_status, source, final_diagnosis, work_performed, actual_cost_cents, created_at FROM fixera_outcomes WHERE case_id = $1 ORDER BY created_at', [c.id]),
    c.service_request_id ? db.query('SELECT id, status, preferred_date, preferred_window, dispatch_fee_cents, contractor_quote_cents, approved_amount_cents FROM service_requests WHERE id = $1', [c.service_request_id]) : { rows: [] },
  ]);
  return {
    case: {
      id: c.id,
      ref: c.public_ref,
      property_id: c.property_id,
      category: c.category,
      equipment_id: c.equipment_id,
      description: c.description,
      status: c.status,
      status_detail: c.status_detail,
      created_at: c.created_at,
      updated_at: c.updated_at,
    },
    media: media.map(mediaView(c.id)),
    messages: messages.rows,
    assessment: assessment ? assessmentView(assessment) : null,
    steps,
    outcomes: outcomes.rows,
    service_request: sr.rows[0] || null,
  };
}

export function assessmentView(a) {
  return { id: a.id, version: a.version, status: a.result_status, created_at: a.created_at, ...a.result };
}
