// Fixera Engine + FixBridge adapter, end to end over real HTTP.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { createEngineApp } from '../src/engine/app.js';
import { createGateway } from '../src/engine/gateway.js';
import { createMemoryStore, createPgStore } from '../src/engine/store.js';
import { sign } from '../src/engine/auth.js';
import { ProviderError } from '../src/fixera/providers/errors.js';
import { createFixeraEngineProvider, withFixeraEngine } from '../../integration/fixbridge/api/fixera-engine-provider.js';
import { freshTestDatabase, png } from './helpers.js';

const SECRET = 'engine-test-secret';
const ASSESSMENT = JSON.stringify({ summary: 'Cooling issue needs confirmation', urgency: 'medium', safe_diy_allowed: false });
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

// Scripted providers implementing the raw `complete` interface.
function provider(name, { vision = true, handler }) {
  const calls = [];
  return {
    name, model: `${name}-model`, capabilities: { vision }, calls,
    async complete(req) {
      calls.push(req);
      return handler(req, calls.length);
    },
  };
}
const answer = (text = ASSESSMENT) => async () => ({ text, model: 'm-1', requestId: 'up-1', usage: { input_tokens: 10, output_tokens: 5 } });
const hang = () => (req) => new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason)));

let servers = [];
async function startEngine(providers, { store = createMemoryStore(), env = {} } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', FIXERA_ENGINE_SECRET: SECRET, FIXERA_PROVIDER_TIMEOUT_MS: '30000', ...env });
  const gateway = createGateway({ providers, config });
  const app = createEngineApp({ config: { ...config, engine: { ...config.engine, commit: 'abc123' } }, gateway, store });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const adapter = createFixeraEngineProvider({ env: { FIXERA_ENGINE_URL: url, FIXERA_ENGINE_SECRET: SECRET, FIXERA_ENGINE_TIMEOUT_MS: env.ADAPTER_TIMEOUT || '35000' } });
  return { url, adapter, gateway };
}
const signedPost = async (url, body, headers = {}) => {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const res = await fetch(url, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-fixera-timestamp': String(ts), 'x-fixera-signature': sign(SECRET, ts, raw), ...headers } });
  return { status: res.status, body: await res.json() };
};
const baseBody = (over = {}) => ({ contract_version: '2026-10-01', task: 'assessment', messages: [{ role: 'user', content: 'Fridge not cooling' }], json: true, ...over });

after(() => servers.forEach((s) => s.close()));
beforeEach(() => {});

test('analyze(): text + real image data URLs reach the provider; result has the api/ai.js shape', async () => {
  const p = provider('gemini', { handler: answer() });
  const { adapter } = await startEngine([p]);
  const img = png(400, 300, 3);
  const r = await adapter.analyze({
    messages: [
      { role: 'system', content: 'You are Fixera. Return the canonical assessment JSON.' },
      { role: 'user', content: [{ type: 'text', text: 'Refrigerator not cooling' }, { type: 'image_url', image_url: { url: dataUrl(img) } }] },
    ],
    temperature: 0.2,
    maxTokens: 1200,
    json: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'fixera-engine');
  assert.equal(r.code, 'OK');
  assert.equal(r.text, ASSESSMENT);
  assert.deepEqual(r.message, { role: 'assistant', content: ASSESSMENT });
  assert.equal(r.model, 'gemini:m-1');
  assert.ok(r.requestId && r.latencyMs >= 0);
  assert.equal(r.upstream.visionUsed, true);
  const sent = p.calls[0];
  assert.equal(sent.system, 'You are Fixera. Return the canonical assessment JSON.');
  assert.equal(sent.messages[0].content[1].data, img.toString('base64'), 'exact image bytes forwarded');
  assert.equal(sent.json, true);
  assert.equal(sent.temperature, 0.2);
  assert.equal(sent.maxTokens, 1200);
});

test('images are validated like repair-photos.js: type, base64, byte signature, count and size', async () => {
  const { url } = await startEngine([provider('gemini', { handler: answer() })]);
  const msg = (parts) => baseBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, ...parts] }] });
  const img = (u) => ({ type: 'image_url', image_url: { url: u } });
  assert.equal((await signedPost(`${url}/v1/infer`, msg([img('data:image/gif;base64,R0lGODlh')]))).body.code, 'INVALID_IMAGE');
  assert.equal((await signedPost(`${url}/v1/infer`, msg([img('data:image/png;base64,abc$')]))).body.code, 'INVALID_IMAGE');
  assert.equal((await signedPost(`${url}/v1/infer`, msg([img(dataUrl(Buffer.from('not really a png at all')))]))).body.code, 'INVALID_IMAGE');
  const seven = Array.from({ length: 7 }, () => img(dataUrl(png(20, 20))));
  assert.equal((await signedPost(`${url}/v1/infer`, msg(seven))).body.code, 'TOO_MANY_IMAGES');
  const { randomBytes } = await import('node:crypto');
  const big = await signedPost(`${url}/v1/infer`, msg([img(dataUrl(Buffer.concat([png(10, 10), randomBytes(600_000)])))]));
  assert.equal(big.status, 413);
  assert.equal(big.body.code, 'IMAGE_TOO_LARGE');
  assert.equal((await signedPost(`${url}/v1/infer`, msg([img(dataUrl(png(30, 30), 'image/jpg'))]))).body.code, 'INVALID_IMAGE', 'declared jpg but bytes are png');
});

