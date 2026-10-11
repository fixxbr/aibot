// Case state machine. Transitions are applied with a conditional UPDATE so two concurrent
// requests cannot both start an analysis.

import { conflict } from '../../middleware/errors.js';

export const STATUS = {
  DRAFT: 'DRAFT',
  UPLOADED: 'UPLOADED',
  ANALYZING: 'ANALYZING',
  MORE_INFORMATION_REQUIRED: 'MORE_INFORMATION_REQUIRED',
  DIY_AVAILABLE: 'DIY_AVAILABLE',
  PROFESSIONAL_REQUIRED: 'PROFESSIONAL_REQUIRED',
  EMERGENCY: 'EMERGENCY',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  RESOLVED: 'RESOLVED',
  UNRESOLVED: 'UNRESOLVED',
  REFERRED: 'REFERRED',
};

const ASSESSED = ['MORE_INFORMATION_REQUIRED', 'DIY_AVAILABLE', 'PROFESSIONAL_REQUIRED', 'EMERGENCY', 'ANALYSIS_FAILED'];

export const TRANSITIONS = {
  DRAFT: ['UPLOADED', 'ANALYZING', 'REFERRED'],
  UPLOADED: ['ANALYZING', 'REFERRED'],
  ANALYZING: ASSESSED,
  MORE_INFORMATION_REQUIRED: ['ANALYZING', 'RESOLVED', 'UNRESOLVED', 'REFERRED'],
  DIY_AVAILABLE: ['ANALYZING', 'RESOLVED', 'UNRESOLVED', 'REFERRED'],
  PROFESSIONAL_REQUIRED: ['ANALYZING', 'RESOLVED', 'UNRESOLVED', 'REFERRED'],
  EMERGENCY: ['ANALYZING', 'RESOLVED', 'UNRESOLVED', 'REFERRED'],
  ANALYSIS_FAILED: ['ANALYZING', 'RESOLVED', 'UNRESOLVED', 'REFERRED'],
  UNRESOLVED: ['ANALYZING', 'RESOLVED', 'REFERRED'],
  REFERRED: ['RESOLVED', 'UNRESOLVED'],
  RESOLVED: [],
};

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
export const sourcesFor = (to) => Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].includes(to));

export async function transition(q, caseId, to, { actorId, reason, detail = null, extraSet = '', extraParams = [] } = {}) {
  const from = sourcesFor(to);
  const { rows } = await q.query(
    `WITH prev AS (SELECT status FROM fixera_cases WHERE id = $1)
     UPDATE fixera_cases SET status = $2, status_detail = $3, version = version + 1, updated_at = now() ${extraSet}
      WHERE id = $1 AND status = ANY($4::text[])
      RETURNING id, status, (SELECT status FROM prev) AS from_status`,
    [caseId, to, detail, from, ...extraParams],
  );
  if (!rows[0]) {
    const cur = await q.query('SELECT status FROM fixera_cases WHERE id = $1', [caseId]);
    throw conflict(`Case cannot move from ${cur.rows[0]?.status} to ${to}`, { status: cur.rows[0]?.status });
  }
  await q.query('INSERT INTO fixera_case_events (case_id, from_status, to_status, actor_id, reason) VALUES ($1,$2,$3,$4,$5)', [caseId, rows[0].from_status, to, actorId || null, reason || null]);
  return rows[0];
}
