// Seeds a local demo: users, properties, equipment history, a HomeCare Pro subscription,
// pricing rules and a few starter knowledge documents. Prints dev tokens for local API testing.
//
// Pricing rows and knowledge text below are illustrative starter content for local
// development. Replace them with reviewed FixBridge data before production use.

import jwt from 'jsonwebtoken';
import { createKnowledgeBase } from '../fixera/knowledge/knowledgeBase.js';
import { createEmbedder } from '../fixera/knowledge/embeddings.js';

/** Idempotent. Returns dev tokens for the demo users. */
export async function seedDemo(db, config) {
  if (config.isProduction) throw new Error('Refusing to seed demo data in production');

  await db.query(`INSERT INTO users (id, email, display_name, role) VALUES
    ('demo_homeowner', 'homeowner@example.com', 'Demo Homeowner', 'homeowner'),
    ('demo_contractor', 'pro@example.com', 'Demo Contractor', 'contractor'),
    ('demo_admin', 'admin@example.com', 'Demo Admin', 'admin')
    ON CONFLICT (id) DO NOTHING`);
  const { rows: subs } = await db.query(`SELECT 1 FROM subscriptions WHERE user_id = 'demo_homeowner'`);
  if (!subs.length) await db.query(`INSERT INTO subscriptions (user_id, plan, status) VALUES ('demo_homeowner', 'homecare_pro', 'active')`);

  const { rows: existing } = await db.query(`SELECT id FROM properties WHERE owner_user_id = 'demo_homeowner'`);
  if (!existing.length) {
    const home = (await db.query(`INSERT INTO properties (owner_user_id, nickname, address_line1, city, state, zip, property_type, year_built)
      VALUES ('demo_homeowner', 'Main house', '100 Demo Ave', 'Miami', 'FL', '33101', 'single_family', 2004) RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO properties (owner_user_id, nickname, address_line1, city, state, zip, property_type, year_built)
      VALUES ('demo_homeowner', 'Rental condo', '200 Sample St', 'Atlanta', 'GA', '30301', 'condo', 2012)`);
    const hvac = (await db.query(`INSERT INTO property_equipment (property_id, category, equipment_type, brand, installed_on, location)
      VALUES ($1, 'hvac', 'Central HVAC', 'Carrier', (CURRENT_DATE - interval '9 years')::date, 'Garage air handler') RETURNING id`, [home])).rows[0].id;
    await db.query(`INSERT INTO property_equipment (property_id, category, equipment_type, brand, installed_on, location)
      VALUES ($1, 'plumbing', 'Water heater', 'Rheem', (CURRENT_DATE - interval '6 years')::date, 'Garage')`, [home]);
    await db.query(`INSERT INTO property_service_history (property_id, equipment_id, category, event_type, summary, verification_status, occurred_on)
      VALUES ($1, $2, 'hvac', 'repair', 'Restricted airflow; clogged return air filter replaced', 'contractor_recorded', (CURRENT_DATE - interval '8 months')::date)`, [home, hvac]);
  }

  const { rows: pr } = await db.query('SELECT 1 FROM pricing_rules LIMIT 1');
  if (!pr.length) {
    await db.query(`INSERT INTO pricing_rules (category, issue_key, description, zip_prefix, parts_min_cents, parts_max_cents, labor_min_cents, labor_max_cents, source) VALUES
      ('plumbing', 'plumbing.p_trap_leak', 'Leaking P-trap or slip joint under a sink', NULL, 500, 2500, 12000, 25000, 'DEMO national baseline (replace with reviewed data)'),
      ('plumbing', 'plumbing.faucet_cartridge', 'Dripping faucet cartridge or washer', NULL, 1000, 4500, 15000, 30000, 'DEMO national baseline (replace with reviewed data)'),
      ('hvac', 'hvac.air_filter_replacement', 'Clogged or dirty HVAC air filter', NULL, 1000, 6000, 9000, 18000, 'DEMO national baseline (replace with reviewed data)'),
      ('hvac', 'hvac.air_filter_replacement', 'Clogged or dirty HVAC air filter', '331', 1200, 6500, 11000, 20000, 'DEMO Miami-Dade sample (replace with reviewed data)'),
      ('appliance', 'appliance.fridge_airflow', 'Refrigerator airflow blocked or evaporator fan issue', NULL, 0, 9000, 15000, 35000, 'DEMO national baseline (replace with reviewed data)')`);
  }

  const kb = createKnowledgeBase({ db, embedder: createEmbedder(config) });
  const { rows: kd } = await db.query('SELECT 1 FROM knowledge_documents LIMIT 1');
  if (!kd.length) {
    await kb.ingest({
      title: 'Air filter checks for central HVAC (starter guide)', sourceType: 'repair_guide', category: 'hvac', equipmentType: 'Central HVAC', reviewState: 'approved', createdBy: 'demo_admin',
      text: `# When cooling is weak
  A heavily loaded air filter restricts airflow across the indoor coil, which reduces cooling and can lead to coil icing.

  # Checking the filter
  Set the thermostat to Off before removing the filter. Filters usually sit in a return air grille or a slot next to the air handler. Hold the filter up to a light; if little light passes through, it is due for replacement.

  # Replacing the filter
  Match the nominal size printed on the frame (for example 16x25x1). Insert the new filter with the airflow arrow pointing toward the air handler, in the direction air moves through the system. Set the thermostat back to Cool.

  # When to stop
  If ice is visible on refrigerant lines or the indoor coil, turn cooling off, let it thaw, and book a technician. Do not open sealed refrigerant components.`,
    });
    await kb.ingest({
      title: 'Sink drain (P-trap) leak checks (starter guide)', sourceType: 'repair_guide', category: 'plumbing', reviewState: 'approved', createdBy: 'demo_admin',
      text: `# Locating the leak
  Dry the trap and connections with a cloth, place a dry paper towel underneath, then run water for 30 seconds. The first wet spot shows the leaking joint.

  # Slip-joint nuts
  Plastic slip nuts usually seal by hand-tightening a further quarter turn. Overtightening can crack them. A leak that continues after tightening usually means a worn or misaligned washer.

  # Escalate when
  Water comes from the wall connection, the supply valves, or a cracked pipe, or the cabinet floor is soft or swollen.`,
    });
  }

  const sign = (sub) => jwt.sign({ sub }, config.auth.jwtSecret, { algorithm: 'HS256', expiresIn: '30d' });
  return Object.fromEntries(['demo_homeowner', 'demo_contractor', 'demo_admin'].map((u) => [u, sign(u)]));
}
