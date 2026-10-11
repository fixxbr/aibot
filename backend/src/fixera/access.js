// Server-side authorization for every property and case read/write.
// A property_id coming from the client is only a lookup key, never proof of access.

import { forbidden, notFound } from '../middleware/errors.js';

/**
 * Returns the property if `user` may access it at `level` ('read' | 'manage').
 * Throws 404 when the property does not exist or the user has no relationship to it,
 * so callers cannot probe for other customers' property IDs.
 */
export async function assertPropertyAccess(db, user, propertyId, level = 'read') {
  if (!isUuid(propertyId)) throw notFound('Property not found');
  const { rows } = await db.query(
    `SELECT p.*, pa.access_level
       FROM properties p
       LEFT JOIN property_access pa ON pa.property_id = p.id AND pa.user_id = $2
      WHERE p.id = $1`,
    [propertyId, user.id],
  );
  const property = rows[0];
  if (!property) throw notFound('Property not found');
  const isOwner = property.owner_user_id === user.id;
  const delegated = property.access_level;
  if (!isOwner && !delegated) throw notFound('Property not found');
  if (level === 'manage' && !isOwner && delegated !== 'manage') throw forbidden('You have read-only access to this property');
  return property;
}

/**
 * Loads a case the user may act on. Homeowners: via property access. Admins: read-only
 * support access. Contractors: only cases attached to a service request assigned to them.
 */
export async function assertCaseAccess(db, user, caseId, level = 'read') {
  if (!isUuid(caseId)) throw notFound('Case not found');
  const { rows } = await db.query('SELECT * FROM fixera_cases WHERE id = $1', [caseId]);
  const c = rows[0];
  if (!c) throw notFound('Case not found');
  if (user.role === 'admin') {
    if (level !== 'read') throw forbidden('Admins have read-only access to homeowner cases');
    return c;
  }
  if (user.role === 'contractor') {
    const { rows: sr } = await db.query(
      'SELECT 1 FROM service_requests WHERE fixera_case_id = $1 AND assigned_contractor_id = $2',
      [caseId, user.id],
    );
    if (!sr.length || level !== 'read') throw notFound('Case not found');
    return c;
  }
  await assertPropertyAccess(db, user, c.property_id, level === 'read' ? 'read' : 'manage');
  return c;
}

export function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
