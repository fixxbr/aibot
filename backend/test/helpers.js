import jwt from 'jsonwebtoken';
import request from 'supertest';
import { deflateSync } from 'node:zlib';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createStorage } from '../src/fixera/media/storage.js';
import { createApp, createFixera } from '../src/app.js';
import { ProviderError } from '../src/fixera/providers/errors.js';

export const SECRET = 'test-secret';

export async function createTestEnv({ providers = [], env = {}, db: existingDb, storage: existingStorage } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', FIXERA_JWT_SECRET: SECRET, MEDIA_DRIVER: 'memory', ...env });
  const db = existingDb || (await createDb(config));
  if (!existingDb) await migrate(db);
  const storage = existingStorage || (await createStorage(config));
  const fixera = createFixera({ db, config, storage, providers, embedder: null });
  const app = createApp(fixera);
  return { db, config, storage, fixera, app, api: request(app) };
}

export const tokenFor = (userId) => `Bearer ${jwt.sign({ sub: userId }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

export async function seed(db) {
  await db.exec(`
    INSERT INTO users (id, role) VALUES ('u_alice','homeowner'), ('u_bob','homeowner'), ('u_carl','homeowner'),
      ('c_dana','contractor'), ('c_eve','contractor'), ('a_admin','admin') ON CONFLICT DO NOTHING;
    INSERT INTO subscriptions (user_id, plan, status) VALUES ('u_alice','homecare_pro','active'), ('u_bob','homecare_pro','active');
  `);
  const prop = async (owner, zip, nickname) =>
    (await db.query(`INSERT INTO properties (owner_user_id, nickname, address_line1, city, state, zip, property_type, year_built)
                     VALUES ($1,$2,'12 Palm Street','Miami','FL',$3,'single_family',1998) RETURNING id`, [owner, nickname, zip])).rows[0].id;
  const alice1 = await prop('u_alice', '33101', 'Main house');
  const alice2 = await prop('u_alice', '30301', 'Rental');
  const bob1 = await prop('u_bob', '33101', 'Bob home');
  const carl1 = await prop('u_carl', '10001', 'Carl home');
  const hvac = (await db.query(
    `INSERT INTO property_equipment (property_id, category, equipment_type, brand, model_number, installed_on, location)
     VALUES ($1,'hvac','Central HVAC','Carrier','24ACC636A003', (CURRENT_DATE - interval '9 years')::date, 'Garage') RETURNING id`, [alice1])).rows[0].id;
  const hist = (await db.query(
    `INSERT INTO property_service_history (property_id, equipment_id, category, event_type, summary, verification_status, occurred_on)
     VALUES ($1,$2,'hvac','repair','Restricted airflow from clogged return filter; filter replaced','contractor_recorded', (CURRENT_DATE - interval '8 months')::date) RETURNING id`, [alice1, hvac])).rows[0].id;
  // Bob owns the same model: his private history must never reach Alice's context.
  const bobHvac = (await db.query(
    `INSERT INTO property_equipment (property_id, category, equipment_type, brand, model_number) VALUES ($1,'hvac','Central HVAC','Carrier','24ACC636A003') RETURNING id`, [bob1])).rows[0].id;
  await db.query(
    `INSERT INTO property_service_history (property_id, equipment_id, category, event_type, summary, verification_status)
     VALUES ($1,$2,'hvac','repair','BOB-PRIVATE compressor contactor replaced','contractor_recorded')`, [bob1, bobHvac]);
  const rentalHeater = (await db.query(
    `INSERT INTO property_equipment (property_id, category, equipment_type, brand) VALUES ($1,'plumbing','Water heater','RENTAL-ONLY-BRAND') RETURNING id`, [alice2])).rows[0].id;
  return { alice1, alice2, bob1, carl1, hvac, hist, bobHvac, rentalHeater };
}

/** A schema-valid model output with sensible defaults. */
export function modelOutput(overrides = {}) {
  return {
    reply_to_homeowner: 'Here is what I found.',
    problem_summary: 'Water leaking under kitchen sink',
    equipment: 'Sink drain assembly',
    equipment_id: null,
    image_findings: [],
    observations: [],
    possible_causes: [{ name: 'Loose slip nut on P-trap', certainty: 'likely', rationale: 'Water at the joint' }],
    history_considered: [],
    knowledge_used: [],
    missing_information: [],
    photo_requests: [],
    next_question: null,
    hazards_detected: [],
    proposed_risk_level: 'LOW',
    diy_feasible: true,
    difficulty: 'easy',
    estimated_minutes: { min: 10, max: 20 },
    tools: [{ name: 'Bucket', spec: null }, { name: 'Flashlight', spec: null }],
    parts: [],
    preparation: ['Clear the cabinet under the sink.'],
    steps: [
      { action_type: 'safe_check', title: 'Stop using the sink', instruction: 'Stop running water and place a bucket under the trap.', caution: null, stop_condition: 'Water keeps spreading', verification: null },
      { action_type: 'repair', title: 'Hand-tighten the slip nut', instruction: 'Turn the slip nut clockwise by hand until snug.', caution: 'Do not overtighten plastic nuts.', stop_condition: 'The nut is cracked', verification: 'No drips after running water for a minute.' },
      { action_type: 'verify', title: 'Check for drips', instruction: 'Run water for one minute and check the joint with a dry tissue.', caution: null, stop_condition: null, verification: 'Tissue stays dry.' },
    ],
    escalation_signs: ['Water keeps leaking after tightening'],
    pricing_key: null,
    professional_recommended: false,
    ...overrides,
  };
}

/** Scripted provider: records each request and answers with handler(request). */
export function scriptedProvider({ name = 'scripted', vision = true, handler }) {
  const calls = [];
  return {
    name,
    model: `${name}-model`,
    capabilities: { vision, structuredOutput: true },
    calls,
    async generate(req) {
      calls.push(req);
      const out = await handler(req, calls.length);
      return { output: out, model: `${name}-model`, usage: { input_tokens: 1000, output_tokens: 500 } };
    },
  };
}

export const failingProvider = (name, code = 'unavailable') =>
  scriptedProvider({ name, handler: () => { throw new ProviderError(code, `${name} ${code}`, { retryable: true }); } });

export const promptText = (req) => req.messages.flatMap((m) => m.content).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
export const promptImages = (req) => req.messages.flatMap((m) => m.content).filter((c) => c.type === 'image');

// Real PNG files so the server's byte sniffing and dimension parsing run for real.
export function png(width = 800, height = 600, seed = 1) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let x = seed;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; raw[i] = i % (width * 3 + 1) === 0 ? 0 : x & 0xff; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function createCase(api, user, body) {
  const res = await api.post('/api/fixera/cases').set('authorization', tokenFor(user)).send(body);
  if (res.status !== 201) throw new Error(`createCase ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.case;
}

export async function uploadPhotos(api, user, caseId, buffers, capture = 'upload') {
  let req = api.post(`/api/fixera/cases/${caseId}/media`).set('authorization', tokenFor(user)).field('capture_source', capture);
  buffers.forEach((b, i) => { req = req.attach('photos', b, { filename: `p${i}.png`, contentType: 'image/png' }); });
  return req;
}
