// Inference gateway: one total deadline, real cancellation, vision-aware routing, JSON
// validation, one retry on unusable output, then fallback to the next provider.
// It never fabricates a success: if no provider produces usable output, it says so.

import { ProviderError } from '../fixera/providers/errors.js';
import { EngineError, isParseableJson } from './contract.js';

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
const SAFETY_MARGIN_MS = 250; // leave time to answer before the caller's deadline

export function createGateway({ providers, config, now = () => Date.now(), logRun = async () => {} }) {
  const health = new Map();
  let lastSuccess = null;
  let lastFailure = null;

  const isOpen = (name) => (health.get(name)?.openUntil ?? 0) > now();
  const ok = (name) => health.set(name, { failures: 0, openUntil: 0 });
  const fail = (name) => {
    const h = health.get(name) || { failures: 0, openUntil: 0 };
    h.failures += 1;
    if (h.failures >= BREAKER_THRESHOLD) h.openUntil = now() + BREAKER_COOLDOWN_MS;
    health.set(name, h);
  };

  function candidates({ needsVision, preferred }) {
    let list = [...providers];
    if (preferred) list.sort((a, b) => (b.name === preferred) - (a.name === preferred));
    if (!list.length) throw new EngineError('NO_PROVIDER_CONFIGURED', 'No AI provider is configured on the engine');
    if (needsVision) {
      list = list.filter((p) => p.capabilities.vision);
      if (!list.length) throw new EngineError('NO_VISION_PROVIDER', 'Images were supplied but no vision-capable provider is configured');
    }
    return list;
  }

  /**
   * @param {object} p
   * @param {{system?:string, messages:any[], imageCount:number}} p.input  normalized messages
   * @param {object} p.request  validated InferRequest
   * @param {AbortSignal} [p.signal]  aborted when the caller disconnects
   */
  async function infer({ input, request, signal }) {
    const started = now();
    const deadline = started + Math.min(request.deadline_ms || config.engine.defaultDeadlineMs, config.engine.maxDeadlineMs);
    const needsVision = input.imageCount > 0 || Boolean(request.require_vision);
    const list = candidates({ needsVision, preferred: request.preferred_provider || null });
    const attempts = [];

    for (const p of list) {
      if (isOpen(p.name)) {
        attempts.push({ provider: p.name, status: 'skipped', code: 'circuit_open' });
        continue;
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal?.aborted) throw new EngineError('CANCELLED', 'Caller cancelled the request', { attempts });
        const remaining = deadline - now() - SAFETY_MARGIN_MS;
        if (remaining < 1000) throw new EngineError('DEADLINE_EXCEEDED', 'Deadline reached before a provider answered', { attempts });
        const timeoutMs = Math.min(p.timeoutMs || config.providers.timeoutMs, remaining);

        // Per-attempt controller: fires on the attempt timeout or when the caller goes away,
        // so the upstream HTTP request is actually aborted, not just raced.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new ProviderError('timeout', `${p.name} timed out`, { retryable: true })), timeoutMs);
        const onAbort = () => ctrl.abort(new ProviderError('cancelled', 'caller cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
        const t0 = now();
        try {
          const messages = attempt === 1 || !request.json ? input.messages : [...input.messages, { role: 'user', content: [{ type: 'text', text: 'Your previous reply was not a valid JSON object. Reply again with only the JSON object.' }] }];
          const res = await p.complete({
            system: input.system,
            messages,
            json: request.json,
            temperature: request.temperature ?? undefined,
            maxTokens: request.max_tokens ?? undefined,
            timeoutMs,
            signal: ctrl.signal,
          });
          if (request.json && !isParseableJson(res.text)) {
            attempts.push({ provider: p.name, model: res.model, status: 'invalid_output', code: 'not_json', latency_ms: now() - t0 });
            await logRun({ provider: p.name, model: res.model, attempt, status: 'invalid_output', errorCode: 'not_json', latencyMs: now() - t0, usage: res.usage, imageCount: input.imageCount, visionUsed: needsVision, task: request.task });
            continue; // one retry on the same provider, then fall back
          }
          ok(p.name);
          attempts.push({ provider: p.name, model: res.model, status: 'ok', latency_ms: now() - t0 });
          await logRun({ provider: p.name, model: res.model, attempt, status: 'ok', latencyMs: now() - t0, usage: res.usage, imageCount: input.imageCount, visionUsed: needsVision, task: request.task });
          lastSuccess = { at: new Date(now()).toISOString(), provider: p.name, model: res.model, task: request.task, vision_used: needsVision };
          return {
            text: res.text,
            provider: p.name,
            model: res.model,
            upstream_request_id: res.requestId || null,
            usage: res.usage || null,
            vision_used: needsVision && p.capabilities.vision,
            image_count: input.imageCount,
            latency_ms: now() - started,
            attempts,
          };
        } catch (err) {
          const code = signal?.aborted ? 'cancelled' : err instanceof ProviderError ? err.code : 'error';
          attempts.push({ provider: p.name, status: 'error', code, latency_ms: now() - t0 });
          await logRun({ provider: p.name, model: p.model, attempt, status: code === 'timeout' ? 'timeout' : 'error', errorCode: code, latencyMs: now() - t0, imageCount: input.imageCount, visionUsed: needsVision, task: request.task });
          if (code === 'cancelled') throw new EngineError('CANCELLED', 'Caller cancelled the request', { attempts });
          if (!['refused', 'bad_request'].includes(code)) fail(p.name);
          break; // next provider
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      }
    }
    lastFailure = { at: new Date(now()).toISOString(), attempts: attempts.length };
    const allNotJson = attempts.length > 0 && attempts.every((a) => a.status === 'invalid_output' || a.status === 'skipped');
    if (now() >= deadline - SAFETY_MARGIN_MS) throw new EngineError('DEADLINE_EXCEEDED', 'Deadline reached before a provider answered', { attempts });
    throw new EngineError(allNotJson ? 'INVALID_MODEL_OUTPUT' : 'PROVIDER_FAILED', 'No provider produced a usable response', { attempts });
  }

  return {
    infer,
    status: () => ({
      providers: providers.map((p) => ({
        name: p.name,
        model: p.model,
        vision: p.capabilities.vision,
        timeout_ms: p.timeoutMs || config.providers.timeoutMs,
        circuit_open: isOpen(p.name),
        consecutive_failures: health.get(p.name)?.failures ?? 0,
      })),
      last_successful_inference: lastSuccess,
      last_failed_inference: lastFailure,
    }),
  };
}
