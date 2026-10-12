// Idempotency + durable job records. A request is identified by its Idempotency-Key:
//  - same key, same body, finished   -> stored response is replayed (no second model call)
//  - same key, same body, running    -> caller can wait for it (sync) or poll (async)
//  - same key, different body        -> IDEMPOTENCY_KEY_REUSED
//  - same key after a failure        -> runs again
// Memory store by default; Postgres store when FIXERA_ENGINE_DATABASE_URL is set (the
// engine's own database, never FixBridge's). Prompts and images are never stored.

const TERMINAL = new Set(['succeeded', 'failed']);

export function createMemoryStore({ maxEntries = 5000, now = () => Date.now() } = {}) {
  const map = new Map();
  const prune = () => {
    const t = now();
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k);
    while (map.size > maxEntries) map.delete(map.keys().next().value);
  };
  return {
    kind: 'memory',
    async begin(key, hash, ttlS) {
      prune();
      const cur = map.get(key);
      if (cur && cur.hash !== hash) return { state: 'conflict' };
      if (cur && cur.status === 'running') return { state: 'running', record: cur };
      if (cur && cur.status === 'succeeded') return { state: 'replay', record: cur };
      const rec = { key, hash, status: 'running', response: null, httpStatus: null, createdAt: now(), expiresAt: now() + ttlS * 1000 };
      map.set(key, rec);
      return { state: 'new', record: rec };
    },
    async finish(key, status, httpStatus, response) {
      const rec = map.get(key);
      if (rec) Object.assign(rec, { status, httpStatus, response, finishedAt: now() });
    },
    async get(key) {
      prune();
      return map.get(key) || null;
    },
    async recoverInterrupted() {
      return 0;
    },
  };
}

export async function createPgStore(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS fixera_engine_requests (
    idem_key     TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    status       TEXT NOT NULL,
    http_status  INTEGER,
    response     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ NOT NULL
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS fixera_engine_requests_expires_idx ON fixera_engine_requests(expires_at)');
  const row = (r) => r && { key: r.idem_key, hash: r.request_hash, status: r.status, httpStatus: r.http_status, response: r.response, createdAt: r.created_at, finishedAt: r.finished_at };
  return {
    kind: 'postgres',
    async begin(key, hash, ttlS) {
      await db.query('DELETE FROM fixera_engine_requests WHERE expires_at < now()');
      // Insert, or take over a failed/expired record; a live record is returned unchanged.
      const { rows } = await db.query(
        `INSERT INTO fixera_engine_requests (idem_key, request_hash, status, expires_at)
         VALUES ($1, $2, 'running', now() + make_interval(secs => $3))
         ON CONFLICT (idem_key) DO UPDATE SET status = 'running', response = NULL, http_status = NULL, finished_at = NULL,
           created_at = now(), expires_at = now() + make_interval(secs => $3)
           WHERE fixera_engine_requests.status = 'failed' AND fixera_engine_requests.request_hash = $2
         RETURNING *, (xmax = 0) AS inserted`,
        [key, hash, ttlS],
      );
      if (rows[0]) return { state: 'new', record: row(rows[0]) };
      const cur = row((await db.query('SELECT * FROM fixera_engine_requests WHERE idem_key = $1', [key])).rows[0]);
      if (!cur) return this.begin(key, hash, ttlS);
      if (cur.hash !== hash) return { state: 'conflict' };
      return { state: cur.status === 'running' ? 'running' : 'replay', record: cur };
    },
    async finish(key, status, httpStatus, response) {
      await db.query(
        `UPDATE fixera_engine_requests SET status = $2, http_status = $3, response = $4::jsonb, finished_at = now() WHERE idem_key = $1`,
        [key, status, httpStatus, JSON.stringify(response)],
      );
    },
    async get(key) {
      return row((await db.query('SELECT * FROM fixera_engine_requests WHERE idem_key = $1 AND expires_at > now()', [key])).rows[0]);
    },
    // Records left running by a crash become retryable failures.
    async recoverInterrupted() {
      const { rows } = await db.query(
        `UPDATE fixera_engine_requests SET status = 'failed', http_status = 502,
           response = '{"ok":false,"code":"PROVIDER_FAILED","message":"Engine restarted during this request","retryable":true}'::jsonb, finished_at = now()
         WHERE status = 'running' RETURNING idem_key`,
      );
      return rows.length;
    },
  };
}

export const isTerminal = (status) => TERMINAL.has(status);
