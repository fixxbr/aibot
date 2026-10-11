// Acceptance scenarios for the AI analysis pipeline (guide sections 23 and 27).
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCase, createTestEnv, failingProvider, modelOutput, png, promptImages, promptText, scriptedProvider, seed, tokenFor, uploadPhotos } from './helpers.js';

let env, ids;
// Each test swaps in its own behaviour through `script`.
let script = () => modelOutput();
const primary = scriptedProvider({ name: 'primary', handler: (req, n) => script(req, n) });

before(async () => {
  env = await createTestEnv({ providers: [primary] });
  ids = await seed(env.db);
});

const auth = (u = 'u_alice') => ({ authorization: tokenFor(u) });
async function analyze(caseId, user = 'u_alice') {
  const res = await env.api.post(`/api/fixera/cases/${caseId}/analyze?wait=true`).set(auth(user));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test('clear photo of a leak: the actual image bytes reach the model and findings cite the photo', async () => {
  const photo = png(1024, 768, 7);
  script = (req) => {
    assert.equal(promptImages(req).length, 1);
    return modelOutput({
      image_findings: [{ photo: 'photo_1', quality: 'good', quality_issue: null, shows: 'P-trap under a sink with water droplets at the slip nut', relevant: true }],
      observations: [
        { description: 'Water droplets below the P-trap slip nut', source: 'photo', photo: 'photo_1' },
        { description: 'Invented detail from a photo that does not exist', source: 'photo', photo: 'photo_9' },
      ],
    });
  };
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Water leaking under my kitchen sink' });
  await uploadPhotos(env.api, 'u_alice', c.id, [photo], 'camera');
  const before = primary.calls.length;
  const view = await analyze(c.id);
  const req = primary.calls[before];
  assert.equal(promptImages(req)[0].data, photo.toString('base64'), 'exact uploaded bytes were sent');
  assert.equal(promptImages(req)[0].mediaType, 'image/png');
  const a = view.assessment;
  assert.equal(view.case.status, 'DIY_AVAILABLE');
  assert.equal(a.visual_analysis_performed, true);
  assert.deepEqual(a.photos_analyzed, ['photo_1']);
  assert.deepEqual(a.observations.map((o) => o.photo), ['photo_1'], 'observation citing a non-existent photo was dropped');
  assert.equal(view.steps.length, 3);
  assert.equal(a.provenance.provider, 'primary');
  assert.ok(a.provenance.provider_run_id);
  const run = (await env.db.query('SELECT * FROM fixera_provider_runs WHERE id = $1', [a.provenance.provider_run_id])).rows[0];
  assert.equal(run.vision_used, true);
  assert.equal(run.image_count, 1);
  assert.equal(run.status, 'ok');
});

test('dark or blurry photo: Fixera asks for better evidence instead of inventing details', async () => {
  script = () => modelOutput({
    image_findings: [{ photo: 'photo_1', quality: 'unusable', quality_issue: 'Too dark to see any fittings', shows: 'A dark cabinet interior', relevant: false }],
    possible_causes: [{ name: 'Leaking drain connection', certainty: 'possible', rationale: 'Reported water' }],
  });
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Something is wet under the sink' });
  await uploadPhotos(env.api, 'u_alice', c.id, [png(200, 150, 3)]);
  const view = await analyze(c.id);
  assert.equal(view.case.status, 'MORE_INFORMATION_REQUIRED');
  assert.ok(view.assessment.photo_requests.length >= 1, 'specific photo request added');
  assert.ok(view.steps.every((s) => s.action_type !== 'repair'), 'no repair procedure from insufficient evidence');
  const media = view.media[0];
  assert.ok(media.quality_flags.includes('low_resolution'));
});

test('property history influences the assessment; unknown references are dropped', async () => {
  script = (req) => {
    assert.match(promptText(req), /Restricted airflow from clogged return filter/);
    assert.match(promptText(req), /about 9 years old/);
    return modelOutput({
      problem_summary: 'AC running but not cooling',
      equipment: 'Central HVAC',
      equipment_id: ids.hvac,
      history_considered: [{ record_id: ids.hist, relevance: 'Previous airflow restriction' }, { record_id: '00000000-0000-0000-0000-000000000000', relevance: 'made up' }],
      possible_causes: [{ name: 'Restricted airflow from a dirty filter', certainty: 'likely', rationale: 'History and symptoms' }],
      steps: [{ action_type: 'safe_check', title: 'Check thermostat', instruction: 'Confirm the thermostat is set to Cool and below room temperature.', caution: null, stop_condition: null, verification: null }],
    });
  };
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'hvac', description: 'AC is running but not cooling the house' });
  const view = await analyze(c.id);
  assert.deepEqual(view.assessment.history_considered.map((h) => h.record_id), [ids.hist]);
  assert.equal(view.assessment.history_available, true);
  assert.equal(view.case.equipment_id, ids.hvac, 'case linked to the passport equipment');
});

