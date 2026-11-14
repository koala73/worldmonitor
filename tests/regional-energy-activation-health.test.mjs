import { test } from 'node:test';
import assert from 'node:assert/strict';
// Health reads ORBITAL_WATCH_ENABLED at import time, and the deadline count below depends
// on it (orbitalSites claims a deadline only once lit). Pin the dark default, then restore.
const previousOrbitalWatch = process.env.ORBITAL_WATCH_ENABLED;
process.env.ORBITAL_WATCH_ENABLED = 'false';
const { __testing__ } = await import('../api/health.js?orbital-watch=dark');
if (previousOrbitalWatch === undefined) delete process.env.ORBITAL_WATCH_ENABLED;
else process.env.ORBITAL_WATCH_ENABLED = previousOrbitalWatch;
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
  // 23 regional feeds, reservoirLevels and orbitalCatalog, two commands each. orbitalSites
  // claims none while Orbital Watch is dark (tests/orbital-sites-dark-launch-health.test.mjs).
  assert.equal(commands.length, 50);
  const cammesa = commands.find(c => c[0] === 'SET' && c[1].includes(':cammesa:'));
  assert.deepEqual(cammesa.slice(2), [String(now + 180 * 60000), 'NX']);
  const anp = commands.find(c => c[0] === 'SET' && c[1].includes(':anp:'));
  assert.deepEqual(anp.slice(2), [String(now + 1440 * 60000), 'NX']);
  assert.deepEqual(regionalEnergyRolloutCommands(now, 'preview'), []);
});
