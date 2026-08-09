// #6263 item 3: `intelligence:market-implications` was absent from
// api/seed-health.js while its sibling `news:insights` was registered, so the
// operator endpoint could not report the key at all.
//
// Not to be confused with tests/market-implications-seed-health.test.mjs,
// which covers the PRODUCER side — scripts/seed-forecasts.mjs's failure-meta
// contract as read by api/health.js. This file covers only the /api/seed-health
// registration and the freshness budget that endpoint applies to the key.
//
// Registered on the same terms as that sibling: a coarse age view whose
// intervalMin*2 budget must equal the api/health.js `marketImplications`
// budget. Asserted BEHAVIORALLY — the endpoint is driven at the boundary and
// one minute past it — rather than by reading the literal out of the source,
// so a change to either side that breaks the mirror fails here.

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

const { handleSeedHealth } = await import('../api/seed-health.js');
const { __testing__ } = await import('../api/health.js');

const DOMAIN = 'intelligence:market-implications';
const META_KEY = 'seed-meta:intelligence:market-implications';
const PREDICTION_META_KEY = 'seed-meta:prediction:markets';
const RESILIENCE_INTERVAL_PROBE_KEY = 'resilience:intervals:v9:US';
const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';
const TEST_NOW = Date.parse('2026-08-06T09:00:00.000Z');
const ONE_MIN_MS = 60_000;

// The single source of truth for the budget both surfaces must agree on.
const MAX_STALE_MIN = __testing__.SEED_META.marketImplications.maxStaleMin;

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

function installPipelineMock(marketImplicationsMeta, now = TEST_NOW) {
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map((command) => {
      const [op, key] = command;
      if (op === 'EXISTS') {
        assert.match(String(key), /^seed-activated:/, 'EXISTS is only used for activation markers');
        return { result: 0 };
      }
      assert.equal(op, 'GET');
      if (key === META_KEY) {
        return { result: marketImplicationsMeta == null ? null : JSON.stringify(marketImplicationsMeta) };
      }
      if (key === PREDICTION_META_KEY) {
        return {
          result: JSON.stringify({
            fetchedAt: now,
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
      // Isolate the entry under test: keep every unrelated coverage-gated feed
      // comfortably above its floor so an unrelated contract cannot decide the
      // assertions below.
      return { result: JSON.stringify({ fetchedAt: now, recordCount: 10_000 }) };
    });
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

async function readSeedHealth(now = TEST_NOW) {
  const req = new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  });
  const res = await handleSeedHealth(req, { now });
  return (await res.json()).seeds[DOMAIN];
}

// Served vintage the producer holds `fetchedAt` at, per the failure-writer
// contract in scripts/seed-forecasts.mjs.
const servedMeta = (ageMin) => ({
  fetchedAt: TEST_NOW - ageMin * ONE_MIN_MS,
  recordCount: 5,
  status: 'ok',
});

test('seed-health reports the market-implications key at all', async () => {
  installPipelineMock(servedMeta(30));
  const entry = await readSeedHealth();

  assert.ok(entry, `${DOMAIN} must be registered in SEED_DOMAINS`);
  assert.equal(entry.status, 'ok');
  assert.equal(entry.stale, false);
  assert.equal(entry.recordCount, 5, 'the count describes the cards actually being served');
});

test('seed-health holds market-implications healthy right up to the api/health.js budget', async () => {
  installPipelineMock(servedMeta(MAX_STALE_MIN));
  const entry = await readSeedHealth();

  assert.equal(entry.stale, false, `${MAX_STALE_MIN}min is the boundary, not past it`);
  assert.equal(entry.ageMinutes, MAX_STALE_MIN);
});

test('seed-health stales market-implications one minute past the api/health.js budget', async () => {
  // The mirror that matters: intervalMin*2 here must equal maxStaleMin there,
  // or the two surfaces disagree about when an operator should act. Because
  // the producer holds `fetchedAt` at the served vintage rather than advancing
  // it on a miss, a stage that stops entirely reliably reaches this state.
  installPipelineMock(servedMeta(MAX_STALE_MIN + 1));
  const entry = await readSeedHealth();

  assert.equal(entry.stale, true);
  assert.equal(entry.status, 'stale');
});

test('seed-health surfaces a market-implications run with nothing servable as an error', async () => {
  // The producer's fail-closed branch: no last-good cards to hold a content
  // clock against, so it writes the zero-record error meta.
  installPipelineMock({
    fetchedAt: TEST_NOW - ONE_MIN_MS,
    recordCount: 0,
    status: 'error',
    errorReason: 'llm_no_response',
  });
  const entry = await readSeedHealth();

  assert.equal(entry.status, 'error');
  assert.equal(entry.stale, true);
});

test('seed-health reports a never-published market-implications key as missing', async () => {
  installPipelineMock(null);
  const entry = await readSeedHealth();

  assert.equal(entry.status, 'missing');
  assert.equal(entry.stale, true);
});