test('property without equipment history: reduced context is stated, not invented', async () => {
  script = (req) => {
    assert.match(promptText(req), /Equipment on record: none/);
    assert.match(promptText(req), /Service history: none recorded/);
    return modelOutput({ history_considered: [{ record_id: ids.hist, relevance: 'from another property' }] });
  };
  const c = await createCase(env.api, 'u_bob', { property_id: ids.bob1, category: 'plumbing', description: 'Bathroom sink drains slowly' });
  await env.db.query('DELETE FROM property_service_history WHERE property_id = $1', [ids.bob1]);
  await env.db.query('DELETE FROM property_equipment WHERE property_id = $1', [ids.bob1]);
  const view = await analyze(c.id, 'u_bob');
  assert.equal(view.assessment.history_available, false);
  assert.deepEqual(view.assessment.history_considered, [], "Alice's record ID cannot be cited on Bob's case");
});

test('exposed wiring: safety overrides DIY even when the model proposes wiring steps', async () => {
  script = () => modelOutput({
    proposed_risk_level: 'LOW',
    reply_to_homeowner: 'Turn off the breaker, then splice the wires with a wire nut.',
    steps: [{ action_type: 'repair', title: 'Splice wires', instruction: 'Splice the bare wires together with a wire nut.', caution: null, stop_condition: null, verification: null }],
  });
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'electrical', description: 'There are exposed wires hanging out of the wall box. How do I fix them myself?' });
  await uploadPhotos(env.api, 'u_alice', c.id, [png()]);
  const view = await analyze(c.id);
  assert.equal(view.case.status, 'PROFESSIONAL_REQUIRED');
  assert.equal(view.steps.length, 0);
  assert.equal(view.assessment.diy.permitted, false);
  const body = JSON.stringify(view);
  assert.ok(!/splice/i.test(body), 'dangerous instructions are not returned');
  const stored = (await env.db.query('SELECT result::text AS r FROM fixera_assessments WHERE case_id = $1', [c.id])).rows[0].r;
  assert.ok(!/splice/i.test(stored), 'dangerous instructions are not stored');
});

test('gas leak: emergency guidance without calling the model', async () => {
  const calls = primary.calls.length;
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'appliance', description: 'Oven will not light and I smell gas in the kitchen' });
  const view = await analyze(c.id);
  assert.equal(primary.calls.length, calls);
  assert.equal(view.case.status, 'EMERGENCY');
  assert.match(view.assessment.reply, /Leave the building/);
  assert.equal(view.steps.length, 0);
});

test('a hazard mentioned later in the conversation still triggers the emergency path', async () => {
  script = () => modelOutput({ next_question: 'Is the pilot light on?', possible_causes: [{ name: 'Pilot out', certainty: 'possible', rationale: '' }] });
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'No hot water this morning' });
  await analyze(c.id);
  const res = await env.api.post(`/api/fixera/cases/${c.id}/messages?wait=true`).set(auth()).send({ content: 'Now the CO alarm is going off in the basement' });
  assert.equal(res.body.case.status, 'EMERGENCY');
});

test('local cost data missing: no invented local price', async () => {
  script = () => modelOutput({ pricing_key: 'plumbing.p_trap_leak' });
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'P-trap is dripping' });
  let view = await analyze(c.id);
  assert.equal(view.assessment.cost_estimate.pricing_source, 'unavailable', 'unknown pricing key is dropped');
  assert.equal(view.assessment.cost_estimate.parts_min_cents, null);

  await env.db.query(`INSERT INTO pricing_rules (category, issue_key, description, parts_min_cents, parts_max_cents, labor_min_cents, labor_max_cents, source)
                      VALUES ('plumbing','plumbing.p_trap_leak','Leaking P-trap / slip joint', 500, 2500, 12000, 25000, 'FixBridge 2026 national job data')`);
  view = (await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(view.assessment.cost_estimate.pricing_source, 'national_baseline');
  assert.match(view.assessment.cost_estimate.source_note, /local data unavailable/);

  await env.db.query(`INSERT INTO pricing_rules (category, issue_key, description, zip_prefix, parts_min_cents, parts_max_cents, source)
                      VALUES ('plumbing','plumbing.p_trap_leak','Leaking P-trap / slip joint','331', 700, 3000, 'Miami-Dade supplier survey Q3 2026')`);
  view = (await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(view.assessment.cost_estimate.pricing_source, 'regional');
  assert.equal(view.assessment.cost_estimate.parts_min_cents, 700);
  assert.equal(view.assessment.cost_estimate.type, 'ai_market_estimate');
});

