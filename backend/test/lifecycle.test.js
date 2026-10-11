// Case continuity, guided DIY, outcomes, professional handoff and learning loop.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCase, createTestEnv, modelOutput, png, promptImages, promptText, scriptedProvider, seed, tokenFor, uploadPhotos } from './helpers.js';

let env, ids;
let script = () => modelOutput();
const provider = scriptedProvider({ handler: (req, n) => script(req, n) });
const auth = (u = 'u_alice') => ({ authorization: tokenFor(u) });

before(async () => {
  env = await createTestEnv({ providers: [provider] });
  ids = await seed(env.db);
});

test('conversation continuity: each turn sees prior messages, photos and step progress; the case survives a restart', async () => {
  script = () => modelOutput({
    reply_to_homeowner: 'Is the refrigerator compartment warm while the freezer still freezes?',
    problem_summary: 'Refrigerator not cooling, freezer fine',
    possible_causes: [{ name: 'Blocked air vent', certainty: 'possible', rationale: '' }],
    next_question: 'Is the fridge warm while the freezer still freezes food?',
    steps: [],
  });
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'appliance', description: "My refrigerator isn't cooling properly, but the freezer seems fine." });
  let view = (await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  assert.equal(view.case.status, 'MORE_INFORMATION_REQUIRED');

  script = (req) => {
    const t = promptText(req);
    assert.match(t, /Is the refrigerator compartment warm/, 'previous assistant turn is in context');
    assert.match(t, /Yes\. The freezer is working normally/);
    return modelOutput({
      reply_to_homeowner: 'Please check whether food is blocking the vents inside the fridge. No panels need to be removed.',
      possible_causes: [{ name: 'Blocked air vent', certainty: 'possible', rationale: 'Freezer fine' }],
      next_question: 'Are any vents blocked?',
      steps: [{ action_type: 'observe', title: 'Check the vents', instruction: 'Look at the vents at the back of the fridge compartment for blocking containers.', caution: null, stop_condition: null, verification: null }],
    });
  };
  view = (await env.api.post(`/api/fixera/cases/${c.id}/messages?wait=true`).set(auth()).send({ content: 'Yes. The freezer is working normally.' })).body;
  assert.equal(view.steps.length, 1);

  // Photo added mid-troubleshooting is analysed with the earlier context.
  const up = await uploadPhotos(env.api, 'u_alice', c.id, [png(900, 700, 11)], 'camera');
  script = (req) => {
    assert.equal(promptImages(req).length, 1);
    assert.match(promptText(req), /One of the vents was completely blocked/);
    return modelOutput({
      reply_to_homeowner: 'That could explain the reduced cooling. Clear the obstruction and monitor the temperature.',
      image_findings: [{ photo: 'photo_1', quality: 'good', quality_issue: null, shows: 'A container pressed against the rear vent', relevant: true }],
      observations: [{ description: 'A container is pressed against the rear air vent', source: 'photo', photo: 'photo_1' }],
      possible_causes: [{ name: 'Blocked air vent', certainty: 'likely', rationale: 'Visible in photo' }],
      steps: [
        { action_type: 'repair', title: 'Clear the vent', instruction: 'Move the containers away from the vent so air can flow.', caution: null, stop_condition: null, verification: null },
        { action_type: 'verify', title: 'Monitor temperature', instruction: 'Place a thermometer in the fridge and check it after 6 hours. It should read 37-40°F.', caution: null, stop_condition: 'Still above 41°F after 24 hours', verification: '37-40°F' },
      ],
    });
  };
  view = (await env.api.post(`/api/fixera/cases/${c.id}/messages?wait=true`).set(auth()).send({ content: 'One of the vents was completely blocked.', media_ids: [up.body.media[0].id] })).body;
  assert.equal(view.case.status, 'DIY_AVAILABLE');
  assert.deepEqual(view.steps.map((s) => s.title), ['Clear the vent', 'Monitor temperature'], 'new plan supersedes the old one');

  await env.api.post(`/api/fixera/cases/${c.id}/steps/${view.steps[0].id}/result`).set(auth()).send({ result: 'done' });

  // "Close the browser": a brand new app instance on the same database restores everything.
  const restarted = await createTestEnv({ providers: [provider], db: env.db, storage: env.storage });
  const restored = (await restarted.api.get(`/api/fixera/cases/${c.id}`).set(auth())).body;
  assert.equal(restored.case.status, 'DIY_AVAILABLE');
  assert.equal(restored.media.length, 1);
  assert.equal(restored.steps[0].status, 'done');
  assert.equal(restored.steps[1].status, 'pending');
  assert.deepEqual(restored.messages.map((m) => m.role), ['assistant', 'homeowner', 'assistant', 'homeowner', 'assistant', 'homeowner']);
  assert.equal(restored.assessment.version, 3);
  assert.equal((await restarted.api.get(restored.media[0].url).set(auth())).status, 200, 'photo still retrievable');
});

