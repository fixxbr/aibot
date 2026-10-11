// Thin database wrapper so the same code runs on node-postgres (Neon in production)
// and on embedded PGlite (local development and tests).

export async function createDb(config) {
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    return {
      kind: 'pg',
      query: (text, params) => pool.query(text, params),
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
