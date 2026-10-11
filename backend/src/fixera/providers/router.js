// Provider router: picks a healthy provider with the required capabilities, enforces a
// timeout, validates output against the schema, retries once on invalid output, then falls
// back to the next compatible provider. Every attempt is recorded in fixera_provider_runs.

import { ProviderError } from './errors.js';

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

export class NoProviderAvailableError extends Error {
  constructor(message, attempts) {
    super(message);
    this.code = 'no_provider_available';
    this.attempts = attempts;
  }
}

export function createProviderRouter({ db, providers, config, now = () => Date.now() }) {
  const health = new Map(); // name -> { failures, openUntil }

  const isOpen = (name) => (health.get(name)?.openUntil ?? 0) > now();
  const recordSuccess = (name) => health.set(name, { failures: 0, openUntil: 0 });
  const recordFailure = (name) => {
    const h = health.get(name) || { failures: 0, openUntil: 0 };
    h.failures += 1;
    if (h.failures >= BREAKER_THRESHOLD) h.openUntil = now() + BREAKER_COOLDOWN_MS;
    health.set(name, h);
  };

  async function loadOverrides() {
    const { rows } = await db.query('SELECT provider, enabled, priority, model, timeout_ms FROM fixera_provider_config');
    return new Map(rows.map((r) => [r.provider, r]));
  }

  async function candidates() {
    const overrides = await loadOverrides();
    return providers
      .map((p, i) => {
        const o = overrides.get(p.name);
        return { provider: p, enabled: o ? o.enabled : true, priority: o?.priority ?? (i + 1) * 10, model: o?.model || p.model, timeoutMs: o?.timeout_ms || config.providers.timeoutMs };
      })
      .filter((c) => c.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  async function logRun(row) {
    const { rows } = await db.query(
      `INSERT INTO fixera_provider_runs
         (case_id, task, provider, model, attempt, status, error_code, latency_ms, input_tokens, output_tokens,
          cost_usd_micros, image_count, vision_used, validation, prompt_version, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [row.caseId, row.task, row.provider, row.model, row.attempt, row.status, row.errorCode || null, row.latencyMs ?? null,
        row.usage?.input_tokens ?? null, row.usage?.output_tokens ?? null, costMicros(config, row.model, row.usage), row.imageCount,
        row.visionUsed, row.validation || null, row.promptVersion || null, row.policyVersion || null],
    );
    return rows[0].id;
  }

  /**
   * @param {object} req
   * @param {string} req.task
   * @param {string|null} req.caseId
   * @param {string} req.system
   * @param {Function} req.buildMessages (includeImages: boolean) => messages
   * @param {number} req.imageCount
   * @param {import('zod/v4').ZodType} req.schema
   * @param {object} req.jsonSchema
   */
  async function run(req) {
    const needsVision = req.imageCount > 0;
    const attempts = [];
    const list = await candidates();
    if (!list.length) throw new NoProviderAvailableError('No AI provider is configured', attempts);

    // Prefer vision-capable providers; text-only providers are used for image cases only when
    // explicitly allowed, and then the result is marked as not visually analyzed.
    const ordered = needsVision
      ? [...list.filter((c) => c.provider.capabilities.vision), ...(config.providers.allowTextOnlyFallback ? list.filter((c) => !c.provider.capabilities.vision) : [])]
      : list;

    for (const c of list) {
      if (!ordered.includes(c)) {
        attempts.push({ provider: c.provider.name, status: 'skipped', reason: 'no_vision' });
        await logRun({ ...req, provider: c.provider.name, model: c.model, attempt: 0, status: 'skipped', errorCode: 'no_vision', imageCount: req.imageCount, visionUsed: false });
      }
    }

    for (const c of ordered) {
      const name = c.provider.name;
      if (isOpen(name)) {
        attempts.push({ provider: name, status: 'skipped', reason: 'circuit_open' });
        continue;
      }
      const useImages = needsVision && c.provider.capabilities.vision;
      const messages = req.buildMessages(useImages);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const started = now();
        try {
          const res = await c.provider.generate({
            system: req.system,
            messages: attempt === 1 ? messages : [...messages, retryNudge()],
            schema: req.schema,
            jsonSchema: req.jsonSchema,
            timeoutMs: c.timeoutMs,
            model: c.model,
          });
          const parsed = req.schema.safeParse(res.output);
          if (!parsed.success) {
            const runId = await logRun({ ...req, provider: name, model: res.model || c.model, attempt, status: 'invalid_output', errorCode: 'schema_mismatch', latencyMs: now() - started, usage: res.usage, imageCount: req.imageCount, visionUsed: useImages, validation: summarizeIssues(parsed.error) });
            attempts.push({ provider: name, status: 'invalid_output', runId });
            continue; // one retry on the same provider, then fall back
          }
          const runId = await logRun({ ...req, provider: name, model: res.model || c.model, attempt, status: 'ok', latencyMs: now() - started, usage: res.usage, imageCount: req.imageCount, visionUsed: useImages, validation: 'schema_ok' });
          recordSuccess(name);
          return { output: parsed.data, provider: name, model: res.model || c.model, runId, visionUsed: useImages, attempts };
        } catch (err) {
          const code = err instanceof ProviderError ? err.code : 'error';
          const runId = await logRun({ ...req, provider: name, model: c.model, attempt, status: code === 'timeout' ? 'timeout' : code === 'refused' ? 'refused' : 'error', errorCode: code, latencyMs: now() - started, imageCount: req.imageCount, visionUsed: useImages });
          attempts.push({ provider: name, status: code, runId });
          if (code === 'invalid_output' && attempt === 1) continue;
          if (!['refused', 'bad_request', 'invalid_output'].includes(code)) recordFailure(name);
          break; // move on to the next provider
        }
      }
    }
    throw new NoProviderAvailableError('No provider produced a valid assessment', attempts);
  }

  return { run, health: () => Object.fromEntries(providers.map((p) => [p.name, { model: p.model, vision: p.capabilities.vision, circuitOpen: isOpen(p.name), failures: health.get(p.name)?.failures ?? 0 }])) };
}

function retryNudge() {
  return { role: 'user', content: [{ type: 'text', text: 'Your previous response did not match the required JSON schema. Respond again with only a valid JSON object that matches the schema exactly.' }] };
}

function summarizeIssues(error) {
  return error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500);
}

function costMicros(config, model, usage) {
  const price = config.providers.prices?.[model];
  if (!price || !usage) return null;
  const usd = ((usage.input_tokens || 0) * price.in + (usage.output_tokens || 0) * price.out) / 1_000_000;
  return Math.round(usd * 1_000_000);
}
