// Fixera Engine provider adapter for FixBridge's api/ai.js.
//
// Drop this file into the FixBridge repo at api/fixera-engine-provider.js. It implements the
// existing provider interface, so every current caller (api/fixa/core.js, managed-routes
// assessRepair/extractDocument, home-assistant and homecare-pro `complete`) goes through it
// without changes once it is registered in the resolver. FixBridge keeps authorization,
// context selection, parsing, deterministic safety, pricing and persistence.
//
// Contract with api/ai.js:
//   analyze({ messages, temperature, maxTokens, json, signal }) ->
//     { ok, provider, model, status?, code, text?, message?, requestId?, latencyMs?, usage? }
// It never throws and never fabricates success: failures are { ok: false, code }.
//
// Environment (server only; never shipped to the browser):
//   FIXERA_ENGINE_URL            e.g. https://fixera-engine.up.railway.app
//   FIXERA_ENGINE_SECRET         HMAC signing secret shared with the engine (not SESSION_SECRET)
//   FIXERA_ENGINE_TIMEOUT_MS     total deadline per call, default 35000 (below AI_FETCH_TIMEOUT_MS=38000)
//   FIXERA_ENGINE_CONTRACT       default 2026-10-01

import { createHash, createHmac } from 'node:crypto';

export const ENGINE_PROVIDER_ID = 'fixera-engine';
const DEFAULT_CONTRACT = '2026-10-01';
const POLL_INTERVAL_MS = 750;

