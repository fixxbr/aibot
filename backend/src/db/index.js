// Thin database wrapper so the same code runs on node-postgres (Neon in production)
// and on embedded PGlite (local development and tests).

export async function createDb(config) {
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool(poolOptions(config.databaseUrl));
    pool.on('error', () => {}); // idle-client drops (Neon scale-to-zero) are recovered on next query
    return {
      kind: 'pg',
      query: (text, params) => pool.query(text, params),
      exec: (sql) => pool.query(sql), // multi-statement script, no parameters
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: (t, p) => client.query(t, p) });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  if (config.pgliteDataDir) (await import('node:fs')).mkdirSync(config.pgliteDataDir, { recursive: true });
  const extensions = {};
  try {
    const { vector } = await import('@electric-sql/pglite-pgvector');
    extensions.vector = vector;
  } catch {
    // pgvector is optional; full-text retrieval still works.
  }
  const db = new PGlite({ dataDir: config.pgliteDataDir || undefined, extensions });
  await db.waitReady;
  // PGlite runs one query at a time; serialize transactions explicitly.
  let chain = Promise.resolve();
  return {
    kind: 'pglite',
    query: (text, params) => db.query(text, params),
    tx(fn) {
      const run = chain.then(() => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })));
      chain = run.catch(() => {});
      return run;
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

// Neon connection strings use sslmode=require&channel_binding=require. node-postgres already
// verifies certificates for sslmode=require; spell it verify-full to keep that behaviour without
// the deprecation warning, and turn on SCRAM channel binding when requested.
export function poolOptions(databaseUrl) {
  const url = new URL(databaseUrl);
  const binding = url.searchParams.get('channel_binding');
  url.searchParams.delete('channel_binding');
  if (url.searchParams.get('sslmode') === 'require') url.searchParams.set('sslmode', 'verify-full');
  return { connectionString: url.toString(), max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000, enableChannelBinding: binding === 'require' };
}