test('"I need help with this step" gets a fresh explanation in the same case', async () => {
  script = () => modelOutput();
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Drip under the bathroom sink at the trap' });
  let view = (await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  const step2 = view.steps[1];
  script = (req) => {
    assert.match(promptText(req), /I need help with this step/);
    assert.match(promptText(req), /I can't tell which nut/);
    assert.match(promptText(req), /step 2 \(repair\) "Hand-tighten the slip nut": need_help/);
    return modelOutput({ reply_to_homeowner: 'The slip nut is the large ring where the curved pipe meets the straight pipe.', steps: [] });
  };
  const res = await env.api.post(`/api/fixera/cases/${c.id}/steps/${step2.id}/result?wait=true`).set(auth()).send({ result: 'need_help', note: "I can't tell which nut" });
  view = res.body;
  assert.match(view.messages.at(-1).content, /large ring/);
  assert.equal(view.steps.length, 3, 'plan kept when the turn only explains');
});

test('DIY fails, homeowner hires a pro, contractor finds something else, and Fixera learns from it', async () => {
  script = () => modelOutput({
    problem_summary: 'Kitchen sink leak',
    image_findings: [{ photo: 'photo_1', quality: 'good', quality_issue: null, shows: 'Wet cabinet floor under P-trap', relevant: true }],
    possible_causes: [{ name: 'Loose slip nut on P-trap', certainty: 'likely', rationale: '' }],
  });
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Water under kitchen sink, near 12 Palm Street unit. Call me at 305-555-0199.' });
  await uploadPhotos(env.api, 'u_alice', c.id, [png()]);
  let view = (await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth())).body;
  for (const s of view.steps) await env.api.post(`/api/fixera/cases/${c.id}/steps/${s.id}/result`).set(auth()).send({ result: 'done' });

  const outcome = await env.api.post(`/api/fixera/cases/${c.id}/outcome`).set(auth()).send({ resolution: 'unresolved', note: 'Still dripping' });
  assert.equal(outcome.body.next, 'offer_professional');

  const hire = await env.api.post(`/api/fixera/cases/${c.id}/hire-pro`).set(auth()).send({ preferred_date: '2026-10-15', preferred_window: 'afternoon' });
  assert.equal(hire.status, 201);
  const srId = hire.body.service_request.id;
  view = (await env.api.get(`/api/fixera/cases/${c.id}`).set(auth())).body;
  assert.equal(view.case.status, 'REFERRED');

  // Dispatch assigns a contractor; only that contractor sees the job and case.
  await env.api.post(`/api/fixera/admin/service-requests/${srId}/assign`).set(auth('a_admin')).send({ contractor_id: 'c_dana' });
  const job = (await env.api.get(`/api/fixera/contractor/jobs/${srId}`).set(auth('c_dana'))).body;
  assert.match(job.handoff.ai_assessment.label, /Not verified/);
  assert.equal(job.handoff.ai_assessment.possible_causes[0].verified, false);
  assert.equal(job.handoff.photos.length, 1);
  assert.equal(job.handoff.troubleshooting_attempted.length, 3);
  assert.equal(job.handoff.original_description.includes('Water under kitchen sink'), true);
  assert.equal((await env.api.get(`/api/fixera/contractor/jobs/${srId}`).set(auth('c_eve'))).status, 404);
  assert.equal((await env.api.get(`/api/fixera/cases/${c.id}`).set(auth('c_dana'))).status, 200);
  assert.equal((await env.api.get(`/api/fixera/cases/${c.id}`).set(auth('c_eve'))).status, 404);

  const done = await env.api.post(`/api/fixera/contractor/jobs/${srId}/complete`).set(auth('c_dana')).send({
    final_diagnosis: 'Cracked dishwasher drain hose at the garbage disposal inlet',
    work_performed: 'Replaced dishwasher drain hose and clamp',
    parts_replaced: [{ name: 'Dishwasher drain hose', quantity: 1 }],
    invoice_cents: 21500,
    resolved: true,
    maintenance_reminders: [{ title: 'Inspect under-sink connections', due_on: '2027-04-15', recurrence_days: 180 }],
  });
  assert.equal(done.status, 201);
  assert.equal(done.body.mismatch_flagged, true, 'finding shares nothing with AI hypotheses');

  const passport = (await env.api.get(`/api/fixera/properties/${ids.alice1}/passport`).set(auth())).body;
  const contractorEntry = passport.history.find((h) => h.event_type === 'contractor_completion');
  assert.equal(contractorEntry.verification_status, 'contractor_recorded');
  assert.equal(contractorEntry.cost_cents, 21500);
  const diyEntry = passport.history.find((h) => h.event_type === 'diy_outcome');
  assert.equal(diyEntry.verification_status, 'homeowner_reported');
  assert.ok(passport.reminders.some((r) => r.title === 'Inspect under-sink connections'));

  // AI estimate and contractor amounts stay separate records.
  const sr = (await env.db.query('SELECT contractor_quote_cents, approved_amount_cents FROM service_requests WHERE id = $1', [srId])).rows[0];
  assert.equal(sr.contractor_quote_cents, null);
  const stored = (await env.db.query('SELECT result FROM fixera_assessments WHERE case_id = $1', [c.id])).rows[0].result;
  assert.equal(stored.cost_estimate.type, 'ai_market_estimate');

  const queue = (await env.api.get('/api/fixera/admin/review-queue').set(auth('a_admin'))).body.items;
  const item = queue.find((i) => i.case_id === c.id);
  assert.equal(item.kind, 'diagnosis_mismatch');

  const promoted = await env.api.post(`/api/fixera/admin/review-queue/${item.id}`).set(auth('a_admin')).send({
    action: 'promote',
    generalized_summary: 'Water under a kitchen sink at 12 Palm Street that persisted after the P-trap slip nut was tightened came from a cracked dishwasher drain hose at the disposal inlet. Call 305-555-0199. Check the dishwasher drain hose when a P-trap repair does not stop a leak.',
  });
  assert.equal(promoted.status, 200);
  const doc = (await env.db.query('SELECT d.review_state, d.source_type, string_agg(k.content, \' \') AS content FROM knowledge_documents d JOIN knowledge_chunks k ON k.document_id = d.id WHERE d.id = $1 GROUP BY 1, 2', [promoted.body.knowledge_document_id])).rows[0];
  assert.equal(doc.review_state, 'approved');
  assert.equal(doc.source_type, 'reviewed_case');
  assert.doesNotMatch(doc.content, /Palm Street|555-0199/, 'customer details redacted');
  const outcomes = (await env.db.query('SELECT verification_status FROM fixera_outcomes WHERE case_id = $1 ORDER BY created_at', [c.id])).rows.map((r) => r.verification_status);
  assert.deepEqual(outcomes, ['homeowner_reported', 'contractor_recorded', 'verified']);

  // The reviewed lesson is now retrievable for a future similar case.
  const hits = await env.fixera.knowledge.retrieve({ query: 'leak under kitchen sink continues after p-trap tightened dishwasher', category: 'plumbing' });
  assert.ok(hits.some((h) => h.document_id === promoted.body.knowledge_document_id));
});

test('resolved DIY outcome is recorded as homeowner-reported, not verified', async () => {
  script = () => modelOutput();
  const c = await createCase(env.api, 'u_alice', { property_id: ids.alice1, category: 'plumbing', description: 'Slow drip at the sink trap' });
  await env.api.post(`/api/fixera/cases/${c.id}/analyze?wait=true`).set(auth());
  const res = await env.api.post(`/api/fixera/cases/${c.id}/outcome`).set(auth()).send({ resolution: 'resolved' });
  assert.equal(res.body.outcome.verification_status, 'homeowner_reported');
  const view = (await env.api.get(`/api/fixera/cases/${c.id}`).set(auth())).body;
  assert.equal(view.case.status, 'RESOLVED');
  assert.equal((await env.api.post(`/api/fixera/cases/${c.id}/messages`).set(auth()).send({ content: 'hello?' })).status, 409);
});

test('admin evaluation summary reports provider runs and outcomes', async () => {
  const res = await env.api.get('/api/fixera/admin/evaluation/summary').set(auth('a_admin'));
  assert.equal(res.status, 200);
  assert.ok(res.body.provider_runs.some((r) => r.provider === 'scripted' && r.status === 'ok'));
  assert.ok(res.body.outcome_accuracy.length > 0);
});
