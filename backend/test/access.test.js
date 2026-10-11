// Authorization, isolation, entitlement and media access.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCase, createTestEnv, modelOutput, png, promptText, scriptedProvider, seed, tokenFor, uploadPhotos } from './helpers.js';

let env, ids, provider;
before(async () => {
  provider = scriptedProvider({ handler: () => modelOutput() });
  env = await createTestEnv({ providers: [provider] });
  ids = await seed(env.db);
});

test('requests without a valid token are rejected', async () => {
  assert.equal((await env.api.get('/api/fixera/cases')).status, 401);
  assert.equal((await env.api.get('/api/fixera/cases').set('authorization', 'Bearer not-a-jwt')).status, 401);
});

test("a user cannot open a case on another customer's property", async () => {
  const res = await env.api.post('/api/fixera/cases').set('authorization', tokenFor('u_bob')).send({ property_id: ids.alice1, category: 'plumbing', description: 'Sink is leaking' });
  assert.equal(res.status, 404);
});

test("another customer's case, photos and passport are invisible", async () => {
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Sink is leaking under the cabinet' });
  const up = await uploadPhotos(env.api, 'u_alice', c.id, [png()]);
  assert.equal(up.status, 201);
  const mediaUrl = up.body.media[0].url;
  for (const path of [`/api/fixera/cases/${c.id}`, mediaUrl, `/api/fixera/properties/${ids.alice1}/passport`]) {
    assert.equal((await env.api.get(path).set('authorization', tokenFor('u_bob'))).status, 404, path);
  }
  const own = await env.api.get(mediaUrl).set('authorization', tokenFor('u_alice'));
  assert.equal(own.status, 200);
  assert.equal(own.headers['content-type'], 'image/png');
});

test('only image files are accepted, identified by content not by name', async () => {
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Drip from faucet' });
  const res = await env.api.post(`/api/fixera/cases/${c.id}/media`).set('authorization', tokenFor('u_alice'))
    .attach('photos', Buffer.from('#!/bin/sh\necho pwned\n'.repeat(10)), { filename: 'leak.png', contentType: 'image/png' });
  assert.equal(res.status, 415);
});

test('photo count follows the platform allowance', async () => {
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Toilet runs constantly' });
  assert.equal((await uploadPhotos(env.api, 'u_alice', c.id, [png(), png(), png(), png()])).status, 201);
  assert.equal((await uploadPhotos(env.api, 'u_alice', c.id, [png(), png(), png()])).status, 413);
});

test('paid AI analysis is blocked server-side without HomeCare Pro', async () => {
  const c = await createCase(env.api, 'u_carl', { property_id: ids.carl1, category: 'plumbing', description: 'Sink is leaking' });
  const res = await env.api.post(`/api/fixera/cases/${c.id}/analyze`).set('authorization', tokenFor('u_carl'));
  assert.equal(res.status, 402);
  assert.equal(res.body.error.code, 'subscription_required');
});

test('Hire a Professional works without a subscription and without AI', async () => {
  const calls = provider.calls.length;
  const c = await createCase(env.api, 'u_carl', { property_id: ids.carl1, category: 'plumbing', description: 'Water heater leaking' });
  await uploadPhotos(env.api, 'u_carl', c.id, [png()], 'camera');
  const res = await env.api.post(`/api/fixera/cases/${c.id}/hire-pro`).set('authorization', tokenFor('u_carl')).send({ preferred_date: '2026-10-13', preferred_window: 'morning' });
  assert.equal(res.status, 201);
  assert.equal(res.body.service_request.dispatch_fee_cents, 12500, 'fee comes from platform settings');
  assert.equal(res.body.service_request.payment.required, true);
  assert.equal(provider.calls.length, calls, 'no model call');
  const sr = (await env.db.query('SELECT handoff FROM service_requests WHERE id = $1', [res.body.service_request.id])).rows[0];
  assert.equal(sr.handoff.ai_assessment, null);
  assert.equal(sr.handoff.photos.length, 1);
});

test('service-specific dispatch fee override applies', async () => {
  await env.db.query(`UPDATE service_categories SET dispatch_fee_cents = 9900 WHERE slug = 'appliance'`);
  const c = await createCase(env.api, 'u_carl', { property_id: ids.carl1, category: 'appliance', description: 'Dryer will not heat' });
  const res = await env.api.post(`/api/fixera/cases/${c.id}/hire-pro`).set('authorization', tokenFor('u_carl')).send({ preferred_date: '2026-10-14', preferred_window: 'evening' });
  assert.equal(res.body.service_request.dispatch_fee_cents, 9900);
});

test('same owner, two properties: context and history stay isolated; other customers never leak', async () => {
  provider.calls.length = 0;
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'hvac', description: 'AC runs but the house is not cooling' });
  const res = await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set('authorization', tokenFor('u_alice'));
  assert.equal(res.status, 200);
  const text = promptText(provider.calls[0]);
  assert.match(text, new RegExp(ids.hist), 'own property history is in context');
  assert.doesNotMatch(text, /RENTAL-ONLY-BRAND/, "Alice's other property is not in context");
  assert.doesNotMatch(text, /BOB-PRIVATE/, "Bob's history is never in context");
  assert.doesNotMatch(text, /12 Palm Street/, 'street address is not sent to the model');
});

test('admins can read but not act on homeowner cases; contractors only see assigned jobs', async () => {
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Garbage disposal hums' });
  assert.equal((await env.api.get(`/api/fixera/cases/${c.id}`).set('authorization', tokenFor('a_admin'))).status, 200);
  assert.equal((await env.api.post(`/api/fixera/cases/${c.id}/analyze`).set('authorization', tokenFor('a_admin'))).status, 403);
  assert.equal((await env.api.get(`/api/fixera/cases/${c.id}`).set('authorization', tokenFor('c_dana'))).status, 404);
  assert.equal((await env.api.get('/api/fixera/admin/review-queue').set('authorization', tokenFor('u_alice'))).status, 403);
});

test('equipment from another property cannot be attached to a case', async () => {
  const res = await env.api.post('/api/fixera/cases').set('authorization', tokenFor('u_alice')).send({ property_id: ids.alice1, category: 'hvac', description: 'Noisy unit outside', equipment_id: ids.bobHvac });
  assert.equal(res.status, 400);
});
