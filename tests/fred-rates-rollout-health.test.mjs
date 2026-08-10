import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleHealth, __testing__ } from '../api/health.js';
import { handleSeedHealth } from '../api/seed-health.js';
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

function classify({ now, activated = false, rolloutUntil = UNTIL, recordCount } = {}) {
  const present = recordCount != null;
  return classifyKey(
    NAME,
    KEY,
    { allowOnDemand: false },
    {
      keyStrens: new Map(present ? [[KEY, 128]] : []),
      keyErrors: new Map(),
      keyMetaValues: new Map(present ? [[
        SEED_META[NAME].key,
        JSON.stringify({ fetchedAt: now, recordCount }),
      ]] : []),
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
  assert.equal(SEED_META[NAME].minRecordCount, 24);
  assert.equal(FRED_RATES_ROLLOUT_DURATION_MS, 24 * 60 * 60 * 1_000);
});

test('fresh FRED coverage is partial at 18 records and OK at all 24 records', () => {
  assert.equal(classify({ now: DEPLOYED_AT, recordCount: 18 }).status, 'COVERAGE_PARTIAL');
  assert.equal(classify({ now: DEPLOYED_AT, recordCount: 24 }).status, 'OK');
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

function installHealthPipelineMock(recordCount) {
  let sweepCommands;
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const isSweep = commands.some(([op, key]) => op === 'SET' && key === FRED_RATES_ROLLOUT_DEADLINE_KEY);
    if (isSweep) sweepCommands = commands;

    const results = commands.map(([op, key]) => {
      if (op === 'STRLEN') return { result: key === KEY && recordCount == null ? 0 : 128 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'EXISTS') return { result: 0 };
      if (op === 'GET' && key === FRED_RATES_ROLLOUT_DEADLINE_KEY) return { result: String(UNTIL) };
      if (op === 'GET' && key === SEED_META[NAME].key) {
        return {
          result: recordCount == null
            ? null
            : JSON.stringify({ fetchedAt: DEPLOYED_AT, recordCount }),
        };
      }
      if (op === 'GET' && String(key).includes('health:verdict')) return { result: null };
      if (op === 'GET' && key === 'health:failure-log-sig') return { result: '' };
      if (op === 'GET') {
        return { result: JSON.stringify({ fetchedAt: DEPLOYED_AT, recordCount: 10_000 }) };
      }
      return { result: 'OK' };
    });

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return () => sweepCommands;
}

async function readProductionHealth(recordCount) {
  const getSweepCommands = installHealthPipelineMock(recordCount);
  const response = await handleHealth(new Request('https://api.worldmonitor.app/api/health', {
    headers: { 'x-worldmonitor-key': 'fred-health-test-key' },
  }), undefined, { now: DEPLOYED_AT });
  return { body: await response.json(), getSweepCommands };
}

test('production handleHealth parses FRED rollout slots without softening partial coverage', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    VERCEL_ENV: process.env.VERCEL_ENV,
    WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  process.env.VERCEL_ENV = 'production';
  process.env.WORLDMONITOR_VALID_KEYS = 'fred-health-test-key';

  try {
    const absent = await readProductionHealth(null);
    const absentCommands = absent.getSweepCommands();
    assert.deepEqual(absentCommands.slice(-2), [
      ['SET', FRED_RATES_ROLLOUT_DEADLINE_KEY, String(UNTIL), 'NX'],
      ['GET', FRED_RATES_ROLLOUT_DEADLINE_KEY],
    ]);
    assert.equal(absent.body.checks[NAME].status, 'ROLLOUT_PENDING');
    assert.equal(absent.body.checks[NAME].rolloutPendingUntil, new Date(UNTIL).toISOString());

    const partial = await readProductionHealth(18);
    assert.equal(partial.body.checks[NAME].status, 'COVERAGE_PARTIAL');
    assert.equal(partial.body.checks[NAME].records, 18);
    assert.equal(partial.body.checks[NAME].minRecordCount, 24);
    assert.equal(partial.body.checks[NAME].rolloutPendingUntil, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('seed-health reports partial at 18 FRED records and OK at all 24 records', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  process.env.WORLDMONITOR_VALID_KEYS = 'fred-health-test-key';

  try {
    for (const [recordCount, expectedStatus] of [[18, 'coverage_partial'], [24, 'ok']]) {
      globalThis.fetch = async (_url, init) => {
        const commands = JSON.parse(init.body);
        const results = commands.map(([op, key]) => {
          if (op === 'EXISTS') return { result: 0 };
          if (op === 'GET' && key === SEED_META[NAME].key) {
            return { result: JSON.stringify({ fetchedAt: DEPLOYED_AT, recordCount }) };
          }
          if (op === 'GET') {
            return { result: JSON.stringify({ fetchedAt: DEPLOYED_AT, recordCount: 10_000 }) };
          }
          return { result: 'OK' };
        });
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const response = await handleSeedHealth(new Request('https://api.worldmonitor.app/api/seed-health', {
        headers: { 'x-worldmonitor-key': 'fred-health-test-key' },
      }), { now: DEPLOYED_AT });
      const body = await response.json();
      const entry = body.seeds['economic:fred-rates'];
      assert.equal(entry.status, expectedStatus);
      assert.equal(entry.recordCount, recordCount);
      assert.equal(entry.minRecordCount, 24);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
