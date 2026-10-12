// Server-to-server authentication: HMAC-SHA256 over "<timestamp>.<raw body>".
// Separate from FixBridge's SESSION_SECRET; browsers never call the engine.
//
//   X-Fixera-Timestamp: <unix ms>
//   X-Fixera-Signature: v1=<hex hmac>
//
// FIXERA_ENGINE_SECRETS may list several comma-separated secrets for zero-downtime rotation.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { EngineError } from './contract.js';

export const MAX_SKEW_MS = 5 * 60 * 1000;

export function sign(secret, timestamp, rawBody) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function verifyRequest({ secrets, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secrets.length) throw new EngineError('UNAUTHORIZED', 'Engine has no signing secret configured');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) throw new EngineError('UNAUTHORIZED', 'Missing or stale timestamp');
  if (typeof signature !== 'string' || !signature.startsWith('v1=')) throw new EngineError('UNAUTHORIZED', 'Missing signature');
  const given = Buffer.from(signature);
  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, ts, rawBody));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  throw new EngineError('UNAUTHORIZED', 'Invalid signature');
}

/** Express middleware. Requires the raw body captured by express.json({ verify }). */
export function requireSignature(secrets) {
  return (req, res, next) => {
    try {
      verifyRequest({ secrets, timestamp: req.get('x-fixera-timestamp'), signature: req.get('x-fixera-signature'), rawBody: req.rawBody ?? '' });
      next();
    } catch (err) {
      next(err);
    }
  };
}
