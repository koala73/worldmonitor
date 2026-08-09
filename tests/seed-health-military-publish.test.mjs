import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
};

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-key';

const { default: handler } = await import('../api/seed-health.js');

const STALE_META_KEYS = new Set([
  'seed-meta:military-forecast-inputs',
  'seed-meta:military-surges',
]);
const MISSING_META_KEYS = new Set();
const RESILIENCE_INTERVAL_PROBE_KEY = 'resilience:intervals:v9:US';
const seedHealthSource = readFileSync(resolve(import.meta.dirname, '../api/seed-health.js'), 'utf8');
const healthSource = readFileSync(resolve(import.meta.dirname, '../api/health.js'), 'utf8');

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function installSeedHealthPipelineMock({ missingMetaKeys = MISSING_META_KEYS } = {}) {
  const now = Date.now();
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map(([op, key]) => {
      if (op === 'EXISTS') return { result: 0 };
      assert.equal(op, 'GET');

      if (missingMetaKeys.has(key)) return { result: null };

      if (key === RESILIENCE_INTERVAL_PROBE_KEY) {
        return {
          result: JSON.stringify({
            p05: 65.2,
            p95: 72.8,
            _formula: 'pc',
            methodology: 'weight-perturbation-sensitivity-v3',
            computedAt: '2026-08-03T00:00:00.000Z',
          }),
        };
      }

      if (STALE_META_KEYS.has(key)) {
        return { result: JSON.stringify({ fetchedAt: now - 31 * 60 * 1000, recordCount: 1 }) };
      }

      return {
        result: JSON.stringify({ fetchedAt: now, recordCount: 10_000 }),
      };
    });

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('seed-health does not let a fresh military headline hide stale late-stage outputs', async () => {
  installSeedHealthPipelineMock();

  const response = await handler(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['military:flights'].status, 'ok');
  assert.equal(body.seeds['military-forecast-inputs'].status, 'stale');
  assert.equal(body.seeds['military-surges'].status, 'stale');
  assert.equal(body.seeds['military-forecast-inputs'].stale, true);
  assert.equal(body.seeds['military-surges'].stale, true);
});

test('military health registries keep early seed-health warning coverage', () => {
  for (const [domain, healthName, metaKey] of [
    ['military-forecast-inputs', 'militaryForecastInputs', 'seed-meta:military-forecast-inputs'],
    ['military-surges', 'militarySurges', 'seed-meta:military-surges'],
  ]) {
    const seedHealthMatch = seedHealthSource.match(
      new RegExp(`'${domain}':\\s*\\{\\s*key:\\s*'([^']+)',\\s*intervalMin:\\s*([0-9_]+)`),
    );
    assert.ok(seedHealthMatch, `api/seed-health.js must register ${domain}`);
    assert.equal(seedHealthMatch[1], metaKey, `${domain} meta key`);

    const healthMatch = healthSource.match(
      new RegExp(`${healthName}:\\s*\\{\\s*key:\\s*'([^']+)',\\s*maxStaleMin:\\s*([0-9_]+)`),
    );
    assert.ok(healthMatch, `api/health.js must register ${healthName}`);
    assert.equal(healthMatch[1], metaKey, `${healthName} meta key`);

    const seedHealthBudget = Number(seedHealthMatch[2].replaceAll('_', '')) * 2;
    const healthBudget = Number(healthMatch[2].replaceAll('_', ''));
    assert.ok(
      seedHealthBudget <= healthBudget,
      `${domain} seed-health warning (${seedHealthBudget}min) must not lag /api/health alarm (${healthBudget}min)`,
    );
  }
});

test('seed-health reports a missing late-stage write as degraded', async () => {
  installSeedHealthPipelineMock({ missingMetaKeys: STALE_META_KEYS });

  const response = await handler(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.overall, 'degraded');
  assert.equal(body.seeds['military:flights'].status, 'ok');
  assert.equal(body.seeds['military-forecast-inputs'].status, 'missing');
  assert.equal(body.seeds['military-surges'].status, 'missing');
  assert.equal(body.seeds['military-forecast-inputs'].stale, true);
  assert.equal(body.seeds['military-surges'].stale, true);
});
