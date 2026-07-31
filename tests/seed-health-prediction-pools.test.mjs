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

function installSeedHealthPipelineMock(poolCounts, { fetchedAt = Date.now() } = {}) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map((command) => {
      const [op, key] = command;
      if (op === 'EXISTS') return { result: 0 };
      assert.equal(op, 'GET');
      if (key === PREDICTION_META_KEY) {
        return {
          result: JSON.stringify({
            fetchedAt,
            recordCount: 38,
            ...(poolCounts === undefined ? {} : { poolCounts }),
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

test('seed-health flags a fresh prediction snapshot with an empty pool as coverage_partial', async () => {
  installSeedHealthPipelineMock({ geopolitical: 18, tech: 0, finance: 20 });

  const { res, body } = await readSeedHealth();
  const entry = body.seeds['prediction:markets'];

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'coverage_partial');
  assert.equal(entry.stale, false);
  assert.equal(entry.coveragePartial, true);
  assert.deepEqual(entry.poolCounts, { geopolitical: 18, tech: 0, finance: 20 });
  assert.deepEqual(entry.minPoolCounts, { geopolitical: 1, tech: 1, finance: 1 });
});

test('seed-health reports stale before per-pool coverage when both apply', async () => {
  installSeedHealthPipelineMock(
    { geopolitical: 18, tech: 0, finance: 20 },
    { fetchedAt: Date.now() - 100 * 60_000 },
  );

  const { body } = await readSeedHealth();
  const entry = body.seeds['prediction:markets'];

  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'stale');
  assert.equal(entry.stale, true);
  assert.equal(entry.coveragePartial, true);
  assert.deepEqual(entry.poolCounts, { geopolitical: 18, tech: 0, finance: 20 });
});

test('seed-health fails closed when prediction pool metadata is missing', async () => {
  installSeedHealthPipelineMock(undefined);

  const { body } = await readSeedHealth();
  const entry = body.seeds['prediction:markets'];

  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'coverage_partial');
  assert.equal(entry.coveragePartial, true);
  assert.equal(Object.hasOwn(entry, 'poolCounts'), false);
  assert.deepEqual(entry.minPoolCounts, { geopolitical: 1, tech: 1, finance: 1 });
});

test('seed-health fails closed when prediction pool metadata is malformed', async () => {
  installSeedHealthPipelineMock({ geopolitical: 18, tech: '0', finance: 20 });

  const { body } = await readSeedHealth();
  const entry = body.seeds['prediction:markets'];

  assert.equal(body.overall, 'warning');
  assert.equal(entry.status, 'coverage_partial');
  assert.equal(entry.coveragePartial, true);
  assert.equal(Object.hasOwn(entry, 'poolCounts'), false);
});

test('seed-health keeps prediction markets healthy when every pool is populated', async () => {
  installSeedHealthPipelineMock({ geopolitical: 1, tech: 1, finance: 36 });

  const { res, body } = await readSeedHealth();
  const entry = body.seeds['prediction:markets'];

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'healthy');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.stale, false);
  assert.equal(Object.hasOwn(entry, 'coveragePartial'), false);
  assert.deepEqual(entry.poolCounts, { geopolitical: 1, tech: 1, finance: 36 });
});
