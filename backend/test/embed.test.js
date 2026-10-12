// Fixera mounted inside a host (FixBridge) Express app that uses its own session auth,
// driven through the headless client.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createStorage } from '../src/fixera/media/storage.js';
import { createFixera, createFixeraRouter } from '../src/app.js';
import { createPlatformAdapter } from '../src/platform/index.js';
import { createFixeraClient } from '../client/fixera-client.js';
import { freshTestDatabase, modelOutput, png, scriptedProvider, seed } from './helpers.js';

let server, client, ids;
before(async () => {
  const config = loadConfig({ NODE_ENV: 'test', FIXERA_JWT_SECRET: 'unused', MEDIA_DRIVER: 'memory' });
  const db = await createDb(process.env.TEST_DATABASE_URL ? { ...config, databaseUrl: await freshTestDatabase() } : config);
  await migrate(db);
  ids = await seed(db);
  // Host app: its own session middleware sets req.user (here from a cookie-like header).
  const host = express();
  host.use((req, res, next) => { if (req.headers['x-session'] === 'alice-session') req.user = { id: 'u_alice', role: 'homeowner' }; next(); });
  const platform = createPlatformAdapter({ db, config, authenticate: async (req) => req.user || null });
  const fixera = createFixera({ db, config, storage: await createStorage(config), platform, providers: [scriptedProvider({ handler: () => modelOutput({ image_findings: [{ photo: 'photo_1', quality: 'good', quality_issue: null, shows: 'trap', relevant: true }] }) })], embedder: null });
  host.use('/api/fixera', createFixeraRouter(fixera));
  await new Promise((r) => { server = host.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const withSession = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, 'x-session': 'alice-session' } });
  client = createFixeraClient({ baseUrl: `${base}/api/fixera`, fetchImpl: withSession });
});
after(() => server.close());

test('host session auth + headless client: full AI flow', async () => {
  const { case: c } = await client.createCase({ propertyId: ids.alice1, category: 'plumbing', description: 'Leak under the kitchen sink' });
  await client.uploadPhotos(c.id, [new File([png()], 'leak.png', { type: 'image/png' })], 'camera');
  await client.analyze(c.id);
  const statuses = [];
  const view = await client.waitForAnalysis(c.id, { intervalMs: 50, onStatus: (s) => statuses.push(s.status) });
  assert.equal(view.case.status, 'DIY_AVAILABLE');
  assert.ok(view.steps.length > 0);
  const url = await client.photoUrl(view.media[0].url);
  assert.match(url, /^blob:/);
  const fee = await client.dispatchFee('plumbing');
  assert.equal(fee.amount_cents, 12500);
});

test('requests without the host session are rejected', async () => {
  const anon = createFixeraClient({ baseUrl: `http://127.0.0.1:${server.address().port}/api/fixera` });
  await assert.rejects(anon.properties(), { status: 401 });
});

test('sync: site users, properties and subscriptions map onto Fixera records', async () => {
  const { createSync } = await import('../src/platform/sync.js');
  const { createDb: mk } = await import('../src/db/index.js');
  const { migrate: mg } = await import('../src/db/migrate.js');
  const config = loadConfig({ NODE_ENV: 'test', FIXERA_JWT_SECRET: 'unused', MEDIA_DRIVER: 'memory' });
  const db = await mk(process.env.TEST_DATABASE_URL ? { ...config, databaseUrl: await freshTestDatabase() } : config);
  await mg(db);
  const sync = createSync({ db });
  const a = await sync.upsertProperty({ externalRef: 42, ownerUserId: 1001, zip: '33101', nickname: 'Home' });
  const b = await sync.upsertProperty({ externalRef: 42, ownerUserId: 1001, zip: '33102', nickname: 'Home (edited)' });
  assert.equal(a.id, b.id, 'same site property maps to the same Fixera property');
  assert.equal(await sync.propertyIdFor(42), a.id);
  // the site can open a case with its own property id; other users still cannot
  const { createApp, createFixera } = await import('../src/app.js');
  const { createStorage: cs } = await import('../src/fixera/media/storage.js');
  const { default: request } = await import('supertest');
  const jwt = (await import('jsonwebtoken')).default;
  const app = createApp(createFixera({ db, config, storage: await cs(config), providers: [], embedder: null }));
  const tok = (sub) => `Bearer ${jwt.sign({ sub }, 'unused')}`;
  const ok = await request(app).post('/api/fixera/cases').set('authorization', tok('1001')).send({ property_ref: 42, category: 'plumbing', description: 'Leaking faucet' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.case.property_id, a.id);
  await sync.upsertUser({ id: 2002 });
  const denied = await request(app).post('/api/fixera/cases').set('authorization', tok('2002')).send({ property_ref: 42, category: 'plumbing', description: 'Leaking faucet' });
  assert.equal(denied.status, 404);
  const platform = createPlatformAdapter({ db, config });
  assert.equal((await platform.getAnalysisEntitlement('1001')).eligible, false);
  await sync.setSubscription({ userId: 1001, status: 'active' });
  assert.equal((await platform.getAnalysisEntitlement('1001')).eligible, true);
  await sync.setSubscription({ userId: 1001, status: 'canceled' });
  assert.equal((await platform.getAnalysisEntitlement('1001')).eligible, false);
  await db.close();
});
