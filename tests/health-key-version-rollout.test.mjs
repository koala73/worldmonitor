import { decodeHealthPipeline } from './helpers/health-pipeline-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleHealth, __testing__ } from '../api/health.js';

const {
  STANDALONE_KEYS,
  SEED_META,
  KEY_VERSION_ROLLOUT_DEADLINE_PREFIX,
  writerKeyVersionBehind,
  keyVersionRolloutCommands,
  keyVersionRolloutDurationMs,
  KEY_VERSION_ROLLOUT_MAX_MS,
} = __testing__;

// Production on 2026-10-08: #9044 moved this reader from v11 to v12 at 08:55
// UTC. Its writer is a Railway cron (`0 */6 * * *`) that a deploy does not
// run, so v12 stayed absent until 12:00 and health read EMPTY (crit) beside a
// fresh seed-meta written by the v11 code.
const NAME = 'resilienceIntervals';
const KEY = STANDALONE_KEYS[NAME];
const META_KEY = SEED_META[NAME].key;
const DEADLINE_KEY = `${KEY_VERSION_ROLLOUT_DEADLINE_PREFIX}${KEY}`;
const NOW = Date.parse('2026-10-08T09:12:00Z');
const BUDGET_MS = SEED_META[NAME].maxStaleMin * 60_000;
const PREVIOUS_KEY = KEY.replace(/:v(\d+):/, (_, v) => `:v${Number(v) - 1}:`);

function writerMeta(sourceKey, overrides = {}) {
  return {
    fetchedAt: NOW - 189 * 60_000,
    recordCount: 196,
    sourceVersion: `resilience-intervals:${sourceKey.replace(/US$/, '')}weight-perturbation-sensitivity-v3`,
    _formula: 'pc',
    _educationState: 'education-on',
    _intervalMethodology: 'weight-perturbation-sensitivity-v3',
    ...overrides,
  };
}

test('a writer that names an older version of the read key is behind', () => {
  assert.equal(writerKeyVersionBehind('resilience:intervals:v12:US', 'resilience-intervals:resilience:intervals:v11:wps-v3'), true);
  assert.equal(writerKeyVersionBehind('resilience:intervals:v12:US', 'resilience-intervals:resilience:intervals:v12:wps-v3'), false);
  assert.equal(writerKeyVersionBehind('resilience:intervals:v12:US', 'resilience-intervals:resilience:intervals:v13:wps-v3'), false);
  assert.equal(writerKeyVersionBehind('resilience:intervals:v12:US', 'xresilience:intervals:v11'), false, 'family must match whole segments');
  assert.equal(writerKeyVersionBehind('resilience:intervals:v12:US', 'resilience:ranking:v11'), false);
  assert.equal(writerKeyVersionBehind('resilience:intervals:v12:US', null), false);
  assert.equal(writerKeyVersionBehind('market:quotes', 'market:quotes:v1'), false, 'unversioned keys never qualify');
});

test('only production claims a deadline, once, and it never expires', () => {
  const candidates = [{ name: NAME, dataKey: KEY, durationMs: BUDGET_MS }];
  assert.deepEqual(keyVersionRolloutCommands(candidates, NOW, 'production'), [
    ['SET', DEADLINE_KEY, String(NOW + BUDGET_MS), 'NX'],
    ['GET', DEADLINE_KEY],
  ]);
  assert.deepEqual(keyVersionRolloutCommands(candidates, NOW, 'preview'), []);
  assert.deepEqual(keyVersionRolloutCommands([], NOW, 'production'), []);
});

