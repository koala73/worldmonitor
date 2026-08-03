import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  RESILIENCE_PILLAR_COMBINE_ENABLED: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
  RESILIENCE_SCHEMA_V2_ENABLED: process.env.RESILIENCE_SCHEMA_V2_ENABLED,
};

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';

const { default: handler } = await import('../api/seed-health.js');

const PORTWATCH_META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const DECISION_META_KEY = 'seed-meta:intelligence:china-decision-signals';
const PREDICTION_META_KEY = 'seed-meta:prediction:markets';
const RESILIENCE_INTERVAL_PROBE_KEY = 'resilience:intervals:v9:US';
const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
  process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function installSeedHealthPipelineMock(
  portwatchRecordCount,
  { missingPortwatchMeta = false, portwatchContentFreshness, chinaDecisionMeta } = {},
) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map((command) => {
      const [op, key] = command;
      // #4927: activation-gated entries add EXISTS probes on their
      // seed-activated:* markers; absent in this harness.
      if (op === 'EXISTS') {
        assert.match(String(key), /^seed-activated:/, 'EXISTS is only used for activation markers');
        return { result: 0 };
      }
      assert.equal(op, 'GET');
      if (key === PORTWATCH_META_KEY) {
        if (missingPortwatchMeta) return { result: null };
        return {
          result: JSON.stringify({
            fetchedAt: Date.now(),
            recordCount: portwatchRecordCount,
            ...(portwatchContentFreshness ? { contentFreshness: portwatchContentFreshness } : {}),
          }),
        };
      }
      if (key === DECISION_META_KEY && chinaDecisionMeta) {
        return { result: JSON.stringify(chinaDecisionMeta) };
      }
      if (key === PREDICTION_META_KEY) {
        return {
          result: JSON.stringify({
            fetchedAt: Date.now(),
            recordCount: 38,
            poolCounts: { geopolitical: 18, tech: 12, finance: 8 },
          }),
        };
      }
      if (key === RESILIENCE_INTERVAL_PROBE_KEY) {
        return {
          result: JSON.stringify({
            p05: 65.2,
            p95: 72.8,
            _formula: 'pc',
            methodology: RESILIENCE_INTERVAL_METHODOLOGY,
            computedAt: '2026-06-11T12:00:00.000Z',
          }),
        };
      }
      // This fixture isolates the PortWatch entry. Keep every unrelated
      // coverage-gated feed above its floor so a new minRecordCount contract
      // cannot turn the aggregate warning for an unrelated reason.
      return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 10_000 }) };
    });
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

async function readSeedHealth() {
  const req = new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  });
  const res = await handler(req);
  const body = await res.json();
  return { res, body };
}

test('seed-health flags fresh PortWatch port activity below 174 countries as coverage_partial', async () => {
  installSeedHealthPipelineMock(139);

  const { res, body } = await readSeedHealth();
  const entry = body.seeds['supply_chain:portwatch-ports'];

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'coverage_partial');
  assert.equal(entry.stale, true);
  assert.equal(entry.recordCount, 139);
  assert.equal(entry.minRecordCount, 174);
});

test('seed-health treats missing PortWatch recordCount as coverage_partial', async () => {
  installSeedHealthPipelineMock(undefined);

  const { res, body } = await readSeedHealth();
  const entry = body.seeds['supply_chain:portwatch-ports'];

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'coverage_partial');
  assert.equal(entry.stale, true);
  assert.equal(entry.recordCount, null);
  assert.equal(entry.minRecordCount, 174);
});

test('seed-health includes PortWatch minRecordCount when seed-meta is missing', async () => {
  installSeedHealthPipelineMock(undefined, { missingPortwatchMeta: true });

  const { res, body } = await readSeedHealth();
  const entry = body.seeds['supply_chain:portwatch-ports'];

  assert.equal(res.status, 503);
  assert.equal(body.overall, 'degraded');
  assert.equal(entry.status, 'missing');
  assert.equal(entry.stale, true);
  assert.equal(entry.recordCount, null);
  assert.equal(entry.minRecordCount, 174);
});

test('seed-health keeps PortWatch port activity OK at the 174-country recovery floor', async () => {
  installSeedHealthPipelineMock(174);

  const { res, body } = await readSeedHealth();
  const entry = body.seeds['supply_chain:portwatch-ports'];

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'healthy');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.stale, false);
  assert.equal(entry.recordCount, 174);
  assert.equal(entry.minRecordCount, 174);
});

test('seed-health flags stale decision-critical PortWatch content separately from heartbeat', async () => {
  const now = Date.now();
  installSeedHealthPipelineMock(174, {
    portwatchContentFreshness: {
      budgetMinutes: 4320,
      coveredCount: 174,
      freshCount: 173,
      staleCount: 1,
      unknownCount: 0,
      criticalCountries: ['CN', 'HK'],
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalMissingCountries: 0,
      criticalOldestObservedAt: now - (73 * 60 * 60 * 1000),
    },
  });

  const { res, body } = await readSeedHealth();
  const entry = body.seeds['supply_chain:portwatch-ports'];

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'stale_content');
  assert.equal(entry.stale, true);
  assert.equal(entry.contentFreshness.usable, true);
  assert.deepEqual(entry.contentFreshness.criticalStaleCountries, ['CN']);
});

test('seed-health publishes partial and stale China decision groups like /api/health', async () => {
  installSeedHealthPipelineMock(174, {
    chinaDecisionMeta: {
      fetchedAt: Date.now(),
      recordCount: 3,
      groupStates: {
        macro: 'partial',
        'policy-enforcement': 'stale',
        'cross-strait-activity': 'available',
        'corporate-disclosures': 'unavailable',
        'corridor-conditions': 'unavailable',
        'activity-nowcast': 'unavailable',
      },
      groupCounts: {
        populated: 1,
        partial: 1,
        stale: 1,
        unavailable: 3,
        healthyQuiet: 0,
        operationallyCovered: 3,
      },
      unavailableCauses: {
        'corporate-disclosures': 'healthy_quiet_window',
        'corridor-conditions': 'insufficient_data',
        'activity-nowcast': 'upstream_unavailable',
      },
    },
  });

  const { body } = await readSeedHealth();
  const entry = body.seeds['intelligence:china-decision-signals'];

  assert.deepEqual(entry.partialGroups, ['macro']);
  assert.deepEqual(entry.staleGroups, ['policy-enforcement']);
  assert.deepEqual(entry.quietGroups, ['corporate-disclosures']);
});
