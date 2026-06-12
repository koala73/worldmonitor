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

function installSeedHealthPipelineMock(portwatchRecordCount, { missingPortwatchMeta = false } = {}) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map((command) => {
      const [op, key] = command;
      assert.equal(op, 'GET');
      if (key === PORTWATCH_META_KEY) {
        if (missingPortwatchMeta) return { result: null };
        return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: portwatchRecordCount }) };
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
      return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
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
