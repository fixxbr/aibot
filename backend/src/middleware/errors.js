import { logger } from '../logger.js';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this resource') => new HttpError(403, 'forbidden', message);
// Used for resources the caller may not see: do not reveal whether they exist.
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message, details) => new HttpError(409, 'conflict', message, details);
export const paymentRequired = (message) => new HttpError(402, 'subscription_required', message);

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parseBody(schema, body) {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw badRequest('Invalid request', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return parsed.data;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' ? 413 : 400;
    return res.status(status).json({ error: { code: err.code.toLowerCase(), message: err.message } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body' } });
  }
  logger.error({ err: { message: err?.message, stack: err?.stack }, path: req.path }, 'unhandled error');
  return res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
}
