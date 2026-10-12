// Keeps Fixera's copy of FixBridge users, properties and subscriptions current when Fixera
// runs on its own database. Call these from the existing FixBridge backend wherever a user
// signs up, a property is added or edited, or a HomeCare Pro subscription changes.
//
//   await fixera.sync.upsertUser({ id: user.id, role: 'homeowner', email: user.email });
//   const { id } = await fixera.sync.upsertProperty({ externalRef: property.id, ownerUserId: user.id, zip: property.zip, ... });
//   await fixera.sync.setSubscription({ userId: user.id, status: 'active', currentPeriodEnd });

const ROLES = ['homeowner', 'contractor', 'admin'];

export function createSync({ db }) {
  async function upsertUser({ id, role = 'homeowner', email = null, displayName = null }) {
    if (id == null) throw new Error('upsertUser: id is required');
    if (!ROLES.includes(role)) throw new Error(`upsertUser: role must be one of ${ROLES.join(', ')}`);
    await db.query(
      `INSERT INTO users (id, role, email, display_name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = coalesce(EXCLUDED.email, users.email), display_name = coalesce(EXCLUDED.display_name, users.display_name)`,
      [String(id), role, email, displayName],
    );
    return { id: String(id) };
  }

  /** Returns Fixera's property id (UUID) for the site's property `externalRef`. */
  async function upsertProperty({ externalRef, ownerUserId, zip, nickname = null, addressLine1 = null, city = null, state = null, propertyType = null, yearBuilt = null }) {
    if (externalRef == null || ownerUserId == null || !zip) throw new Error('upsertProperty: externalRef, ownerUserId and zip are required');
    await upsertUser({ id: ownerUserId });
    const { rows } = await db.query(
      `INSERT INTO properties (external_ref, owner_user_id, zip, nickname, address_line1, city, state, property_type, year_built)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
         owner_user_id = EXCLUDED.owner_user_id, zip = EXCLUDED.zip, nickname = EXCLUDED.nickname, address_line1 = EXCLUDED.address_line1,
         city = EXCLUDED.city, state = EXCLUDED.state, property_type = EXCLUDED.property_type, year_built = EXCLUDED.year_built
       RETURNING id`,
      [String(externalRef), String(ownerUserId), String(zip), nickname, addressLine1, city, state, propertyType, yearBuilt],
    );
    return { id: rows[0].id };
  }

  async function propertyIdFor(externalRef) {
    const { rows } = await db.query('SELECT id FROM properties WHERE external_ref = $1', [String(externalRef)]);
    return rows[0]?.id || null;
  }

  async function grantPropertyAccess({ externalRef, userId, accessLevel = 'read' }) {
    const propertyId = await propertyIdFor(externalRef);
    if (!propertyId) throw new Error('grantPropertyAccess: unknown property');
    await upsertUser({ id: userId });
    await db.query(
      `INSERT INTO property_access (property_id, user_id, access_level) VALUES ($1,$2,$3)
       ON CONFLICT (property_id, user_id) DO UPDATE SET access_level = EXCLUDED.access_level`,
      [propertyId, String(userId), accessLevel],
    );
  }

  /** Mirrors the HomeCare Pro status from Stripe/FixBridge. status: active | trialing | past_due | canceled */
  async function setSubscription({ userId, status, plan = 'homecare_pro', currentPeriodEnd = null }) {
    await upsertUser({ id: userId });
    await db.tx(async (q) => {
      await q.query('DELETE FROM subscriptions WHERE user_id = $1 AND plan = $2', [String(userId), plan]);
      await q.query('INSERT INTO subscriptions (user_id, plan, status, current_period_end) VALUES ($1,$2,$3,$4)', [String(userId), plan, status, currentPeriodEnd]);
    });
  }

  return { upsertUser, upsertProperty, propertyIdFor, grantPropertyAccess, setSubscription };
}
