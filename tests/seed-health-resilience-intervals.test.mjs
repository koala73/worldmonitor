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

const META_KEY = 'seed-meta:resilience:intervals';
const PROBE_KEY = 'resilience:intervals:v9:US';
const METHODOLOGY = 'weight-perturbation-sensitivity-v3';
const SOURCE_VERSION = `resilience-intervals:resilience:intervals:v9:${METHODOLOGY}`;

function intervalMeta(overrides = {}) {
  return {
    fetchedAt: Date.now(),
    recordCount: 196,
    sourceVersion: SOURCE_VERSION,
    ...overrides,
  };
}

function intervalPayload(overrides = {}) {
  return {
    p05: 65.2,
    p95: 72.8,
    _formula: 'pc',
    computedAt: '2026-06-04T18:03:20.983Z',
    methodology: METHODOLOGY,
    ...overrides,
  };
}

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

function installPipelineMock(values) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map((command) => {
      const [op, key] = command;
      // #4927: activation-gated entries add EXISTS probes on their
      // seed-activated:* markers; absent unless a test seeds them.
      if (op === 'EXISTS') {
        assert.match(String(key), /^seed-activated:/, 'EXISTS is only used for activation markers');
        return { result: values.has(key) ? 1 : 0 };
      }
      assert.equal(op, 'GET');
      const value = values.has(key)
        ? values.get(key)
        : String(key).startsWith('seed-meta:')
          ? { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'test' }
          : null;
      return { result: value == null ? null : JSON.stringify(value) };
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

test('seed-health flags fresh resilience interval meta when the current v9 data probe is absent', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'data_missing');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.equal(body.seeds['resilience:intervals'].recordCount, 196);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'data_missing',
    key: PROBE_KEY,
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
    requiredFormula: 'pc',
  });
});

test('seed-health keeps resilience intervals green when fresh meta matches the current probe methodology', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload()],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.seeds['resilience:intervals'].status, 'ok');
  assert.equal(body.seeds['resilience:intervals'].stale, false);
  assert.equal(body.seeds['resilience:intervals'].sourceVersion, SOURCE_VERSION);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.ok, true);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.key, PROBE_KEY);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.methodology, METHODOLOGY);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.formula, 'pc');
  assert.equal(body.seeds['resilience:intervals'].dataProbe.requiredFormula, 'pc');
});

test('seed-health flags resilience interval methodology mismatches', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload({ _formula: 'd6', methodology: 'weight-perturbation-sensitivity-v2' })],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'methodology_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'methodology_mismatch',
    key: PROBE_KEY,
    methodology: 'weight-perturbation-sensitivity-v2',
    formula: 'd6',
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
    requiredFormula: 'pc',
  });
});

test('seed-health flags resilience interval formula mismatches even when meta is fresh', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta()],
    [PROBE_KEY, intervalPayload({ _formula: 'd6' })],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'formula_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
    ok: false,
    status: 'formula_mismatch',
    key: PROBE_KEY,
    formula: 'd6',
    requiredFormula: 'pc',
    methodology: METHODOLOGY,
    requiredMethodology: METHODOLOGY,
    requiredSourceVersion: SOURCE_VERSION,
  });
});

test('seed-health flags malformed resilience interval payloads even when meta is fresh', async () => {
  const cases = [
    { name: 'missing p05', payload: intervalPayload({ p05: undefined }), p05: null, p95: 72.8 },
    { name: 'non-finite p95', payload: intervalPayload({ p95: Number.POSITIVE_INFINITY }), p05: 65.2, p95: null },
    { name: 'reversed bounds', payload: intervalPayload({ p05: 80, p95: 70 }), p05: 80, p95: 70 },
    { name: 'p05 below range', payload: intervalPayload({ p05: -1, p95: 70 }), p05: -1, p95: 70 },
    { name: 'p95 above range', payload: intervalPayload({ p05: 65, p95: 101 }), p05: 65, p95: 101 },
  ];

  for (const item of cases) {
    installPipelineMock(new Map([
      [META_KEY, intervalMeta()],
      [PROBE_KEY, item.payload],
    ]));

    const { res, body } = await readSeedHealth();

    assert.equal(res.status, 200, item.name);
    assert.equal(body.overall, 'warning', item.name);
    assert.equal(body.seeds['resilience:intervals'].status, 'data_invalid', item.name);
    assert.equal(body.seeds['resilience:intervals'].stale, true, item.name);
    assert.deepEqual(body.seeds['resilience:intervals'].dataProbe, {
      ok: false,
      status: 'data_invalid',
      key: PROBE_KEY,
      formula: 'pc',
      requiredFormula: 'pc',
      methodology: METHODOLOGY,
      requiredMethodology: METHODOLOGY,
      requiredSourceVersion: SOURCE_VERSION,
      p05: item.p05,
      p95: item.p95,
    }, item.name);
  }
});

test('seed-health flags resilience interval source-version mismatches', async () => {
  installPipelineMock(new Map([
    [META_KEY, intervalMeta({ sourceVersion: 'resilience-intervals:resilience:intervals:v7:old-methodology' })],
    [PROBE_KEY, intervalPayload()],
  ]));

  const { res, body } = await readSeedHealth();

  assert.equal(res.status, 200);
  assert.equal(body.overall, 'warning');
  assert.equal(body.seeds['resilience:intervals'].status, 'source_version_mismatch');
  assert.equal(body.seeds['resilience:intervals'].stale, true);
  assert.equal(
    body.seeds['resilience:intervals'].sourceVersion,
    'resilience-intervals:resilience:intervals:v7:old-methodology',
  );
  assert.equal(body.seeds['resilience:intervals'].dataProbe.ok, true);
  assert.equal(body.seeds['resilience:intervals'].dataProbe.requiredSourceVersion, SOURCE_VERSION);
});
