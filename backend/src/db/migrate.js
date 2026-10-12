import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db, log = () => {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS fixera_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query('SELECT name FROM fixera_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const result = { applied: [], skipped: [] };
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const ext = sql.match(/@requires-extension\s+(\w+)/)?.[1];
    if (ext && !(await extensionAvailable(db, ext))) {
      result.skipped.push(file);
      log(`migration ${file} skipped: extension ${ext} unavailable`);
      continue;
    }
    if (file === '001_core.sql') await assertCompatibleSchema(db);
    await runScript(db, sql);
    await db.query('INSERT INTO fixera_migrations (name) VALUES ($1)', [file]);
    result.applied.push(file);
    log(`migration ${file} applied`);
  }
  return result;
}

// 001_core.sql creates standalone versions of users/properties/... only if they are missing.
// If an existing FixBridge database already has differently-shaped tables, stop with a clear
// message instead of failing halfway through.
const EXPECTED = {
  users: { id: 'text', role: 'text' },
  properties: { id: 'uuid', owner_user_id: 'text', zip: 'text' },
  service_categories: { slug: 'text' },
  subscriptions: { user_id: 'text', plan: 'text', status: 'text' },
  service_requests: { id: 'uuid', property_id: 'uuid', customer_id: 'text' },
};
async function assertCompatibleSchema(db) {
  const { rows } = await db.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [Object.keys(EXPECTED)],
  );
  const problems = [];
  for (const [table, cols] of Object.entries(EXPECTED)) {
    const have = rows.filter((r) => r.table_name === table);
    if (!have.length) continue; // will be created
    for (const [col, type] of Object.entries(cols)) {
      const c = have.find((r) => r.column_name === col);
      if (!c) problems.push(`${table}.${col} is missing`);
      else if (c.data_type !== type) problems.push(`${table}.${col} is ${c.data_type}, Fixera expects ${type}`);
    }
  }
  if (problems.length) {
    throw new Error(
      `This database already has tables that Fixera's standalone schema does not match (${problems.join('; ')}). ` +
        'Use a separate Neon database for Fixera (e.g. create a database named "fixera" in the same Neon project), ' +
        'or adapt 001_core.sql and src/platform to your existing tables.',
    );
  }
}

async function extensionAvailable(db, name) {
  if (!/^\w+$/.test(name)) return false;
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS ${name}`);
    return true;
  } catch {
    return false; // not installed or not permitted on this database
  }
}

async function runScript(db, sql) {
  if (db.exec) return db.exec(sql);
  return db.query(sql); // node-postgres accepts multi-statement text without parameters
}

export async function hasVectorSupport(db) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'`,
  );
  return rows.length > 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../config.js');
  const { createDb } = await import('./index.js');
  const db = await createDb(loadConfig());
  const r = await migrate(db, console.log);
  console.log(JSON.stringify(r));
  await db.close();
}
