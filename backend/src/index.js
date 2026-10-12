// Public entry point for embedding Fixera Core in the FixBridge backend.
//
//   import { initFixera } from 'fixera-core';
//   const fixera = await initFixera({
//     env: process.env,
//     authenticate: async (req) => req.user && { id: req.user.id, role: req.user.role }, // existing FixBridge session
//   });
//   app.use('/api/fixera', fixera.router);

import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createStorage } from './fixera/media/storage.js';
import { createPlatformAdapter } from './platform/index.js';
import { createApp, createFixera, createFixeraRouter } from './app.js';
import { createSync } from './platform/sync.js';

export { loadConfig, createDb, migrate, createStorage, createPlatformAdapter, createFixera, createFixeraRouter, createApp, createSync };

/**
 * One-call setup for a host Express app. Pass `db` to share FixBridge's own database wrapper
 * ({ query, tx }), or omit it to connect with DATABASE_URL. `platform` overrides individual
 * adapter methods (entitlements, dispatch fee, service request creation).
 */
export async function initFixera({ env = process.env, db, authenticate, platform = {}, runMigrations = true } = {}) {
  const config = loadConfig(env);
  db ||= await createDb(config);
  if (runMigrations) await migrate(db);
  const storage = await createStorage(config);
  const adapter = { ...createPlatformAdapter({ db, config, authenticate }), ...platform };
  const fixera = createFixera({ db, config, storage, platform: adapter });
  await fixera.orchestrator.recoverInterrupted();
  return { ...fixera, router: createFixeraRouter(fixera), sync: createSync({ db }) };
}
