import pino from 'pino';

// Addresses, descriptions, prompts and model output never go to logs. Log identifiers instead.
export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: ['req.headers.authorization', '*.apiKey', '*.address_line1', '*.description', '*.content', '*.prompt', 'apiKey'],
    censor: '[redacted]',
  },
});
