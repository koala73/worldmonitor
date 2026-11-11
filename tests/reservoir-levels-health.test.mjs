// The reservoirLevels probe is new: health must not read EMPTY (crit) between the
// Vercel deploy and the climate bundle's first Railway publication, and must turn
// strict once the seeder's durable activation marker exists or the deadline passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../api/health.js';
import { RESERVOIR_LEVELS_ACTIVATION_KEY, RESERVOIR_LEVELS_KEY } from '../scripts/seed-reservoir-levels.mjs';

const { classifyKey, STANDALONE_KEYS, SEED_META, ACTIVATION_MARKERS, ON_DEMAND_KEYS, regionalEnergyRolloutCommands } = __testing__;
const name = 'reservoirLevels';
const key = STANDALONE_KEYS[name];
const now = Date.parse('2026-11-12T09:30:00Z');

function classify(until, activated = false) {
  return classifyKey(name, key, { allowOnDemand: true }, {
    keyStrens: new Map(), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map(),
    activationStates: new Map([[name, activated]]),
    rolloutPendingUntilMs: new Map(until ? [[name, until]] : []), now,
  });
}

test('the probe, seeder and marker name the same keys', () => {
  assert.equal(key, RESERVOIR_LEVELS_KEY);
  assert.equal(SEED_META[name].activationKey, RESERVOIR_LEVELS_ACTIVATION_KEY);
  assert.equal(ACTIVATION_MARKERS[name], RESERVOIR_LEVELS_ACTIVATION_KEY);
  assert.equal(SEED_META[name].cutover.activationKey, RESERVOIR_LEVELS_ACTIVATION_KEY);
  assert.ok(ON_DEMAND_KEYS.has(name));
});

test('absent key with no marker inside the window is ROLLOUT_PENDING (warn)', () => {
  const entry = classify(now + 60_000);
  assert.equal(entry.status, 'ROLLOUT_PENDING');
});

test('absent key after the deadline is EMPTY', () => {
  assert.equal(classify(now).status, 'EMPTY');
  assert.equal(classify(now - 1).status, 'EMPTY');
});

test('absent key with the marker present is EMPTY, even inside the window', () => {
  assert.equal(classify(now + 60_000, true).status, 'EMPTY');
});

test('production claims a one-day NX deadline for the data key', () => {
  const commands = regionalEnergyRolloutCommands(now, 'production');
  const deadlineKey = `health:rollout-deadline:${RESERVOIR_LEVELS_KEY}`;
  assert.deepEqual(commands.find((c) => c[0] === 'SET' && c[1] === deadlineKey), ['SET', deadlineKey, String(now + 1440 * 60_000), 'NX']);
  assert.ok(commands.some((c) => c[0] === 'GET' && c[1] === deadlineKey));
});
