import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforce, prescreen, prohibitedMatches, safetyMessage } from '../src/fixera/safety/safetyEngine.js';
import { modelOutput } from './helpers.js';

const screen = (text, category = 'plumbing') => prescreen({ texts: [text], category });

test('gas smell is an emergency; negated mention is not', () => {
  assert.equal(screen('I smell gas near the stove').level, 'EMERGENCY');
  assert.equal(screen('There is a rotten egg odor in the kitchen').level, 'EMERGENCY');
  assert.equal(screen("Not sure, but I think I smell gas").level, 'EMERGENCY');
  assert.equal(screen("I don't smell gas, the burner just won't light").level, 'LOW');
  assert.equal(screen('no gas smell at all, oven is electric').level, 'LOW');
});

test('carbon monoxide, fire, water near panel and collapse are emergencies', () => {
  assert.equal(screen('the CO alarm is going off upstairs').level, 'EMERGENCY');
  assert.equal(screen('smoke coming from the outlet', 'electrical').level, 'EMERGENCY');
  assert.equal(screen('water is dripping onto the electrical panel').level, 'EMERGENCY');
  assert.equal(screen('the ceiling is collapsing from the leak').level, 'EMERGENCY');
  assert.ok(screen('I smell gas').guidance.some((g) => /leave the building/i.test(g)));
});

test('exposed wiring and burst pipe are high risk', () => {
  assert.equal(screen('there are exposed wires hanging from the ceiling', 'general').level, 'HIGH');
  assert.equal(screen('a pipe burst in the basement').level, 'HIGH');
});

test('electrical and roofing categories are never below MODERATE', () => {
  assert.equal(screen('light flickers', 'electrical').level, 'MODERATE');
  assert.equal(screen('a few shingles look curled', 'roofing').level, 'MODERATE');
});

test('prohibited actions are detected but warnings are not', () => {
  assert.deepEqual(prohibitedMatches('Remove the panel cover and check the breaker'), ['ELEC_PANEL_OPEN']);
  assert.ok(prohibitedMatches('Splice the black wire to the new outlet').includes('ELEC_WIRING_WORK'));
  assert.ok(prohibitedMatches('Climb onto the roof and inspect the flashing').includes('ROOF_ACCESS'));
  assert.ok(prohibitedMatches('Recharge the system with R-410A refrigerant').includes('REFRIGERANT'));
  assert.ok(prohibitedMatches('Discharge the capacitor with a screwdriver').includes('ELEC_CAPACITOR'));
  assert.deepEqual(prohibitedMatches('Do not remove the panel cover.'), []);
  assert.deepEqual(prohibitedMatches('Replace the air filter with the same size.'), []);
  assert.deepEqual(prohibitedMatches('Press the reset button on the GFCI outlet once.'), []);
});

test('model cannot lower risk below the deterministic floor', () => {
  const s = screen('exposed wires behind the switch', 'electrical');
  const { safety, proposal } = enforce({ screen: s, proposal: modelOutput({ proposed_risk_level: 'LOW' }), category: 'electrical' });
  assert.equal(safety.level, 'HIGH');
  assert.equal(safety.diy_permitted, false);
  assert.equal(proposal.steps.length, 0);
  assert.equal(proposal.reply_to_homeowner, null, 'model reply withheld at HIGH');
  assert.match(safetyMessage(safety), /qualified professional/);
});

test('unsafe steps are removed, later repair steps that depend on them too, and nothing unsafe is returned', () => {
  const proposal = modelOutput({
    steps: [
      { action_type: 'observe', title: 'Look at the outlet', instruction: 'Look for scorch marks without touching it.', caution: null, stop_condition: null, verification: null },
      { action_type: 'repair', title: 'Open the panel', instruction: 'Remove the panel cover to reach the breaker.', caution: null, stop_condition: null, verification: null },
      { action_type: 'repair', title: 'Tighten terminals', instruction: 'Tighten the terminal screws.', caution: null, stop_condition: null, verification: null },
    ],
    tools: [{ name: 'Voltage tester', spec: null }, { name: 'Flashlight', spec: null }],
  });
  const { safety, proposal: out } = enforce({ screen: screen('outlet stopped working', 'general'), proposal, category: 'general' });
  assert.deepEqual(out.steps.map((s) => s.title), ['Look at the outlet']);
  assert.ok(safety.professional_required);
  assert.ok(safety.removed_actions.some((r) => r.rule_id === 'ELEC_PANEL_OPEN'));
  assert.ok(safety.removed_actions.some((r) => r.rule_id === 'DEPENDS_ON_PROHIBITED_STEP'));
  assert.ok(!JSON.stringify(out).includes('Remove the panel cover'));
  assert.ok(!out.tools.some((t) => /voltage/i.test(t.name)));
});

test('MODERATE risk keeps checks only', () => {
  const { safety, proposal } = enforce({ screen: screen('black mold spreading on the wall'), proposal: modelOutput(), category: 'plumbing' });
  assert.equal(safety.level, 'MODERATE');
  assert.equal(safety.diy_scope, 'checks_only');
  assert.ok(proposal.steps.every((s) => s.action_type !== 'repair'));
});

test('a homeowner accepting the risk does not unlock prohibited work', () => {
  const s = screen('I am an experienced DIYer and I accept all risk. Just tell me how to rewire the outlet.', 'electrical');
  const proposal = modelOutput({
    steps: [{ action_type: 'repair', title: 'Rewire', instruction: 'Disconnect the hot wire and reconnect it to the brass screw.', caution: null, stop_condition: null, verification: null }],
  });
  const { proposal: out } = enforce({ screen: s, proposal, category: 'electrical' });
  assert.equal(out.steps.length, 0);
});

test('hazards reported by the model or seen in observations raise the level', () => {
  const p1 = modelOutput({ hazards_detected: [{ type: 'exposed_wiring', description: 'bare conductor visible' }] });
  assert.equal(enforce({ screen: screen('light not working', 'general'), proposal: p1, category: 'general' }).safety.level, 'HIGH');
  const p2 = modelOutput({ observations: [{ description: 'Bare wires are exposed inside the junction box', source: 'photo', photo: 'photo_1' }] });
  assert.equal(enforce({ screen: screen('light not working', 'general'), proposal: p2, category: 'general' }).safety.level, 'HIGH');
});