function installMock({ meta, deadline, dataPresent = false }) {
  const deadlineCommands = [];
  globalThis.fetch = async (_url, init) => {
    const { commands, encodeResults } = decodeHealthPipeline(init.body);
    const results = commands.map(([op, key, value]) => {
      if (op === 'STRLEN') return { result: key === KEY && !dataPresent ? 0 : 128 };
      if (op === 'LLEN' || op === 'EXISTS' || op === 'HEXISTS') return { result: 1 };
      if (op === 'SET' && key === DEADLINE_KEY) {
        deadlineCommands.push([op, key, value]);
        return { result: deadline === undefined ? 'OK' : null };
      }
      if (op === 'GET' && key === DEADLINE_KEY) {
        deadlineCommands.push([op, key]);
        return { result: String(deadline ?? NOW + BUDGET_MS) };
      }
      if (op === 'GET' && key === META_KEY) return { result: JSON.stringify(meta) };
      return { result: op === 'GET' ? null : 'OK' };
    });
    return new Response(JSON.stringify(encodeResults(results)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { deadlineCommands };
}

async function readCheck(mockOptions, { now = NOW, vercelEnv = 'production' } = {}) {
  const originalFetch = globalThis.fetch;
  const saved = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    VERCEL_ENV: process.env.VERCEL_ENV,
    WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  process.env.VERCEL_ENV = vercelEnv;
  process.env.WORLDMONITOR_VALID_KEYS = 'key-version-rollout-test-key';
  const originalLog = console.log;
  console.log = () => {};
  try {
    const mock = installMock(mockOptions);
    const response = await handleHealth(new Request('https://api.worldmonitor.app/api/health', {
      headers: { 'x-worldmonitor-key': 'key-version-rollout-test-key' },
    }), undefined, { now });
    const body = await response.json();
    return { check: body.checks[NAME], deadlineCommands: mock.deadlineCommands };
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('an absent key whose fresh writer is on the previous key version is rollout-pending', async () => {
  const { check, deadlineCommands } = await readCheck({ meta: writerMeta(PREVIOUS_KEY) });
  assert.equal(check.status, 'ROLLOUT_PENDING');
  assert.equal(check.rolloutPendingUntil, new Date(NOW + BUDGET_MS).toISOString());
  assert.deepEqual(deadlineCommands, [
    ['SET', DEADLINE_KEY, String(NOW + BUDGET_MS)],
    ['GET', DEADLINE_KEY],
  ]);
});

test('the first deadline holds; past it the key is EMPTY', async () => {
  const claimedAt = NOW - BUDGET_MS - 60_000;
  const { check } = await readCheck({ meta: writerMeta(PREVIOUS_KEY), deadline: claimedAt + BUDGET_MS });
  assert.equal(check.status, 'EMPTY');
});

test('a writer already on the read key version gets no grace', async () => {
  const { check, deadlineCommands } = await readCheck({ meta: writerMeta(KEY) });
  assert.equal(check.status, 'EMPTY');
  assert.deepEqual(deadlineCommands, []);
});

test('a stale or failed previous-version writer gets no grace', async () => {
  const stale = await readCheck({
    meta: writerMeta(PREVIOUS_KEY, { fetchedAt: NOW - BUDGET_MS - 60_000 }),
  });
  assert.notEqual(stale.check.status, 'ROLLOUT_PENDING');
  assert.deepEqual(stale.deadlineCommands, []);

  const failed = await readCheck({ meta: writerMeta(PREVIOUS_KEY, { status: 'error' }) });
  assert.notEqual(failed.check.status, 'ROLLOUT_PENDING');
  assert.deepEqual(failed.deadlineCommands, []);
});

test('preview deployments never open the window', async () => {
  const { check, deadlineCommands } = await readCheck({ meta: writerMeta(PREVIOUS_KEY) }, { vercelEnv: 'preview' });
  assert.equal(check.status, 'EMPTY');
  assert.deepEqual(deadlineCommands, []);
});

test('present data is classified on its own merits', async () => {
  const { check, deadlineCommands } = await readCheck({ meta: writerMeta(PREVIOUS_KEY), dataPresent: true });
  assert.notEqual(check.status, 'ROLLOUT_PENDING');
  assert.deepEqual(deadlineCommands, []);
});

test('a rollout window also covers keys whose missing data is otherwise a failure', () => {
  const { classifyKey, BOOTSTRAP_KEYS, MISSING_DATA_IS_FAILURE_KEYS } = __testing__;
  const name = 'canadaRoads';
  assert.ok(MISSING_DATA_IS_FAILURE_KEYS.has(name));
  const key = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
  const ctx = (rolloutUntil) => ({
    keyStrens: new Map(),
    keyErrors: new Map(),
    keyMetaValues: new Map([[SEED_META[name].key, JSON.stringify({ fetchedAt: NOW, recordCount: 1 })]]),
    keyMetaErrors: new Map(),
    activationStates: new Map(),
    rolloutPendingUntilMs: new Map(rolloutUntil ? [[name, rolloutUntil]] : []),
    now: NOW,
  });
  assert.equal(classifyKey(name, key, { allowOnDemand: false }, ctx(null)).status, 'EMPTY');
  assert.equal(classifyKey(name, key, { allowOnDemand: false }, ctx(NOW + 60_000)).status, 'ROLLOUT_PENDING');
});

// Review on #9046: staleness budgets reach 400 days (resilienceStaticIndex).
// A writer that never moves to the new version would keep an absent key at
// warn for that long. The gap being covered is one writer tick, not the budget.
test('the window is the staleness budget, capped at one day', () => {
  assert.equal(KEY_VERSION_ROLLOUT_MAX_MS, 24 * 60 * 60 * 1_000);
  assert.equal(keyVersionRolloutDurationMs(SEED_META[NAME]), BUDGET_MS);
  assert.equal(keyVersionRolloutDurationMs(SEED_META.resilienceStaticIndex), KEY_VERSION_ROLLOUT_MAX_MS);
});
