import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

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

const META_KEY = 'seed-meta:resilience:intervals';
const PROBE_KEY = 'resilience:intervals:v8:US';
const METHODOLOGY = 'weight-perturbation-sensitivity-v3';
const SOURCE_VERSION = `resilience-intervals:resilience:intervals:v8:${METHODOLOGY}`;

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

test('seed-health flags fresh resilience interval meta when the current v8 data probe is absent', async () => {
  installPipelineMock(new Map([
    [META_KEY, {
      fetchedAt: Date.now(),
      recordCount: 196,
      sourceVersion: SOURCE_VERSION,
    }],
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
  });
});

test('seed-health keeps resilience intervals green when fresh meta matches the current probe methodology', async () => {
  installPipelineMock(new Map([
    [META_KEY, {
      fetchedAt: Date.now(),
      recordCount: 196,
      sourceVersion: SOURCE_VERSION,
    }],
    [PROBE_KEY, {
      p05: 65.2,
      p95: 72.8,
      _formula: 'pc',
      computedAt: '2026-06-04T18:03:20.983Z',
      methodology: METHODOLOGY,
    }],
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
});
