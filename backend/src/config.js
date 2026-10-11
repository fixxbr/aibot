// Central configuration. Secrets (API keys) are read only here and never sent to clients.

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const config = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: int(env.PORT, 4000),
    databaseUrl: env.DATABASE_URL || null, // null => embedded PGlite (dev/test only)
    pgliteDataDir: env.PGLITE_DATA_DIR || (nodeEnv === 'test' ? null : './data/pglite'),
    seedDemo: bool(env.FIXERA_SEED_DEMO, false),
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    auth: {
      // FixBridge issues the JWT; Fixera only verifies it.
      jwtSecret: env.FIXERA_JWT_SECRET || (nodeEnv === 'production' ? null : 'dev-only-insecure-secret'),
      jwtIssuer: env.FIXERA_JWT_ISSUER || undefined,
      jwtAudience: env.FIXERA_JWT_AUDIENCE || undefined,
    },
    media: {
      driver: env.MEDIA_DRIVER || 'local', // local | s3
      localDir: env.MEDIA_LOCAL_DIR || './data/media',
      maxBytes: int(env.MEDIA_MAX_BYTES, 10 * 1024 * 1024),
      s3: {
        bucket: env.S3_BUCKET,
        region: env.S3_REGION || 'auto',
        endpoint: env.S3_ENDPOINT || undefined, // R2 / MinIO
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    },
    providers: {
      order: (env.FIXERA_PROVIDER_ORDER || 'openrouter,anthropic,openai,gemini').split(',').map((s) => s.trim()).filter(Boolean),
      timeoutMs: int(env.FIXERA_PROVIDER_TIMEOUT_MS, 120_000),
      allowTextOnlyFallback: bool(env.FIXERA_ALLOW_TEXT_ONLY_FALLBACK, false),
      openrouter: { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL, baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1' },
      anthropic: { apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL || undefined, model: env.ANTHROPIC_MODEL || 'claude-opus-5-5', effort: env.ANTHROPIC_EFFORT || 'high', serverFallbacks: bool(env.ANTHROPIC_SERVER_FALLBACKS, true) },
      openai: { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1' },
      gemini: { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta' },
      // USD per million tokens, for cost logging only: {"claude-opus-5-5":{"in":4,"out":20}}
      prices: safeJson(env.FIXERA_MODEL_PRICES, { 'claude-opus-5-5': { in: 4, out: 20 } }),
    },
    embeddings: {
      provider: env.FIXERA_EMBEDDINGS || 'none', // none | openai
      model: env.FIXERA_EMBEDDINGS_MODEL || 'text-embedding-3-small',
    },
    analysis: {
      maxHistoryMessages: int(env.FIXERA_MAX_HISTORY_MESSAGES, 40),
      maxKnowledgeChunks: int(env.FIXERA_MAX_KNOWLEDGE_CHUNKS, 6),
      rateLimitPerHour: int(env.FIXERA_ANALYSIS_RATE_LIMIT_PER_HOUR, 30),
    },
  };
  if (config.isProduction) {
    if (!config.auth.jwtSecret) throw new Error('FIXERA_JWT_SECRET is required in production');
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required in production');
    if (config.media.driver === 'local') throw new Error('MEDIA_DRIVER=s3 (private object storage) is required in production');
  }
  return config;
}

function safeJson(v, d) {
  if (!v) return d;
  try { return JSON.parse(v); } catch { return d; }
}
