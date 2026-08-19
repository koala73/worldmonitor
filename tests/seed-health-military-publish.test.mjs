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
const { __testing__: healthTesting } = await import('../api/health.js');

const STALE_META_KEYS = new Set([
  'seed-meta:military-forecast-inputs',
  'seed-meta:military-surges',
]);
const MISSING_META_KEYS = new Set();
const RESILIENCE_INTERVAL_PROBE_KEY = 'resilience:intervals:v11:US';
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

function installSeedHealthPipelineMock({
  missingMetaKeys = MISSING_META_KEYS,
  militaryBasesActive = false,
  militaryBasesAgeMin = 0,
  militaryBasesRecords = 125_380,
} = {}) {
  const now = Date.now();
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map(([op, key]) => {
      if (op === 'EXISTS') {
        // The bases activation gate is the active-version pointer. atomicSwitch
        // writes it in the SAME EVAL as seed-meta, so it is present exactly
        // when the seeder has published at least once.
        if (key === 'military:bases:active') return { result: militaryBasesActive ? 1 : 0 };
        return { result: 0 };
      }
      assert.equal(op, 'GET');

      if (missingMetaKeys.has(key)) return { result: null };

      if (key === 'seed-meta:military:bases') {
        return {
          result: JSON.stringify({
            fetchedAt: now - militaryBasesAgeMin * 60 * 1000,
            recordCount: militaryBasesRecords,
          }),
        };
      }

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
    // #6845 item 3: the bases corpus previously had no staleness coverage on
    // either surface — /api/health checked only the presence of the active
    // pointer. Both registries are pinned here so the alarm cannot silently
    // regress.
    ['military:bases', 'militaryBases', 'seed-meta:military:bases'],
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

function classifyMilitaryBases(meta, now = Date.parse('2026-08-19T12:00:00.000Z')) {
  const name = 'militaryBases';
  const dataKey = healthTesting.STANDALONE_KEYS[name];
  const metaKey = healthTesting.SEED_META[name].key;
  return healthTesting.classifyKey(name, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 16]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify(meta)]]),
    keyMetaErrors: new Map(),
    now,
  });
}

test('api health reports stale military bases metadata through the active pointer', () => {
  const now = Date.parse('2026-08-19T12:00:00.000Z');
  const entry = classifyMilitaryBases({
    fetchedAt: now - (60 * 24 * 60 + 1) * 60_000,
    recordCount: 125_380,
  }, now);

  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(entry.maxStaleMin, 86_400);
});

test('api health reports partial military bases metadata through the active pointer', () => {
  const now = Date.parse('2026-08-19T12:00:00.000Z');
  const entry = classifyMilitaryBases({
    fetchedAt: now - 60_000,
    recordCount: 99_999,
  }, now);

  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(entry.records, 99_999);
  assert.equal(entry.minRecordCount, 100_000);
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

test('military bases staleness is visible in seed-health once activated (#6845 item 3)', async () => {
  // 61 days old against a 43200-minute (30d) interval: stale fires at 2x,
  // i.e. one fully missed cycle.
  installSeedHealthPipelineMock({ militaryBasesActive: true, militaryBasesAgeMin: 61 * 24 * 60 });

  const response = await handler(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.seeds['military:bases'].status, 'stale');
  assert.equal(body.seeds['military:bases'].stale, true);
});

test('a never-published bases corpus reads as pending-activation, not missing (#6845 item 3)', async () => {
  // atomicSwitch writes the pointer and seed-meta in one EVAL, so "never
  // published" is pointer AND seed-meta both absent. That must read as a
  // healthy pending state, not a degraded one.
  installSeedHealthPipelineMock({
    militaryBasesActive: false,
    missingMetaKeys: new Set([...MISSING_META_KEYS, 'seed-meta:military:bases']),
  });

  const response = await handler(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.seeds['military:bases'].status, 'pending-activation');
  assert.equal(body.seeds['military:bases'].stale, false);
});

test('a published bases corpus whose seed-meta vanished alarms, not pends (#6806)', async () => {
  // The counterweight to the pending-activation grace above, and the reason
  // that gate reads the pointer rather than a separate seed-activated:* marker.
  // atomicSwitch writes pointer and seed-meta together, so a live pointer with
  // no seed-meta means the freshness marker was lost AFTER a real publish —
  // exactly the #6806 case the repair path exists for. Softening it to a
  // healthy pending state would rebuild the blind spot this item closed.
  installSeedHealthPipelineMock({
    militaryBasesActive: true,
    missingMetaKeys: new Set([...MISSING_META_KEYS, 'seed-meta:military:bases']),
  });

  const response = await handler(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }));
  const body = await response.json();

  assert.equal(body.seeds['military:bases'].status, 'missing');
  assert.equal(body.seeds['military:bases'].stale, true);
});

test('an activated but degenerate bases corpus alarms on integrity (#6845 item 3)', async () => {
  // Fresh timestamp, but a corpus far under the 100k floor: a partial seed
  // must not read as a healthy quiet cycle.
  installSeedHealthPipelineMock({ militaryBasesActive: true, militaryBasesRecords: 3 });

  const response = await handler(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  }));
  const body = await response.json();

  assert.notEqual(body.seeds['military:bases'].status, 'ok');
  assert.notEqual(body.seeds['military:bases'].status, 'pending-activation');
});
