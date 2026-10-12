// Central configuration. Secrets (API keys) are read only here and never sent to clients.

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const config = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: int(env.PORT, 4000),
    // NEON_DATABASE_URL takes precedence, matching FixBridge. null => embedded PGlite (dev/test only).
    databaseUrl: env.NEON_DATABASE_URL || env.DATABASE_URL || null,
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
      // Same default order as FixBridge's resolver; FIXERA_AI_PROVIDER / AI_PRIMARY_PROVIDER moves one to the front.
      order: providerOrder(env),
      timeoutMs: int(env.FIXERA_PROVIDER_TIMEOUT_MS, 120_000),
      allowTextOnlyFallback: bool(env.FIXERA_ALLOW_TEXT_ONLY_FALLBACK, false),
      openrouter: { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || (env.OPENROUTER_API_KEY ? 'openrouter/free' : undefined), baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', timeoutMs: int(env.OPENROUTER_TIMEOUT_MS, undefined) },
      anthropic: { apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL || undefined, timeoutMs: int(env.ANTHROPIC_TIMEOUT_MS, undefined), model: env.ANTHROPIC_MODEL || 'claude-opus-5-5', effort: env.ANTHROPIC_EFFORT || 'high', serverFallbacks: bool(env.ANTHROPIC_SERVER_FALLBACKS, true) },
      openai: { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || (env.OPENAI_API_KEY ? 'gpt-4.1-mini' : undefined), baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', timeoutMs: int(env.OPENAI_TIMEOUT_MS, undefined) },
      gemini: {
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_API_KEY,
        model: env.GEMINI_MODEL || (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_API_KEY ? 'gemini-2.5-flash' : undefined),
        baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
        timeoutMs: int(env.GEMINI_TIMEOUT_MS, undefined),
      },
      // USD per million tokens, for cost logging only: {"claude-opus-5-5":{"in":4,"out":20}}
      prices: safeJson(env.FIXERA_MODEL_PRICES, { 'claude-opus-5-5': { in: 4, out: 20 } }),
    },
    embeddings: {
      provider: env.FIXERA_EMBEDDINGS || 'none', // none | openai
      model: env.FIXERA_EMBEDDINGS_MODEL || 'text-embedding-3-small',
    },
    engine: {
      // Signing secrets shared only with FixBridge's server (comma-separated for rotation).
      secrets: (env.FIXERA_ENGINE_SECRETS || env.FIXERA_ENGINE_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean),
      // The engine's own optional database for durable idempotency/jobs. Deliberately NOT
      // DATABASE_URL / NEON_DATABASE_URL: the engine never gets FixBridge's database.
      databaseUrl: env.FIXERA_ENGINE_DATABASE_URL || null,
      defaultDeadlineMs: int(env.FIXERA_ENGINE_DEFAULT_DEADLINE_MS, 35_000),
      maxDeadlineMs: int(env.FIXERA_ENGINE_MAX_DEADLINE_MS, 300_000),
      maxImages: int(env.FIXERA_ENGINE_MAX_IMAGES, 6),
      maxImageChars: int(env.AI_MAX_IMAGE_CHARS || env.FIXERA_ENGINE_MAX_IMAGE_CHARS, 700_000),
      bodyLimit: env.FIXERA_ENGINE_BODY_LIMIT || env.JSON_BODY_LIMIT || '20mb',
      rateLimitPerMinute: int(env.FIXERA_ENGINE_RATE_LIMIT_PER_MINUTE, 120),
      idempotencyTtlS: int(env.FIXERA_ENGINE_IDEMPOTENCY_TTL_S, 24 * 3600),
      commit: env.FIXERA_ENGINE_COMMIT || env.RAILWAY_GIT_COMMIT_SHA || env.COMMIT_REF || env.SOURCE_COMMIT || null,
    },
    analysis: {
      maxHistoryMessages: int(env.FIXERA_MAX_HISTORY_MESSAGES, 40),
      maxKnowledgeChunks: int(env.FIXERA_MAX_KNOWLEDGE_CHUNKS, 6),
      rateLimitPerHour: int(env.FIXERA_ANALYSIS_RATE_LIMIT_PER_HOUR, 30),
    },
  };
  if (nodeEnv === 'engine') config.isProduction = true;
  if (config.isProduction && nodeEnv !== 'engine') {
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

const KNOWN_PROVIDERS = ['gemini', 'openrouter', 'anthropic', 'openai'];
function providerOrder(env) {
  let order = (env.FIXERA_PROVIDER_ORDER || KNOWN_PROVIDERS.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const preferred = String(env.FIXERA_AI_PROVIDER || env.AI_PRIMARY_PROVIDER || '').trim().toLowerCase();
  if (KNOWN_PROVIDERS.includes(preferred)) order = [preferred, ...order.filter((p) => p !== preferred)];
  return order;
}
