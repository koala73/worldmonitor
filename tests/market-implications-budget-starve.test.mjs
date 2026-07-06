// market_implications budget-starve handling (#4978).
//
// market_implications is the LAST forecast LLM stage (afterPublish) and shares
// the single 150s run budget with every upstream stage. When upstream stages
// are slow (e.g. deepseek-v4-flash 30s timeouts, #4944) they drain that budget
// before this stage runs; callForecastLLM then throws a budget error and
// returns null. The bug: the caller treated that starve identically to a real
// LLM failure and wrote a `status:'error'` seed-meta, so /api/health flipped to
// SEED_ERROR for benign, self-healing resource contention. A budget-starve must
// instead PRESERVE last-good (leaving seed-meta.fetchedAt untouched) so
// age-based STALE_SEED still escalates only if the starve persists past 2h.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAndSeedMarketImplications,
  __setRedisStoreForTests,
  __setForecastLlmTransportForTests,
  __setForecastLlmRunDeadlineForTests,
  __setForecastLlmCallOverrideForTests,
} from '../scripts/seed-forecasts.mjs';

// callForecastLLM's failure-reason contract (mirrors the FORECAST_LLM_FAILURE_*
// constants in seed-forecasts.mjs; not exported, asserted here as the wire value).
const BUDGET_EXHAUSTED = 'budget_exhausted';
const PROVIDER_FAILED = 'provider_failed';

const ENV_KEYS = ['OPENROUTER_API_KEY', 'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  __setRedisStoreForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
  __setForecastLlmCallOverrideForTests(null);
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const LAST_GOOD = [{
  ticker: 'LMT', name: 'Lockheed Martin', direction: 'long', timeframe: '1-3m',
  confidence: 0.7, title: 'Defense demand', narrative: 'n', risk_caveat: '', driver: '', transmission_chain: [],
}];

function seedLastGood(store) {
  store['intelligence:market-implications:v1'] = { cards: LAST_GOOD, generatedAt: '2026-07-06T13:00:00.000Z', model: 'prev-model' };
  store['seed-meta:intelligence:market-implications'] = { fetchedAt: 1783340000000, recordCount: 1, status: 'ok' };
}

test('run-budget starve preserves last-good and does NOT write a SEED_ERROR', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);

  // Real provider config so the LLM WOULD be invoked if the pre-call guard failed
  // to fire. Without a key, callForecastLLM's `if (!apiKey) continue` short-circuits
  // and llmCalls===0 would prove nothing — the vacuous-tripwire trap. Counting via
  // the transport override makes this assertion actually exercise the guard.
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter';

  // Shared 150s run budget already blown before this tail stage runs.
  __setForecastLlmRunDeadlineForTests(Date.now() - 1000);

  let llmCalls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => { llmCalls += 1; throw new Error('LLM must not be called when the run budget is exhausted'); },
  });
  // redis EXPIRE/SET preserve-refresh (redisCommand always hits real fetch) succeeds.
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(llmCalls, 0, 'the pre-call run-budget guard must skip before the LLM transport is invoked');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'ok', 'a budget starve must NOT flip seed-meta to error — age-based STALE_SEED escalates instead');
  assert.equal(meta.recordCount, 1, 'last-good record count is preserved (fetchedAt untouched)');
  assert.equal(meta.fetchedAt, 1783340000000, 'seed-meta.fetchedAt must not advance on a starve, else STALE_SEED never fires');
  assert.deepEqual(store['intelligence:market-implications:v1'].cards, LAST_GOOD, 'last-good cards preserved');
  assert.ok(
    !Object.keys(store).some((k) => k.startsWith('forecast:llm-market-implications:')),
    'no stage cache entry written on a budget-starved skip',
  );
});

test('run-budget starve restores stale OK meta when previous tick wrote SEED_ERROR', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  store['seed-meta:intelligence:market-implications'] = {
    fetchedAt: Date.now(),
    recordCount: 0,
    status: 'error',
    errorReason: 'llm_no_response',
  };

  __setForecastLlmRunDeadlineForTests(Date.now() - 1000);

  const redisCommands = [];
  global.fetch = async (_url, init = {}) => {
    redisCommands.push(JSON.parse(String(init.body || '[]')));
    return { ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' };
  };

  await buildAndSeedMarketImplications({});

  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'ok', 'a later budget starve must not preserve a prior producer-error meta');
  assert.equal(meta.recordCount, LAST_GOOD.length);
  assert.equal(meta.fetchedAt, Date.parse('2026-07-06T13:00:00.000Z'), 'restored meta keeps last-good age');
  assert.ok(
    redisCommands.some((command) => command[0] === 'EXPIRE' && command[1] === 'intelligence:market-implications:v1'),
    'canonical last-good payload TTL is still refreshed',
  );
  assert.ok(
    !redisCommands.some((command) => command[0] === 'EXPIRE' && command[1] === 'seed-meta:intelligence:market-implications'),
    'stale error meta must not be TTL-refreshed',
  );
});

