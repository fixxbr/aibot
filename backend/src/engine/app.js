// Fixera Engine HTTP API (server-to-server only).
//
//   GET  /v1/health        public: liveness, commit SHA, contract versions, last real inference
//   GET  /v1/status        signed: provider config (no keys), circuit state, store, database evidence
//   POST /v1/probe         signed: one real inference per provider with a test image
//   POST /v1/infer         signed: run inference (sync; `Prefer: respond-async` -> 202 job)
//   GET  /v1/infer/:key    signed: job / idempotent result lookup

import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../logger.js';
import { requireSignature } from './auth.js';
import { CONTRACT_VERSION, EngineError, InferRequest, normalizeMessages, requestHash, SUPPORTED_CONTRACTS } from './contract.js';
import { probeImageDataUrl } from './probeImage.js';

export function createEngineApp({ config, gateway, store, dbInfo = async () => ({ configured: false }), startedAt = new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Keep the exact bytes for signature verification.
  app.use(express.json({ limit: config.engine.bodyLimit, verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') || randomUUID();
    res.set('x-request-id', req.requestId);
    next();
  });

  app.get('/v1/health', (req, res) => {
    const s = gateway.status();
    res.json({
      ok: true,
      service: 'fixera-engine',
      commit: config.engine.commit,
      contract_versions: SUPPORTED_CONTRACTS,
      started_at: startedAt.toISOString(),
      providers_configured: s.providers.length,
      // Evidence of real inference since start, not a configuration claim.
      last_successful_inference: s.last_successful_inference,
    });
  });

  const signed = requireSignature(config.engine.secrets);
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.engine.rateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next) => next(new EngineError('RATE_LIMITED', 'Engine rate limit reached')),
  });

  app.get('/v1/status', signed, async (req, res, next) => {
    try {
      res.json({
        ok: true,
        commit: config.engine.commit,
        contract_versions: SUPPORTED_CONTRACTS,
        node: process.version,
        deadlines: { default_ms: config.engine.defaultDeadlineMs, max_ms: config.engine.maxDeadlineMs },
        limits: { max_images: config.engine.maxImages, max_image_chars: config.engine.maxImageChars, body: config.engine.bodyLimit },
        idempotency_store: store.kind,
        database: await dbInfo(),
        ...gateway.status(),
        probe_performed: false,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/probe', signed, limiter, async (req, res) => {
    const only = req.body?.provider;
    const results = [];
    for (const p of gateway.status().providers.filter((x) => !only || x.name === only)) {
      try {
        const out = await gateway.infer({
          input: normalizeMessages([
            { role: 'system', content: 'Connectivity probe. Reply with a JSON object {"colors": [..]} listing the main colours in the image.' },
            { role: 'user', content: [{ type: 'text', text: 'Which colours are in this test image?' }, { type: 'image_url', image_url: { url: probeImageDataUrl() } }] },
          ], { maxImages: 1, maxImageChars: config.engine.maxImageChars }),
          request: { task: 'other', json: true, deadline_ms: 60_000, preferred_provider: p.name, max_tokens: 2000 },
        });
        const answered = out.provider === p.name;
        results.push({ provider: p.name, ok: answered, model: out.model, latency_ms: out.latency_ms, vision_verified: answered && /red/i.test(out.text) && /blue/i.test(out.text), note: answered ? undefined : `answered by fallback ${out.provider}` });
      } catch (err) {
        results.push({ provider: p.name, ok: false, code: err.code || 'INTERNAL_ERROR', message: err.message });
      }
    }
    res.status(results.some((r) => r.ok) ? 200 : 503).json({ ok: results.some((r) => r.ok), probe_performed: true, commit: config.engine.commit, results });
  });

  app.post('/v1/infer', signed, limiter, async (req, res, next) => {
    let key;
    let started = false;
    try {
      const parsed = InferRequest.safeParse(req.body);
      if (!parsed.success) throw new EngineError('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const body = parsed.data;
      if (!SUPPORTED_CONTRACTS.includes(body.contract_version)) throw new EngineError('UNSUPPORTED_CONTRACT', `Contract ${body.contract_version} is not supported; use ${CONTRACT_VERSION}`);
      const input = normalizeMessages(body.messages, { maxImages: config.engine.maxImages, maxImageChars: config.engine.maxImageChars });
      const async = /respond-async/i.test(req.get('prefer') || '');
      key = req.get('idempotency-key') || null;
      if (async && !key) throw new EngineError('INVALID_REQUEST', 'Asynchronous requests require an Idempotency-Key header');

      if (key) {
        const b = await store.begin(key, requestHash(body), body.idempotency_ttl_s || config.engine.idempotencyTtlS);
        if (b.state === 'conflict') throw new EngineError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request');
        if (b.state === 'replay') return res.status(b.record.httpStatus).set('idempotent-replay', 'true').json({ ...b.record.response, cached: true });
        if (b.state === 'running') {
          if (async) return res.status(202).json(accepted(key));
          throw new EngineError('IN_PROGRESS', 'An identical request is already running; poll GET /v1/infer/:key', { idempotency_key: key });
        }
        started = true;
      }

      // Caller disconnect (or Fixbridge's own abort) cancels upstream work for sync calls.
      const ctrl = new AbortController();
      if (!async) res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

      const run = gateway
        .infer({ input, request: body, signal: ctrl.signal })
        .then((out) => ({ http: 200, body: { ok: true, contract_version: CONTRACT_VERSION, request_id: req.requestId, ...out, cached: false } }))
        .catch((err) => {
          const e = err instanceof EngineError ? err : new EngineError('INTERNAL_ERROR', 'Engine error');
          if (!(err instanceof EngineError)) logger.error({ err: { message: err.message, stack: err.stack } }, 'engine infer crashed');
          return { http: e.status, body: errorBody(e, req.requestId) };
        })
        .then(async (r) => {
          if (key) await store.finish(key, r.body.ok ? 'succeeded' : 'failed', r.http, r.body);
          logger.info({ request_id: req.requestId, task: body.task, ok: r.body.ok, code: r.body.code, provider: r.body.provider, model: r.body.model, images: input.imageCount, latency_ms: r.body.latency_ms, metadata: body.metadata }, 'engine infer');
          return r;
        });

      if (async) {
        run.catch(() => {});
        return res.status(202).json(accepted(key));
      }
      const r = await run;
      if (!res.writableEnded && !res.destroyed) res.status(r.http).json(r.body);
    } catch (err) {
      if (key && started) await store.finish(key, 'failed', err.status || 500, errorBody(err, req.requestId)).catch(() => {});
      next(err);
    }
  });

  app.get('/v1/infer/:key', signed, async (req, res, next) => {
    try {
      const rec = await store.get(req.params.key);
      if (!rec) throw new EngineError('NOT_FOUND', 'Unknown or expired request');
      if (rec.status === 'running') return res.status(202).json(accepted(rec.key));
      res.status(rec.httpStatus).json({ ...rec.response, status: rec.status });
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Route not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json(errorBody(new EngineError('IMAGE_TOO_LARGE', 'Request body too large'), req.requestId));
    if (err?.type === 'entity.parse.failed') return res.status(400).json(errorBody(new EngineError('INVALID_REQUEST', 'Malformed JSON'), req.requestId));
    const e = err instanceof EngineError ? err : new EngineError('INTERNAL_ERROR', 'Engine error');
    if (!(err instanceof EngineError)) logger.error({ err: { message: err?.message, stack: err?.stack } }, 'engine error');
    res.status(e.status).json(errorBody(e, req.requestId));
  });
  return app;
}

const accepted = (key) => ({ ok: true, status: 'running', idempotency_key: key, poll: `/v1/infer/${encodeURIComponent(key)}` });

function errorBody(e, requestId) {
  return { ok: false, contract_version: CONTRACT_VERSION, request_id: requestId, code: e.code || 'INTERNAL_ERROR', message: e.message, retryable: Boolean(e.retryable), attempts: e.attempts || [], idempotency_key: e.idempotency_key };
}
