// Fixera Engine entry point: `npm run start:engine`.
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { logger } from '../logger.js';
import { createProvidersFromConfig, providerConfigWarnings } from '../fixera/providers/registry.js';
import { createEngineApp } from './app.js';
import { createGateway } from './gateway.js';
import { createMemoryStore, createPgStore } from './store.js';

const config = loadConfig({ ...process.env, NODE_ENV: process.env.NODE_ENV === 'production' ? 'engine' : process.env.NODE_ENV });
if (!config.engine.commit) {
  try {
    config.engine.commit = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    config.engine.commit = 'unknown';
  }
}
if (!config.engine.secrets.length) {
  logger.error('FIXERA_ENGINE_SECRET is not set: every signed endpoint will reject requests.');
}
for (const w of providerConfigWarnings(config)) logger.warn(w);

let store = createMemoryStore();
let dbInfo = async () => ({ configured: false, note: 'Idempotency and async jobs are in memory (lost on restart). Set FIXERA_ENGINE_DATABASE_URL for durability.' });
if (config.engine.databaseUrl) {
  const db = await createDb({ ...config, databaseUrl: config.engine.databaseUrl });
  store = await createPgStore(db);
  const recovered = await store.recoverInterrupted();
  if (recovered) logger.warn({ recovered }, 'marked interrupted engine requests as failed (retryable)');
  dbInfo = () => describeDatabase(db, config.engine.databaseUrl);
}

const gateway = createGateway({ providers: createProvidersFromConfig(config), config });
const port = Number(process.env.FIXERA_ENGINE_PORT || process.env.PORT || 4100);
createEngineApp({ config, gateway, store, dbInfo }).listen(port, '0.0.0.0', () => {
  logger.info({ port, commit: config.engine.commit, providers: gateway.status().providers.map((p) => `${p.name}:${p.model}`), store: store.kind }, 'Fixera Engine listening');
});

// Reports what can be observed about the database, labelled as evidence rather than a claim.
async function describeDatabase(db, url) {
  try {
    const host = new URL(url).hostname;
    const { rows } = await db.query(`SELECT current_setting('server_version') AS v, current_setting('neon.timeline_id', true) AS neon_timeline`);
    const evidence = [];
    if (/\.neon\.tech$/i.test(host)) evidence.push('hostname ends with .neon.tech');
    if (rows[0].neon_timeline) evidence.push('server exposes neon.timeline_id setting');
    return { configured: true, connected: true, server_version: rows[0].v, host, vendor_evidence: evidence, vendor_verified: evidence.length === 2 };
  } catch (err) {
    return { configured: true, connected: false, error: err.message };
  }
}
