// Runs SCENARIOS against the providers configured in the environment, end to end, on a
// throwaway in-memory database. Real provider calls cost money, so --yes is required.
//
//   node src/evaluations/run.js --yes [--only id1,id2] [--out report.json]

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { createStorage } from '../fixera/media/storage.js';
import { createApp, createFixera } from '../app.js';
import { createProvidersFromConfig } from '../fixera/providers/registry.js';
import { check, SCENARIOS } from './scenarios.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!args.includes('--yes')) {
  console.log('This sends real requests to your configured AI providers and incurs cost. Re-run with --yes.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig({ ...process.env, NODE_ENV: 'test', FIXERA_JWT_SECRET: 'eval', MEDIA_DRIVER: 'memory', DATABASE_URL: '' });
const providers = createProvidersFromConfig(config);
if (!providers.length) { console.error('No providers configured.'); process.exit(1); }

const counted = providers.map((p) => ({ ...p, calls: 0, generate(req) { this.calls++; return p.generate.call(p, req); } }));
const db = await createDb(config);
await migrate(db);
const fixera = createFixera({ db, config, storage: await createStorage(config), providers: counted, embedder: null });
const api = request(createApp(fixera));
const auth = { authorization: `Bearer ${jwt.sign({ sub: 'eval_user' }, 'eval')}` };

await db.query(`INSERT INTO users (id, role) VALUES ('eval_user', 'homeowner')`);
await db.query(`INSERT INTO subscriptions (user_id, plan, status) VALUES ('eval_user', 'homecare_pro', 'active')`);
const only = flag('--only')?.split(',');
const results = [];

for (const s of SCENARIOS.filter((x) => !only || only.includes(x.id))) {
  const missing = (s.photos || []).filter((f) => !existsSync(path.join(here, 'fixtures', f)));
  if (missing.length) { results.push({ id: s.id, skipped: `missing fixtures: ${missing.join(', ')}` }); continue; }
  const prop = (await db.query(`INSERT INTO properties (owner_user_id, zip, property_type, year_built) VALUES ('eval_user', '33101', 'single_family', 2005) RETURNING id`)).rows[0].id;
  if (s.withHistory) {
    const eq = (await db.query(`INSERT INTO property_equipment (property_id, category, equipment_type, installed_on) VALUES ($1, 'hvac', 'Central HVAC', CURRENT_DATE - 3300) RETURNING id`, [prop])).rows[0].id;
    await db.query(`INSERT INTO property_service_history (property_id, equipment_id, category, event_type, summary, verification_status, occurred_on) VALUES ($1, $2, 'hvac', 'repair', 'Restricted airflow; clogged filter replaced', 'contractor_recorded', CURRENT_DATE - 240)`, [prop, eq]);
  }
  const c = (await api.post('/api/fixera/cases').set(auth).send({ property_id: prop, category: s.category, description: s.description })).body.case;
  if (s.photos?.length) {
    let up = api.post(`/api/fixera/cases/${c.id}/media`).set(auth);
    for (const f of s.photos) up = up.attach('photos', await readFile(path.join(here, 'fixtures', f)), f);
    await up;
  }
  const before = counted.reduce((n, p) => n + p.calls, 0);
  const started = Date.now();
  const view = (await api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth)).body;
  const calls = counted.reduce((n, p) => n + p.calls, 0) - before;
  const failures = check(s, view, calls);
  results.push({ id: s.id, pass: failures.length === 0, failures, status: view.case.status, risk: view.assessment?.safety.level, provider: view.assessment?.provenance.provider, model: view.assessment?.provenance.model, seconds: (Date.now() - started) / 1000 });
  console.log(`${failures.length ? 'FAIL' : 'PASS'} ${s.id} (${view.case.status})${failures.length ? `: ${failures.join('; ')}` : ''}`);
}

const ran = results.filter((r) => !r.skipped);
const summary = { ran: ran.length, passed: ran.filter((r) => r.pass).length, skipped: results.length - ran.length, results };
console.log(`\n${summary.passed}/${summary.ran} passed, ${summary.skipped} skipped`);
if (flag('--out')) await writeFile(flag('--out'), JSON.stringify(summary, null, 2));
await db.close();
process.exit(summary.passed === summary.ran ? 0 : 1);
