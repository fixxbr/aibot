// Setup check: `npm run check`
// 1. Connects to DATABASE_URL (Neon), applies migrations, reports pgvector.
// 2. Sends ONE small real request per configured AI provider with a generated test image and
//    the full Fixera output schema, proving the key, the model name, vision and structured
//    output all work. Each call costs a fraction of a cent to a few cents.

import { deflateSync } from 'node:zlib';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { hasVectorSupport, migrate } from '../db/migrate.js';
import { createProvidersFromConfig, providerConfigWarnings } from '../fixera/providers/registry.js';
import { ModelAssessment, modelAssessmentJsonSchema } from '../fixera/reasoning/schemas.js';

const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✘\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
let failures = 0;

const config = loadConfig({ ...process.env, NODE_ENV: process.env.NODE_ENV === 'production' ? 'development' : process.env.NODE_ENV });

console.log('\nDatabase');
if (!config.databaseUrl) {
  warn('DATABASE_URL is empty: using the embedded development database. Set it to your Neon connection string.');
} else {
  let db;
  try {
    db = await createDb(config);
    const { rows } = await db.query('SELECT version() AS v, current_database() AS d');
    ok(`Connected to "${rows[0].d}" (${rows[0].v.split(' on ')[0]})`);
    const r = await migrate(db);
    ok(r.applied.length ? `Applied migrations: ${r.applied.join(', ')}` : 'Migrations already up to date');
    if (await hasVectorSupport(db)) ok('pgvector enabled (semantic Knowledge Base search available)');
    else warn('pgvector not enabled: Knowledge Base uses full-text search only');
    const { rows: t } = await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'fixera_%'`);
    ok(`${t[0].n} Fixera tables present`);
  } catch (err) {
    failures++;
    bad(`Database check failed: ${err.message}`);
    if (/password authentication|SASL/i.test(err.message)) warn('Check the user and password in DATABASE_URL (Neon > Connection Details).');
    if (/ENOTFOUND|getaddrinfo/i.test(err.message)) warn('Host not found. Copy the full connection string from the Neon dashboard.');
  } finally {
    await db?.close();
  }
}

console.log('\nAI providers');
for (const w of providerConfigWarnings(config)) warn(w);
const providers = createProvidersFromConfig(config);
const image = testImage();
for (const p of providers) {
  const started = Date.now();
  try {
    const res = await p.generate({
      system: 'You are a connectivity test for a home-repair assistant. Fill every field of the schema with short placeholder values. In image_findings, report on photo_1 and state its dominant colours in "shows".',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Setup test. The homeowner says: "This is a test photo, there is no real problem." photo_1:' },
        { type: 'image', mediaType: 'image/png', data: image.toString('base64'), label: 'photo_1' },
      ] }],
      schema: ModelAssessment,
      jsonSchema: modelAssessmentJsonSchema(),
      timeoutMs: 120_000,
    });
    const parsed = ModelAssessment.safeParse(res.output);
    if (!parsed.success) {
      failures++;
      bad(`${p.name} (${res.model}): replied, but the output did not match Fixera's schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      continue;
    }
    const seen = parsed.data.image_findings.map((f) => f.shows).join(' ');
    const sawImage = /red|blue/i.test(seen);
    ok(`${p.name} (${res.model}): valid structured output in ${((Date.now() - started) / 1000).toFixed(1)}s, ${res.usage.input_tokens ?? '?'} in / ${res.usage.output_tokens ?? '?'} out tokens`);
    if (sawImage) ok(`${p.name}: can see photos ("${seen.slice(0, 80)}")`);
    else warn(`${p.name}: did not describe the test image's colours ("${seen.slice(0, 80)}"). Make sure the model is vision-capable.`);
  } catch (err) {
    failures++;
    bad(`${p.name} (${p.model}): ${err.code || 'error'}: ${err.message}`);
    if (err.code === 'auth') warn('The API key was rejected. Check for extra spaces or an expired key.');
    if (err.code === 'bad_request') warn('The provider rejected the request. The model name is often the cause: check it is spelled exactly as the provider lists it and supports images.');
  }
}
if (!providers.length) failures++;

console.log(failures ? `\n${failures} problem(s) found.\n` : '\nAll checks passed. Fixera is ready.\n');
process.exit(failures ? 1 : 0);

// 256x256 PNG: red background with a blue square in the middle.
function testImage(size = 256) {
  const row = (y) => {
    const r = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inner = x > size / 4 && x < (3 * size) / 4 && y > size / 4 && y < (3 * size) / 4;
      r.set(inner ? [30, 60, 220] : [220, 30, 30], 1 + x * 3);
    }
    return r;
  };
  const raw = Buffer.concat(Array.from({ length: size }, (_, y) => row(y)));
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
