// Seeds local demo data and prints dev tokens. Stop the dev server first when using the
// embedded database (one process per data directory), or set FIXERA_SEED_DEMO=true instead.
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemo } from '../src/dev/seedDemo.js';

const config = loadConfig();
const db = await createDb(config);
await migrate(db);
const tokens = await seedDemo(db, config);
console.log('\nDemo data ready. Dev tokens (valid 30 days, local only):\n');
for (const [user, token] of Object.entries(tokens)) console.log(`${user}:\n  ${token}\n`);
await db.close();
