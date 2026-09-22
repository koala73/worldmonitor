import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler, { handleHealth, __testing__ } from '../api/health.js';
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
  CHINA_COVERAGE_SUMMARY_KEY,
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

function classifyRetained(name, { now, recordCount, fetchedAt }) {
  const key = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
  return classifyKey(
    name,
    key,
    { allowOnDemand: false },
    {
      keyStrens: new Map([[key, 128]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[
        SEED_META[name].key,
        JSON.stringify({ fetchedAt, recordCount }),
      ]]),
      keyMetaErrors: new Map(),
      activationStates: new Map(
        Object.keys(ACTIVATION_MARKERS).map((markerName) => [markerName, false]),
      ),
      rolloutPendingUntilMs: new Map(),
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

test('retained FRED data becomes STALE_SEED at each unchanged health budget', () => {
  const now = DEPLOYED_AT;
  for (const { name, recordCount, maxStaleMin } of [
    { name: 'fredRatesSeeder', recordCount: 24, maxStaleMin: 180 },
    { name: 'fredBatch', recordCount: 1, maxStaleMin: 1500 },
    { name: 'economicStress', recordCount: 1, maxStaleMin: 180 },
  ]) {
    const entry = classifyRetained(name, {
      now,
      recordCount,
      fetchedAt: now - (maxStaleMin + 1) * 60_000,
    });
    assert.equal(entry.status, 'STALE_SEED', name);
    assert.equal(entry.maxStaleMin, maxStaleMin, name);
  }
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

function installHealthPipelineMock(recordCount, {
  metaOverrides = {},
  chinaCoverageSummary,
} = {}) {
  let sweepCommands;
  let failureSignature = '';
  let failureLogPushes = 0;
  const educationCountries = Object.fromEntries(
    Array.from({ length: 26 * 26 }, (_, index) => {
      const code = String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26));
      return [code, { value: 50, year: 2025 }];
    }),
  );
  const healthyChinaSummary = {
    schemaVersion: 1,
    countryCode: 'CN',
    status: 'healthy',
    evaluatedAt: new Date(DEPLOYED_AT).toISOString(),
    counts: { total: 1, launched: 1, planned: 0, blocked: 0, healthy: 1, degraded: 0, unavailable: 0 },
    entries: [{ id: 'market.mock', launchStatus: 'launched', status: 'healthy', reasonCodes: [] }],
  };
  const configsByMetaKey = Object.values(SEED_META).reduce((map, config) => {
    const configs = map.get(config.key) ?? [];
    configs.push(config);
    map.set(config.key, configs);
    return map;
  }, new Map());
  const healthyMeta = (key) => {
    const configs = configsByMetaKey.get(key) ?? [];
    const meta = {
      fetchedAt: DEPLOYED_AT,
      recordCount: Math.max(10_000, ...configs.map((config) => config.minRecordCount ?? 0)),
    };
    if (key === SEED_META.globalTendersContractsFinder.key) meta.sourceState = 'ok';
    for (const config of configs) {
      if (config.requiredRedistributionPolicyVersion != null) {
        meta.redistributionPolicyVersion = config.requiredRedistributionPolicyVersion;
      }
      if (config.minRankableRecordCount != null) {
        meta.rankableRecordCount = Math.max(meta.rankableRecordCount ?? 0, config.minRankableRecordCount);
      }
      if (config.minPoolCounts) {
        meta.poolCounts = Object.fromEntries(Object.entries(config.minPoolCounts)
          .map(([pool, floor]) => [pool, floor + 20]));
      }
      if (config.requireCoverage || config.requireVulnerabilityCoverage) {
        meta.coverage = {
          status: 'healthy',
          completedPages: 1,
          failedPages: 0,
          completionRatio: 1,
          rejectedCount: 0,
          ...Object.fromEntries(Object.entries(config.requireVulnerabilityCoverage ?? {})
            .map(([field, floor]) => [field, floor])),
        };
      }
      if (config.requireContentFreshness) {
        const criticalCountries = config.requireContentFreshness.countries;
        meta.contentFreshness = {
          coveredCount: 200,
          freshCount: 200,
          staleCount: 0,
          unknownCount: 0,
          criticalCountries,
          criticalFreshCount: criticalCountries.length,
          criticalOldestObservedAt: DEPLOYED_AT - 60_000,
        };
      }
      if (config.decisionGroups) {
        meta.groupStates = Object.fromEntries(config.decisionGroups.map((group) => [group, 'available']));
        meta.groupCounts = {
          populated: config.decisionGroups.length,
          partial: 0,
          stale: 0,
          unavailable: 0,
          healthyQuiet: 0,
          operationallyCovered: config.decisionGroups.length,
        };
      }
      if (config.requireResilienceCacheState) {
        meta._formula = 'pc';
        meta._educationState = 'education-on';
        meta._intervalMethodology = 'weight-perturbation-sensitivity-v3';
      }
    }
    return meta;
  };
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const isSweep = commands.some(([op, key]) => op === 'SET' && key === FRED_RATES_ROLLOUT_DEADLINE_KEY);
    if (isSweep) sweepCommands = commands;

    const results = commands.map(([op, key, value]) => {
      if (op === 'GET' && metaOverrides[key]) {
        return { result: JSON.stringify({ ...healthyMeta(key), ...metaOverrides[key] }) };
      }
      if (op === 'STRLEN') return { result: key === KEY && recordCount == null ? 0 : 128 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'EXISTS') return { result: key === ACTIVATION_MARKERS[NAME] ? 0 : 1 };
      if (op === 'HEXISTS') return { result: 1 };
      if (op === 'GET' && key === FRED_RATES_ROLLOUT_DEADLINE_KEY) return { result: String(UNTIL) };
      if (op === 'GET' && key === SEED_META[NAME].key) {
        return {
          result: recordCount == null
            ? null
            : JSON.stringify({ fetchedAt: DEPLOYED_AT, recordCount }),
        };
      }
      if (op === 'GET' && key === CHINA_COVERAGE_SUMMARY_KEY) {
        return { result: JSON.stringify(chinaCoverageSummary ?? healthyChinaSummary) };
      }
      if (op === 'GET' && key === STANDALONE_KEYS.educationAttainment) {
        return { result: JSON.stringify({ countries: educationCountries }) };
      }
      if (op === 'GET' && String(key).includes('health:verdict')) return { result: null };
      if (op === 'GET' && key === 'health:failure-log-sig') return { result: failureSignature };
      if (op === 'GET') {
        return { result: JSON.stringify(healthyMeta(key)) };
      }
      if (op === 'LPUSH' && key === 'health:failure-log') failureLogPushes++;
      if (op === 'SET' && key === 'health:failure-log-sig') failureSignature = value;
      if (op === 'DEL' && key === 'health:failure-log-sig') failureSignature = '';
      return { result: 'OK' };
    });

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    getSweepCommands: () => sweepCommands,
    getFailureLogPushes: () => failureLogPushes,
  };
}

async function readProductionHealth(recordCount) {
  const mock = installHealthPipelineMock(recordCount);
  const response = await handleHealth(new Request('https://api.worldmonitor.app/api/health', {
    headers: { 'x-worldmonitor-key': 'fred-health-test-key' },
  }), undefined, { now: DEPLOYED_AT });
  return { body: await response.json(), getSweepCommands: mock.getSweepCommands };
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

test('compact handler contains one metadata-backed warning and dedupes its incident history', async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  process.env.VERCEL_ENV = 'production';
  Date.now = () => DEPLOYED_AT;

  try {
    const mock = installHealthPipelineMock(18);
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(Promise.resolve(promise)) };
    const read = async () => {
      const response = await handler(
        new Request('https://api.worldmonitor.app/api/health?compact=1'),
        ctx,
      );
      const body = await response.json();
      await Promise.all(pending.splice(0));
      return body;
    };

    const first = await read();
    assert.equal(first.status, 'HEALTHY');
    assert.equal(first.summary.warn, 1);
    assert.equal(first.summary.containedWarn, 1);
    assert.deepEqual(Object.keys(first.problems), [NAME]);
    assert.equal(first.problems[NAME].status, 'COVERAGE_PARTIAL');
    assert.equal(first.problems[NAME].records, 18);
    assert.equal(mock.getFailureLogPushes(), 1);

    const second = await read();
    assert.equal(second.status, 'HEALTHY');
    assert.equal(second.summary.warn, 1);
    assert.equal(second.summary.containedWarn, 1);
    assert.deepEqual(second.problems, first.problems);
    assert.equal(mock.getFailureLogPushes(), 1, 'an unchanged diagnostic signature must not LPUSH twice');
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('handler contains multiple served warnings up to the 3% fleet boundary', async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalEnv = Object.fromEntries(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV']
    .map((key) => [key, process.env[key]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
  process.env.VERCEL_ENV = 'production';
  Date.now = () => DEPLOYED_AT;
  const pending = [];
  const read = async () => {
    const response = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'),
      { waitUntil: (promise) => pending.push(Promise.resolve(promise)) });
    const body = await response.json();
    await Promise.all(pending.splice(0));
    return body;
  };
  try {
    installHealthPipelineMock(24, { metaOverrides: {
      [SEED_META.ecbEstr.key]: { sourceState: 'degraded' },
    } });
    const bundle = await read();
    assert.equal(bundle.status, 'HEALTHY');
    assert.equal(bundle.summary.warn, 4);
    assert.equal(bundle.summary.containedWarn, 4);
    assert.ok(bundle.summary.warn / bundle.summary.total < 0.03);
    for (const name of ['ecbEstr', 'ecbEuribor3m', 'ecbEuribor6m', 'ecbEuribor1y']) {
      assert.equal(bundle.problems[name].status, 'SEED_ERROR');
    }

    installHealthPipelineMock(24, { metaOverrides: {
      [SEED_META.diseaseOutbreaks.key]: {
        recordCount: 159,
        newestItemAt: DEPLOYED_AT - 14_092 * 60_000,
        maxContentAgeMin: 12_960,
      },
      [SEED_META.electricityPrices.key]: {
        recordCount: 17,
        fetchedAt: DEPLOYED_AT - 3_170 * 60_000,
      },
      [SEED_META.portwatchPortActivity.key]: { recordCount: 168 },
    } });
    const current = await read();
    assert.equal(current.status, 'HEALTHY');
    assert.equal(current.summary.warn, 3);
    assert.equal(current.summary.containedWarn, 3);
    assert.deepEqual(Object.fromEntries(Object.entries(current.problems)
      .map(([name, entry]) => [name, entry.status])), {
      diseaseOutbreaks: 'STALE_CONTENT',
      electricityPrices: 'STALE_SEED',
      portwatchPortActivity: 'COVERAGE_PARTIAL',
    });

    const chinaProblems = [{
      id: 'market.china-corporate-disclosures',
      status: 'degraded',
      reasonCodes: ['CHINA_COVERAGE_PARTIAL'],
    }];
    const degradedSummary = {
      schemaVersion: 1,
      countryCode: 'CN',
      status: 'degraded',
      evaluatedAt: new Date(DEPLOYED_AT - 60_000).toISOString(),
      counts: { total: 1, launched: 1, planned: 0, blocked: 0, healthy: 0, degraded: 1, unavailable: 0 },
      entries: chinaProblems.map((problem) => ({ ...problem, launchStatus: 'launched' })),
      degradedStreak: 4,
      degradedProblemKey: JSON.stringify(chinaProblems),
      lastHealthyAt: DEPLOYED_AT - 181 * 60_000,
    };
    installHealthPipelineMock(24, { chinaCoverageSummary: degradedSummary });
    const body = await read();
    assert.equal(body.status, 'HEALTHY');
    assert.equal(body.summary.warn, 1);
    assert.equal(body.summary.containedWarn, 1);
    assert.equal(body.problems?.chinaCoverage?.status, 'CHINA_DEGRADED');
    assert.equal(body.pending?.chinaCoverage, undefined);

    installHealthPipelineMock(24, { chinaCoverageSummary: {
      ...degradedSummary,
      evaluatedAt: new Date(DEPLOYED_AT + 1).toISOString(),
    } });
    const futureBody = await read();
    assert.equal(futureBody.status, 'WARNING');
    assert.equal(futureBody.summary.containedWarn, 0);
    assert.equal(futureBody.problems?.chinaCoverage?.status, 'CHINA_DEGRADED');

    installHealthPipelineMock(24, { chinaCoverageSummary: {
      ...degradedSummary,
      counts: { total: 2, launched: 2, planned: 0, blocked: 0, healthy: 1, degraded: 0, unavailable: 1 },
      entries: [
        { id: 'market.china-healthy', launchStatus: 'launched', status: 'healthy', reasonCodes: [] },
        { id: 'market.china-unavailable', launchStatus: 'launched', status: 'unavailable', reasonCodes: ['UPSTREAM_UNAVAILABLE'] },
      ],
    } });
    const unavailableBody = await read();
    assert.equal(unavailableBody.status, 'WARNING');
    assert.equal(unavailableBody.summary.warn, 1);
    assert.equal(unavailableBody.summary.containedWarn, 0);
    assert.equal(unavailableBody.problems?.chinaCoverage?.status, 'CHINA_DEGRADED');
    assert.deepEqual(unavailableBody.problems?.chinaCoverage?.problems, [{
      id: 'market.china-unavailable',
      status: 'unavailable',
      reasonCodes: ['UPSTREAM_UNAVAILABLE'],
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
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
