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
import { modelOutput, png, scriptedProvider, seed } from './helpers.js';

let server, client, ids;
before(async () => {
  const config = loadConfig({ NODE_ENV: 'test', FIXERA_JWT_SECRET: 'unused', MEDIA_DRIVER: 'memory' });
  const db = await createDb(config);
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
