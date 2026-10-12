// Fixera Engine wire contract (server-to-server). FixBridge's api/ai.js adapter is the only
// intended client. Versioned so either side can change without silent breakage.

import { createHash } from 'node:crypto';
import * as z from 'zod/v4';

export const CONTRACT_VERSION = '2026-10-01';
export const SUPPORTED_CONTRACTS = [CONTRACT_VERSION];

// code -> HTTP status. Codes are stable; clients branch on `code`, not on message text.
export const ERRORS = {
  INVALID_REQUEST: 400,
  INVALID_IMAGE: 400,
  TOO_MANY_IMAGES: 400,
  IMAGE_TOO_LARGE: 413,
  UNSUPPORTED_CONTRACT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  CANCELLED: 499,
  PROVIDER_FAILED: 502,
  INVALID_MODEL_OUTPUT: 502,
  NO_PROVIDER_CONFIGURED: 503,
  NO_VISION_PROVIDER: 503,
  DEADLINE_EXCEEDED: 504,
  INTERNAL_ERROR: 500,
};
const RETRYABLE = new Set(['RATE_LIMITED', 'PROVIDER_FAILED', 'INVALID_MODEL_OUTPUT', 'DEADLINE_EXCEEDED', 'IN_PROGRESS', 'INTERNAL_ERROR']);

export class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = ERRORS[code] || 500;
    this.retryable = RETRYABLE.has(code);
    Object.assign(this, extra);
  }
}

const Part = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.union([z.string(), z.object({ url: z.string(), detail: z.string().optional() })]) }),
]);
const Message = z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.union([z.string(), z.array(Part).min(1)]) });

export const InferRequest = z.object({
  contract_version: z.string(),
  task: z.enum(['assessment', 'chat', 'extract', 'second_opinion', 'other']).default('other'),
  messages: z.array(Message).min(1).max(200),
  json: z.boolean().default(false),
  temperature: z.number().min(0).max(2).nullable().optional(),
  max_tokens: z.number().int().min(1).max(64000).nullable().optional(),
  // Total budget for the whole call including retries and fallbacks.
  deadline_ms: z.number().int().min(1000).max(600_000).optional(),
  require_vision: z.boolean().optional(),
  preferred_provider: z.string().max(40).nullable().optional(),
  idempotency_ttl_s: z.number().int().min(10).max(7 * 24 * 3600).optional(),
  // Opaque correlation fields. Logged as given; never interpreted.
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

const MIME = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Validates one image data URL with the same rules as FixBridge's repair-photos.js, plus a byte check. */
export function parseImageDataUrl(url, { maxChars, index }) {
  if (typeof url !== 'string' || !url.startsWith('data:')) throw new EngineError('INVALID_IMAGE', `Image ${index + 1} must be a base64 data URL`);
  if (url.length > maxChars) throw new EngineError('IMAGE_TOO_LARGE', `Image ${index + 1} exceeds ${maxChars} characters`);
  const m = url.match(/^data:([a-z/+.-]+);base64,(.*)$/is);
  const mime = m && MIME[m[1].toLowerCase()];
  if (!mime) throw new EngineError('INVALID_IMAGE', `Image ${index + 1} must be JPEG, PNG or WEBP`);
  const data = m[2];
  if (!data || data.length % 4 !== 0 || !B64.test(data)) throw new EngineError('INVALID_IMAGE', `Image ${index + 1} is not valid base64`);
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new EngineError('INVALID_IMAGE', `Image ${index + 1} is empty`);
  const actual = sniff(bytes);
  if (actual !== mime) throw new EngineError('INVALID_IMAGE', `Image ${index + 1} content is not ${mime}`);
  return { type: 'image', mediaType: mime, data };
}

/**
 * OpenAI-style messages (what FixBridge's api/ai.js already builds) -> provider-neutral form.
 * System messages are joined into one system prompt; images are allowed in user turns only.
 */
export function normalizeMessages(messages, { maxImages, maxImageChars }) {
  const system = [];
  const out = [];
  let imageCount = 0;
  for (const msg of messages) {
    const parts = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
    if (msg.role === 'system') {
      if (parts.some((p) => p.type !== 'text')) throw new EngineError('INVALID_REQUEST', 'System messages must be text');
      system.push(parts.map((p) => p.text).join('\n'));
      continue;
    }
    const content = parts.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      if (msg.role !== 'user') throw new EngineError('INVALID_REQUEST', 'Images are only accepted in user messages');
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
      const img = parseImageDataUrl(url, { maxChars: maxImageChars, index: imageCount });
      imageCount += 1;
      if (imageCount > maxImages) throw new EngineError('TOO_MANY_IMAGES', `At most ${maxImages} images per request`);
      return img;
    });
    out.push({ role: msg.role, content });
  }
  if (!out.length) throw new EngineError('INVALID_REQUEST', 'At least one user or assistant message is required');
  if (out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] });
  return { system: system.join('\n\n') || undefined, messages: out, imageCount };
}

/** Stable hash of everything that affects the model output; used for idempotency conflict checks. */
export function requestHash(req) {
  const { contract_version, task, messages, json, temperature, max_tokens, require_vision, preferred_provider } = req;
  return createHash('sha256').update(JSON.stringify({ contract_version, task, messages, json, temperature, max_tokens, require_vision, preferred_provider })).digest('hex');
}

/** Lenient JSON check matching what FixBridge's parser tolerates (code fences). */
export function isParseableJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === 'object';
  } catch {
    return false;
  }
}