export function createFixeraEngineProvider({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const baseUrl = String(env.FIXERA_ENGINE_URL || '').replace(/\/+$/, '');
  const secret = env.FIXERA_ENGINE_SECRET || '';
  const timeoutMs = Number(env.FIXERA_ENGINE_TIMEOUT_MS || 35_000);
  const contract = env.FIXERA_ENGINE_CONTRACT || DEFAULT_CONTRACT;
  let lastModel = null;

  const isConfigured = () => Boolean(baseUrl && secret && typeof fetchImpl === 'function');

  function signedHeaders(rawBody) {
    const ts = String(now());
    const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    return { 'content-type': 'application/json', 'x-fixera-timestamp': ts, 'x-fixera-signature': `v1=${sig}` };
  }

  async function request(method, path, body, { signal, deadline, idempotencyKey } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ctrl = new AbortController();
    const remaining = Math.max(1, deadline - now());
    const timer = setTimeout(() => ctrl.abort(new Error('deadline')), remaining);
    const onAbort = () => ctrl.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { ...signedHeaders(raw), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        body: method === 'GET' ? undefined : raw,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    } catch (err) {
      if (signal?.aborted) return { status: 0, error: 'FIXERA_ENGINE_CANCELLED' };
      if (ctrl.signal.aborted) return { status: 0, error: 'FIXERA_ENGINE_TIMEOUT' };
      return { status: 0, error: 'FIXERA_ENGINE_UNREACHABLE', detail: err?.message };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Core call. `idempotencyKey` (optional) lets FixBridge pass e.g. `${invocationId}:${attempt}`.
   * Without one, a short-lived key is derived from the request content so an outer
   * Promise.race retry of the very same request joins the in-flight call instead of paying twice.
   */
  async function call({ messages, temperature, maxTokens, json, signal, task = 'assessment', idempotencyKey, metadata, deadlineMs }) {
    const started = now();
    const fail = (code, extra = {}) => ({ ok: false, provider: ENGINE_PROVIDER_ID, model: lastModel || ENGINE_PROVIDER_ID, code, latencyMs: now() - started, ...extra });
    if (!isConfigured()) return fail('FIXERA_ENGINE_NOT_CONFIGURED');
    if (signal?.aborted) return fail('FIXERA_ENGINE_CANCELLED');

    const budget = Math.max(1000, Number(deadlineMs || timeoutMs));
    const deadline = started + budget;
    const body = {
      contract_version: contract,
      task,
      messages,
      json: Boolean(json),
      temperature: temperature ?? null,
      max_tokens: maxTokens ?? null,
      // Engine finishes (or gives up) slightly before we stop waiting.
      deadline_ms: Math.max(1000, budget - 500),
      ...(metadata ? { metadata } : {}),
    };
    const key = idempotencyKey || `auto:${createHash('sha256').update(JSON.stringify([task, messages, Boolean(json), temperature ?? null, maxTokens ?? null])).digest('hex')}`;
    if (!idempotencyKey) body.idempotency_ttl_s = 120;

    let r = await request('POST', '/v1/infer', body, { signal, deadline, idempotencyKey: key });
    // Identical request already running (e.g. an outer retry): wait for that result.
    while (!r.error && r.status === 409 && r.data?.code === 'IN_PROGRESS' && now() < deadline) {
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())), signal);
      if (signal?.aborted) return fail('FIXERA_ENGINE_CANCELLED');
      r = await request('GET', `/v1/infer/${encodeURIComponent(key)}`, undefined, { signal, deadline });
      if (r.status === 202) r = { status: 409, data: { code: 'IN_PROGRESS' } };
    }
    if (r.error) return fail(r.error, r.detail ? { message: r.detail } : {});
    const d = r.data || {};
    if (r.status === 409) return fail('FIXERA_ENGINE_TIMEOUT', { status: 504 });
    if (!d.ok) {
      return fail(d.code ? `FIXERA_ENGINE_${d.code}` : 'FIXERA_ENGINE_BAD_RESPONSE', {
        status: r.status,
        requestId: d.request_id,
        retryable: Boolean(d.retryable),
        attempts: d.attempts,
        message: d.message,
      });
    }
    if (typeof d.text !== 'string' || !d.text) return fail('FIXERA_ENGINE_BAD_RESPONSE', { status: r.status, requestId: d.request_id });
    lastModel = `${d.provider}:${d.model}`;
    return {
      ok: true,
      provider: ENGINE_PROVIDER_ID,
      model: lastModel,
      status: r.status,
      code: 'OK',
      text: d.text,
      message: { role: 'assistant', content: d.text },
      requestId: d.request_id,
      latencyMs: now() - started,
      usage: d.usage || undefined,
      // Extra provenance FixBridge may record alongside the assessment.
      upstream: { provider: d.provider, model: d.model, attempts: d.attempts, visionUsed: d.vision_used, imageCount: d.image_count, cached: Boolean(d.cached) },
    };
  }

  return {
    id: ENGINE_PROVIDER_ID,
    name: ENGINE_PROVIDER_ID,
    get model() { return lastModel || ENGINE_PROVIDER_ID; },
    isConfigured,
    analyze: (opts) => call({ task: 'assessment', ...opts }),
    // Chat / Home Assistant / HomeCare Pro use the same path without JSON mode by default.
    complete: (opts) => call({ task: 'chat', ...opts }),
    createCompletion: (opts) => call({ task: 'chat', ...opts }),
    extractDocument: (opts) => call({ task: 'extract', json: true, ...opts }),
    metadata: () => ({ provider: ENGINE_PROVIDER_ID, url: baseUrl || null, contract, timeoutMs, configured: isConfigured() }),

    /**
     * Non-inference status by default (matches /api/fixera/health semantics).
     * health({ probe: true }) performs a real, billed inference on the engine and reports
     * whether a model actually answered and saw the test image.
     */
    async health({ probe = false, signal } = {}) {
      if (!isConfigured()) return { ok: false, status: 'not_connected', code: 'FIXERA_ENGINE_NOT_CONFIGURED' };
      const deadline = now() + (probe ? 70_000 : 10_000);
      const r = probe ? await request('POST', '/v1/probe', {}, { signal, deadline }) : await request('GET', '/v1/status', undefined, { signal, deadline });
      if (r.error) return { ok: false, status: 'not_connected', code: r.error };
      if (r.status === 401) return { ok: false, status: 'not_connected', code: 'FIXERA_ENGINE_AUTH_FAILED' };
      const d = r.data || {};
      return probe
        ? { ok: Boolean(d.ok), status: d.ok ? 'inference_verified' : 'inference_failed', commit: d.commit, results: d.results }
        : { ok: Boolean(d.ok), status: 'configured_not_probed', commit: d.commit, contract_versions: d.contract_versions, providers: d.providers, last_successful_inference: d.last_successful_inference, database: d.database };
    },
  };
}

/**
 * Resolver helper for api/ai.js. Given the provider list the resolver already built (in its
 * Gemini -> OpenRouter -> Anthropic -> OpenAI order), put the engine first when selected and
 * keep the original providers behind it as the rollback path.
 *
 *   FIXERA_AI_PROVIDER=fixera-engine            use the engine first
 *   FIXERA_ENGINE_FALLBACK=original (default)   on engine failure, continue with original providers
 *   FIXERA_ENGINE_FALLBACK=none                 engine only
 * Rollback: unset FIXERA_AI_PROVIDER (or set it back to a provider name). No code change.
 */
export function withFixeraEngine(originalProviders, { env = process.env, engine = createFixeraEngineProvider({ env }) } = {}) {
  const selected = String(env.FIXERA_AI_PROVIDER || env.AI_PRIMARY_PROVIDER || '').toLowerCase() === ENGINE_PROVIDER_ID;
  if (!selected || !engine.isConfigured()) return originalProviders;
  return String(env.FIXERA_ENGINE_FALLBACK || 'original').toLowerCase() === 'none' ? [engine] : [engine, ...originalProviders];
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