test('requests must be signed with the engine secret, not a session token', async () => {
  const { url } = await startEngine([provider('gemini', { handler: answer() })]);
  const raw = JSON.stringify(baseBody());
  const unsigned = await fetch(`${url}/v1/infer`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.status, 401);
  const ts = Date.now();
  const wrong = await fetch(`${url}/v1/infer`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-fixera-timestamp': String(ts), 'x-fixera-signature': sign('session-secret', ts, raw) } });
  assert.equal(wrong.status, 401);
  const old = Date.now() - 10 * 60 * 1000;
  const stale = await fetch(`${url}/v1/infer`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-fixera-timestamp': String(old), 'x-fixera-signature': sign(SECRET, old, raw) } });
  assert.equal(stale.status, 401);
  const tampered = await fetch(`${url}/v1/infer`, { method: 'POST', body: raw.replace('Fridge', 'Oven'), headers: { 'content-type': 'application/json', 'x-fixera-timestamp': String(ts), 'x-fixera-signature': sign(SECRET, ts, raw) } });
  assert.equal(tampered.status, 401);
});

test('unsupported contract versions are rejected explicitly', async () => {
  const { url } = await startEngine([provider('gemini', { handler: answer() })]);
  const r = await signedPost(`${url}/v1/infer`, baseBody({ contract_version: '2030-01-01' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'UNSUPPORTED_CONTRACT');
});

test('photos never go to a text-only provider; no vision provider -> explicit failure', async () => {
  const textOnly = provider('openrouter', { vision: false, handler: answer() });
  const vision = provider('anthropic', { handler: answer() });
  const { adapter } = await startEngine([textOnly, vision]);
  const withImage = [{ role: 'user', content: [{ type: 'text', text: 'leak' }, { type: 'image_url', image_url: dataUrl(png(50, 50)) }] }];
  const r = await adapter.analyze({ messages: withImage, json: true });
  assert.equal(r.ok, true);
  assert.equal(textOnly.calls.length, 0);
  assert.equal(r.upstream.provider, 'anthropic');

  const only = await startEngine([provider('openrouter', { vision: false, handler: answer() })]);
  const r2 = await only.adapter.analyze({ messages: withImage, json: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'FIXERA_ENGINE_NO_VISION_PROVIDER');
  // text-only requests still work on that provider
  assert.equal((await only.adapter.complete({ messages: [{ role: 'user', content: 'hello' }] })).ok, true);
});

test('invalid JSON is retried once, then the next provider is used', async () => {
  const bad = provider('gemini', { handler: answer('Sure! Here is your assessment: cooling issue.') });
  const good = provider('openai', { handler: answer() });
  const { adapter } = await startEngine([bad, good]);
  const r = await adapter.analyze({ messages: [{ role: 'user', content: 'x' }], json: true });
  assert.equal(r.ok, true);
  assert.equal(bad.calls.length, 2);
  assert.equal(r.upstream.provider, 'openai');
  assert.deepEqual(r.upstream.attempts.map((a) => `${a.provider}:${a.status}`), ['gemini:invalid_output', 'gemini:invalid_output', 'openai:ok']);
});

test('provider outage falls back; all providers failing returns ok:false with a code, never fake text', async () => {
  const down = provider('gemini', { handler: async () => { throw new ProviderError('unavailable', 'down', { retryable: true }); } });
  const up = provider('anthropic', { handler: answer() });
  const { adapter } = await startEngine([down, up]);
  assert.equal((await adapter.analyze({ messages: [{ role: 'user', content: 'x' }], json: true })).upstream.provider, 'anthropic');

  const dead = await startEngine([provider('gemini', { handler: async () => { throw new ProviderError('unavailable', 'down'); } }), provider('openai', { handler: async () => { throw new ProviderError('auth', 'bad key'); } })]);
  const r = await dead.adapter.analyze({ messages: [{ role: 'user', content: 'x' }], json: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FIXERA_ENGINE_PROVIDER_FAILED');
  assert.equal(r.text, undefined);
  assert.equal(r.retryable, true);
});

test('total deadline: a hanging provider is aborted upstream and the call ends on time', async () => {
  const slow = provider('gemini', { handler: hang() });
  const { adapter } = await startEngine([slow], { env: { ADAPTER_TIMEOUT: '2500' } });
  const t0 = Date.now();
  const r = await adapter.analyze({ messages: [{ role: 'user', content: 'x' }], json: true });
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(r.code, /FIXERA_ENGINE_(DEADLINE_EXCEEDED|TIMEOUT)/);
  assert.ok(elapsed < 3500, `finished in ${elapsed}ms`);
  assert.equal(slow.calls[0].signal.aborted, true, 'upstream request was actually cancelled');
});

test("caller's AbortSignal cancels the engine call and the upstream provider request", async () => {
  const slow = provider('gemini', { handler: hang() });
  const { adapter } = await startEngine([slow]);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  const r = await adapter.analyze({ messages: [{ role: 'user', content: 'x' }], json: true, signal: ctrl.signal });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FIXERA_ENGINE_CANCELLED');
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(slow.calls[0].signal.aborted, true);
});

test('duplicate concurrent calls (outer Promise.race retry) share one model call', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = provider('gemini', { handler: async () => { await gate; return answer()(); } });
  const { adapter } = await startEngine([p]);
  const req = { messages: [{ role: 'user', content: 'same request' }], json: true };
  const first = adapter.analyze(req);
  await new Promise((r) => setTimeout(r, 100));
  const second = adapter.analyze(req);
  await new Promise((r) => setTimeout(r, 300));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(p.calls.length, 1, 'only one paid model call');
  assert.equal(a.text, b.text);
});

test('explicit idempotency keys: replay, conflict, and retry after failure', async () => {
  let fail = true;
  const p = provider('gemini', { handler: async () => { if (fail) throw new ProviderError('unavailable', 'down'); return answer()(); } });
  const { url } = await startEngine([p]);
  const h = { 'idempotency-key': 'invocation-001:1' };
  assert.equal((await signedPost(`${url}/v1/infer`, baseBody(), h)).body.code, 'PROVIDER_FAILED');
  fail = false;
  const ok1 = await signedPost(`${url}/v1/infer`, baseBody(), h);
  assert.equal(ok1.body.ok, true, 'a failed key can be retried');
  const replay = await signedPost(`${url}/v1/infer`, baseBody(), h);
  assert.equal(replay.body.cached, true);
  assert.equal(p.calls.length, 2, 'replay did not call the model');
  const conflict = await signedPost(`${url}/v1/infer`, baseBody({ messages: [{ role: 'user', content: 'different' }] }), h);
  assert.equal(conflict.status, 422);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('async jobs: 202 then poll for the result (for the assessment worker)', async () => {
  const p = provider('gemini', { handler: async () => { await new Promise((r) => setTimeout(r, 200)); return answer()(); } });
  const { url } = await startEngine([p]);
  const start = await signedPost(`${url}/v1/infer`, baseBody(), { prefer: 'respond-async', 'idempotency-key': 'job-501' });
  assert.equal(start.status, 202);
  assert.equal(start.body.poll, '/v1/infer/job-501');
  const poll = async () => {
    const ts = Date.now();
    const res = await fetch(`${url}${start.body.poll}`, { headers: { 'x-fixera-timestamp': String(ts), 'x-fixera-signature': sign(SECRET, ts, '') } });
    return { status: res.status, body: await res.json() };
  };
  let r = await poll();
  assert.equal(r.status, 202);
  await new Promise((res) => setTimeout(res, 400));
  r = await poll();
  assert.equal(r.status, 200);
  assert.equal(r.body.text, ASSESSMENT);
});

test('health attests commit and real inference; status is config only; probe performs inference', async () => {
  const p = provider('gemini', { handler: async (req) => ({ text: JSON.stringify({ colors: req.messages[0].content.some((c) => c.type === 'image') ? ['red', 'blue'] : [] }), model: 'g-1' }) });
  const { url, adapter } = await startEngine([p]);
  let h = await (await fetch(`${url}/v1/health`)).json();
  assert.equal(h.commit, 'abc123');
  assert.equal(h.last_successful_inference, null, 'no claim of inference before one happened');
  const st = await adapter.health();
  assert.equal(st.status, 'configured_not_probed');
  assert.equal(p.calls.length, 0, 'status does not call a model');
  assert.equal(st.providers[0].name, 'gemini');
  assert.equal(st.database.configured, false);
  const pr = await adapter.health({ probe: true });
  assert.equal(pr.status, 'inference_verified');
  assert.equal(pr.results[0].vision_verified, true);
  h = await (await fetch(`${url}/v1/health`)).json();
  assert.equal(h.last_successful_inference.provider, 'gemini');
});

test('adapter fails closed when not configured or engine unreachable', async () => {
  const none = createFixeraEngineProvider({ env: {} });
  assert.equal(none.isConfigured(), false);
  assert.equal((await none.analyze({ messages: [] })).code, 'FIXERA_ENGINE_NOT_CONFIGURED');
  const gone = createFixeraEngineProvider({ env: { FIXERA_ENGINE_URL: 'http://127.0.0.1:1', FIXERA_ENGINE_SECRET: SECRET } });
  const r = await gone.analyze({ messages: [{ role: 'user', content: 'x' }], json: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FIXERA_ENGINE_UNREACHABLE');
});

test('resolver helper: opt-in by env, original providers kept as rollback', () => {
  const originals = [{ name: 'gemini' }, { name: 'openai' }];
  const env = { FIXERA_ENGINE_URL: 'http://x', FIXERA_ENGINE_SECRET: 's' };
  assert.deepEqual(withFixeraEngine(originals, { env }), originals, 'not selected -> unchanged');
  const on = withFixeraEngine(originals, { env: { ...env, FIXERA_AI_PROVIDER: 'fixera-engine' } });
  assert.deepEqual(on.map((p) => p.name), ['fixera-engine', 'gemini', 'openai']);
  const only = withFixeraEngine(originals, { env: { ...env, FIXERA_AI_PROVIDER: 'fixera-engine', FIXERA_ENGINE_FALLBACK: 'none' } });
  assert.deepEqual(only.map((p) => p.name), ['fixera-engine']);
  assert.deepEqual(withFixeraEngine(originals, { env: { FIXERA_AI_PROVIDER: 'fixera-engine' } }), originals, 'selected but unconfigured -> unchanged');
});

test('durable Postgres store: replay survives restart; interrupted runs become retryable', async () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  const db = await createDb(process.env.TEST_DATABASE_URL ? { ...config, databaseUrl: await freshTestDatabase() } : config);
  const store = await createPgStore(db);
  assert.equal((await store.begin('k1', 'h1', 600)).state, 'new');
  assert.equal((await store.begin('k1', 'h1', 600)).state, 'running');
  assert.equal((await store.begin('k1', 'h2', 600)).state, 'conflict');
  assert.equal(await store.recoverInterrupted(), 1);
  assert.equal((await store.begin('k1', 'h1', 600)).state, 'new', 'failed record can be retried');
  await store.finish('k1', 'succeeded', 200, { ok: true, text: '{}' });
  const store2 = await createPgStore(db); // "restart"
  const r = await store2.begin('k1', 'h1', 600);
  assert.equal(r.state, 'replay');
  assert.deepEqual(r.record.response, { ok: true, text: '{}' });
  await db.close();
});
