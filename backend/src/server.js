import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createStorage } from './fixera/media/storage.js';
import { createApp, createFixera } from './app.js';
import { logger } from './logger.js';

const config = loadConfig();
const db = await createDb(config);
await migrate(db, (m) => logger.info(m));
const storage = await createStorage(config);
const fixera = createFixera({ db, config, storage });

const recovered = await fixera.orchestrator.recoverInterrupted();
if (recovered) logger.warn({ recovered }, 'marked interrupted analyses as recoverable failures');

const providers = Object.keys(fixera.router.health());
if (!providers.length) logger.warn('No AI provider configured: analysis requests will fail with a recoverable error. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.');

const server = createApp(fixera).listen(config.port, () => logger.info({ port: config.port, providers, db: db.kind }, 'Fixera Core listening'));

const shutdown = async () => {
  server.close();
  await fixera.orchestrator.waitAll();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