test('a genuine provider failure (budget remaining) still writes a SEED_ERROR', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  // No run deadline set → budget is effectively unlimited, so a null result is a
  // real provider failure, not a starve.
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter';

  let providerCalls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => {
      providerCalls += 1;
      return { ok: false, status: 401, headers: { get: () => null }, text: async () => 'provider down' };
    },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(providerCalls, 1, 'the regression must exercise a real provider request');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'error', 'a real LLM failure with budget remaining must still surface SEED_ERROR');
});

test('a genuine provider failure that drains the run deadline still writes a SEED_ERROR', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter';
  // >= 30_000 so the pre-call guard admits the call; the mock then drains the
  // deadline mid-flight to prove a real failure is not reclassified as a starve.
  __setForecastLlmRunDeadlineForTests(Date.now() + 35_000);

  let providerCalls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => {
      providerCalls += 1;
      __setForecastLlmRunDeadlineForTests(Date.now() - 1);
      return { ok: false, status: 401, headers: { get: () => null }, text: async () => 'provider down' };
    },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(providerCalls, 1, 'provider failure path must run before the deadline is drained');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'error', 'provider failure must not be reclassified as budget starve just because the deadline is now exhausted');
});

test('pre-call guard skips in the 20-30s band — needs the full provider timeout, not just 20s (#1/#4)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  // Real provider config so a broken/too-low guard would actually invoke the transport.
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter';

  // 25s run budget: the OLD 20s threshold would (wrongly) admit this and then time
  // out CAPPED below the 25s provider timeout — indistinguishable from a hung
  // provider. The fix requires the full provider timeout + 5s stage guard (30s), so
  // a 25s budget must now SKIP cleanly instead of attempting an ambiguous call.
  __setForecastLlmRunDeadlineForTests(Date.now() + 25_000);

  let providerCalls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => { providerCalls += 1; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(providerCalls, 0, 'a call with < 30s run budget must be skipped, not attempted with a capped (ambiguous) timeout');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'ok', 'skipping in the 20-30s band preserves last-good, no SEED_ERROR');
  assert.equal(meta.fetchedAt, 1783340000000, 'fetchedAt untouched on a skip');
});

test('mid-call budget_exhausted result preserves last-good, no SEED_ERROR (#5 defensive branch)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);

  // Admit the call (>= 30s guard), then have callForecastLLM report a run-budget
  // exhaustion mid-flight. This drives the caller's mid-call preserve branch
  // (result.failureReason === BUDGET_EXHAUSTED) directly via the call-override seam
  // — the one branch no organic path reaches now that admitted calls get the full
  // provider timeout, but which is retained as defense-in-depth for env-overridden
  // provider chains.
  __setForecastLlmRunDeadlineForTests(Date.now() + 40_000);
  let overrideCalls = 0;
  __setForecastLlmCallOverrideForTests(() => {
    overrideCalls += 1;
    return { text: '', model: '', provider: '', failureReason: BUDGET_EXHAUSTED };
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(overrideCalls, 1, 'the guard must admit the call so the mid-call budget path is exercised');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'ok', 'a mid-call budget exhaustion is a starve — preserve last-good, no SEED_ERROR');
  assert.equal(meta.recordCount, 1, 'last-good record count preserved');
  assert.equal(meta.fetchedAt, 1783340000000, 'fetchedAt must not advance on a mid-call starve');
  assert.ok(
    !Object.keys(store).some((k) => k.startsWith('forecast:llm-market-implications:')),
    'no stage cache entry written on a mid-call starve',
  );
});

test('mid-call provider_failed result still writes a SEED_ERROR (#5 classification symmetry)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);

  __setForecastLlmRunDeadlineForTests(Date.now() + 40_000);
  __setForecastLlmCallOverrideForTests(() => ({ text: '', model: '', provider: '', failureReason: PROVIDER_FAILED }));
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'error', 'a genuine provider failure (even textless) must surface SEED_ERROR, not be preserved as a starve');
});
