import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../api/health.js';
const { classifyKey, STANDALONE_KEYS, SEED_META, regionalEnergyRolloutCommands } = __testing__;
const name = 'regionalEnergyCammesa';
const key = STANDALONE_KEYS[name];
const now = Date.parse('2031-04-12T09:30:00Z');
function classify(until, meta, activated = false) {
  return classifyKey(name, key, { allowOnDemand: true }, {
    keyStrens: new Map(), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map(meta ? [[SEED_META[name].key, JSON.stringify(meta)]] : []),
    activationStates: new Map([[name, activated]]),
    rolloutPendingUntilMs: new Map(until ? [[name, until]] : []), now,
  });
}
test('scheduled regional feed grace ends at its fixed deadline', () => {
  assert.equal(classify(now + 1).status, 'ROLLOUT_PENDING');
  assert.equal(classify(now).status, 'EMPTY');
  assert.equal(classify(null).status, 'EMPTY');
  assert.equal(classify(now + 1, undefined, true).status, 'EMPTY');
});
test('first fetch error is visible inside rollout grace without a success clock', () => {
  const entry = classify(now + 1, { status: 'error', firstFailureAt: now - 1000, recordCount: 0 });
  assert.equal(entry.status, 'SEED_ERROR');
});
test('regional deadlines use persistent NX and existing budgets capped at one day', () => {
  const commands = regionalEnergyRolloutCommands(now, 'production');
  assert.equal(commands.length, 26);
  const cammesa = commands.find(c => c[0] === 'SET' && c[1].includes(':cammesa:'));
  assert.deepEqual(cammesa.slice(2), [String(now + 180 * 60000), 'NX']);
  const anp = commands.find(c => c[0] === 'SET' && c[1].includes(':anp:'));
  assert.deepEqual(anp.slice(2), [String(now + 1440 * 60000), 'NX']);
  assert.deepEqual(regionalEnergyRolloutCommands(now, 'preview'), []);
});
