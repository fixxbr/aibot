export class ProviderError extends Error {
  /** code: timeout | rate_limited | unavailable | auth | bad_request | refused | invalid_output | network */
  constructor(code, message, { retryable = false, status } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function fromHttpStatus(status, provider) {
  if (status === 401 || status === 403) return new ProviderError('auth', `${provider} rejected credentials`, { status });
  if (status === 429) return new ProviderError('rate_limited', `${provider} rate limited`, { retryable: true, status });
  if (status >= 500) return new ProviderError('unavailable', `${provider} unavailable (${status})`, { retryable: true, status });
  return new ProviderError('bad_request', `${provider} rejected request (${status})`, { status });
}

export async function fetchJson(url, { timeoutMs, signal, provider, ...init }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProviderError('timeout', `${provider} timed out`, { retryable: true })), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.reason instanceof ProviderError) throw controller.signal.reason;
    throw new ProviderError('network', `${provider} network error: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw fromHttpStatus(res.status, provider);
  return res.json();
}

export function parseJsonText(text, provider) {
  if (!text) throw new ProviderError('invalid_output', `${provider} returned no content`);
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ProviderError('invalid_output', `${provider} returned malformed JSON`);
  }
}