test('approved knowledge is retrieved and cited; drafts are not', async () => {
  const approved = await env.fixera.knowledge.ingest({
    title: 'Carrier split system airflow troubleshooting', sourceType: 'manufacturer_manual', category: 'hvac', brand: 'Carrier', equipmentType: 'Central HVAC',
    text: '# Low airflow\nA dirty air filter restricts airflow and reduces cooling. Check and replace the return air filter every 1-3 months.',
    reviewState: 'approved',
  });
  await env.fixera.knowledge.ingest({ title: 'Unreviewed forum tip', sourceType: 'repair_guide', category: 'hvac', text: 'DRAFT-ONLY airflow cooling filter trick that nobody reviewed.' });
  let chunkId;
  script = (req) => {
    const text = promptText(req);
    assert.doesNotMatch(text, /DRAFT-ONLY/);
    chunkId = text.match(/<passage id="([0-9a-f-]+)" title="Carrier split system/)?.[1];
    assert.ok(chunkId, 'approved passage in context');
    return modelOutput({ knowledge_used: [chunkId, 'not-a-real-id'] });
  };
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'hvac', description: 'Weak airflow from vents and poor cooling', equipment_id: ids.hvac });
  const view = await analyze(c.id);
  assert.deepEqual(view.assessment.knowledge_sources.map((k) => k.id), [chunkId]);
  assert.equal(view.assessment.knowledge_sources[0].title, approved.title);
});

test('primary provider down: compatible fallback produces the assessment and both runs are logged', async () => {
  const fb = scriptedProvider({ name: 'fallback', handler: () => modelOutput() });
  const e2 = await createTestEnv({ providers: [failingProvider('primary'), fb], db: env.db, storage: env.storage });
  const c = await createCase(e2.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Kitchen faucet drips' });
  await uploadPhotos(e2.api, 'u_alice', c.id, [png()]);
  const view = (await e2.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(view.assessment.provenance.provider, 'fallback');
  const runs = (await e2.db.query('SELECT provider, status FROM fixera_provider_runs WHERE case_id = $1 ORDER BY created_at', [c.id])).rows;
  assert.deepEqual(runs.map((r) => `${r.provider}:${r.status}`), ['primary:error', 'fallback:ok']);
});

test('invalid model output is retried once, then the next provider is used', async () => {
  const bad = scriptedProvider({ name: 'bad', handler: () => ({ diagnosis: 'free text that ignores the schema' }) });
  const good = scriptedProvider({ name: 'good', handler: () => modelOutput() });
  const e2 = await createTestEnv({ providers: [bad, good], db: env.db, storage: env.storage });
  const c = await createCase(e2.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Shower head leaks' });
  const view = (await e2.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(bad.calls.length, 2);
  assert.equal(view.assessment.provenance.provider, 'good');
});

test('no provider can answer: explicit recoverable error, then a retry succeeds', async () => {
  const e2 = await createTestEnv({ providers: [failingProvider('a', 'timeout'), failingProvider('b', 'rate_limited')], db: env.db, storage: env.storage });
  const c = await createCase(e2.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Water stain on ceiling below bathroom' });
  const view = (await e2.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(view.case.status, 'ANALYSIS_FAILED');
  assert.equal(view.assessment, null, 'no unsupported diagnosis');
  assert.match(view.messages.at(-1).content, /could not complete a reliable analysis/);
  const status = (await e2.api.get(`/api/fixera/cases/${c.id}/status`).set(auth())).body;
  assert.equal(status.retryable, true);
  script = () => modelOutput();
  const retry = (await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(retry.case.status, 'DIY_AVAILABLE');
});

test('text-only model is never silently used for photo analysis', async () => {
  const textOnly = scriptedProvider({ name: 'textonly', vision: false, handler: () => modelOutput({ observations: [{ description: 'I can see corrosion', source: 'photo', photo: 'photo_1' }], image_findings: [{ photo: 'photo_1', quality: 'good', quality_issue: null, shows: 'guess', relevant: true }] }) });
  const strict = await createTestEnv({ providers: [textOnly], db: env.db, storage: env.storage });
  const c = await createCase(strict.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Corroded valve under sink' });
  await uploadPhotos(strict.api, 'u_alice', c.id, [png()]);
  let view = (await strict.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(view.case.status, 'ANALYSIS_FAILED');
  assert.equal(textOnly.calls.length, 0);

  const lenient = await createTestEnv({ providers: [textOnly], db: env.db, storage: env.storage, env: { FIXERA_ALLOW_TEXT_ONLY_FALLBACK: 'true' } });
  view = (await lenient.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(textOnly.calls.length, 1);
  assert.equal(promptImages(textOnly.calls[0]).length, 0);
  assert.match(promptText(textOnly.calls[0]), /cannot view images/);
  assert.equal(view.assessment.visual_analysis_performed, false);
  assert.deepEqual(view.assessment.observations, [], 'photo claims from a text-only model are dropped');
  assert.deepEqual(view.assessment.image_findings, []);
});

test('concurrent analyze requests cannot both run', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  script = async () => { await gate; return modelOutput(); };
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Dishwasher leaves water on floor' });
  const first = await env.api.post(`/api/fixera/cases/${c.id}/analyze`).set(auth());
  assert.equal(first.status, 202);
  const second = await env.api.post(`/api/fixera/cases/${c.id}/analyze`).set(auth());
  assert.equal(second.status, 409);
  release();
  await env.fixera.orchestrator.wait(c.id);
  const status = (await env.api.get(`/api/fixera/cases/${c.id}/status`).set(auth())).body;
  assert.equal(status.status, 'DIY_AVAILABLE');
});
