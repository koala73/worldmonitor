import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';
import { FRED_RATES_ACTIVATION_KEY } from '../scripts/seed-fred-rates.mjs';

const {
  classifyKey,
  BOOTSTRAP_KEYS,
  STANDALONE_KEYS,
  SEED_META,
  ACTIVATION_MARKERS,
  FRED_RATES_ROLLOUT_DEADLINE_KEY,
  FRED_RATES_ROLLOUT_DURATION_MS,
  fredRatesRolloutCommands,
  parseFredRatesRolloutUntil,
} = __testing__;

const NAME = 'fredRatesSeeder';
const KEY = BOOTSTRAP_KEYS[NAME] ?? STANDALONE_KEYS[NAME];
const DEPLOYED_AT = Date.parse('2031-04-12T09:30:00Z');
const UNTIL = DEPLOYED_AT + FRED_RATES_ROLLOUT_DURATION_MS;

function classify({ now, activated = false, rolloutUntil = UNTIL, present = false } = {}) {
  return classifyKey(
    NAME,
    KEY,
    { allowOnDemand: false },
    {
      keyStrens: new Map(present ? [[KEY, 128]] : []),
      keyErrors: new Map(),
      keyMetaValues: new Map(),
      keyMetaErrors: new Map(),
      activationStates: new Map(
        Object.keys(ACTIVATION_MARKERS).map((name) => [name, name === NAME ? activated : false]),
      ),
      rolloutPendingUntilMs: new Map(
        rolloutUntil === null ? [] : [[NAME, rolloutUntil]],
      ),
      now,
    },
  );
}

test('FRED rollout registers one versioned activation marker and a 24h duration', () => {
  assert.equal(ACTIVATION_MARKERS[NAME], FRED_RATES_ACTIVATION_KEY);
  assert.equal(SEED_META[NAME].key, 'seed-meta:economic:fred-rates');
  assert.equal(FRED_RATES_ROLLOUT_DURATION_MS, 24 * 60 * 60 * 1_000);
});

test('a delayed production deployment claims its own durable deadline', () => {
  assert.deepEqual(
    fredRatesRolloutCommands(DEPLOYED_AT, 'production'),
    [
      ['SET', FRED_RATES_ROLLOUT_DEADLINE_KEY, String(UNTIL), 'NX'],
      ['GET', FRED_RATES_ROLLOUT_DEADLINE_KEY],
    ],
  );
  assert.deepEqual(fredRatesRolloutCommands(DEPLOYED_AT, 'preview'), []);
  assert.deepEqual(fredRatesRolloutCommands(DEPLOYED_AT, 'development'), []);
  assert.equal(
    parseFredRatesRolloutUntil([{ result: 'OK' }, { result: String(UNTIL) }]),
    UNTIL,
  );
});

test('an existing deadline wins on every later production deployment', () => {
  const laterCandidate = DEPLOYED_AT + 30 * 24 * 60 * 60 * 1_000;
  const commands = fredRatesRolloutCommands(laterCandidate, 'production');
  assert.equal(commands[0].at(-1), 'NX', 'the rollout deadline can be claimed only once');
  assert.ok(!commands[0].includes('EX'), 'the deadline state must not expire and reopen grace');
  assert.equal(
    parseFredRatesRolloutUntil([{ result: null }, { result: String(UNTIL) }]),
    UNTIL,
    'GET returns the durable first-deployment deadline after SET NX loses',
  );
});

test('before first FRED publication, an absent key is rollout-pending inside the deployed window', () => {
  const entry = classify({ now: UNTIL - 1, activated: false });
  assert.equal(entry.status, 'ROLLOUT_PENDING');
  assert.equal(entry.activated, false);
  assert.equal(entry.rolloutPendingUntil, new Date(UNTIL).toISOString());
});

test('FRED activation revokes rollout softening immediately', () => {
  const entry = classify({ now: UNTIL - 1, activated: true });
  assert.equal(entry.status, 'EMPTY');
  assert.equal(entry.activated, true);
  assert.equal(entry.rolloutPendingUntil, undefined);
});

test('an unactivated FRED producer becomes strict at its deployment-relative deadline', () => {
  assert.equal(classify({ now: UNTIL, activated: false }).status, 'EMPTY');
  assert.equal(classify({ now: UNTIL + 1, activated: false }).status, 'EMPTY');
});

test('missing or malformed durable rollout state fails closed', () => {
  assert.equal(parseFredRatesRolloutUntil(), null);
  assert.equal(parseFredRatesRolloutUntil([{ result: 'OK' }, { result: 'not-a-time' }]), null);
  assert.equal(parseFredRatesRolloutUntil([{ error: 'SET failed' }, { result: String(UNTIL) }]), null);
  assert.equal(classify({ now: DEPLOYED_AT, rolloutUntil: null }).status, 'EMPTY');
});
