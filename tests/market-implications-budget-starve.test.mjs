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
} from '../scripts/seed-forecasts.mjs';

const ENV_KEYS = ['OPENROUTER_API_KEY', 'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  __setRedisStoreForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
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

// A fetch mock that treats any LLM-provider call as a test failure but lets the
// redis EXPIRE preserve-refresh (redisCommand always hits real fetch) succeed.
function budgetStarveFetch(onLlmCall) {
  return async (u) => {
    const s = String(u ?? '');
    if (/openrouter|groq|chat\/completions|\/api\//i.test(s) && !/upstash|redis/i.test(s)) {
      onLlmCall(s);
      throw new Error(`LLM must not be called when the run budget is exhausted: ${s}`);
    }
    return { ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' };
  };
}

test('run-budget starve preserves last-good and does NOT write a SEED_ERROR', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);

  // Shared 150s run budget already blown before this tail stage runs.
  __setForecastLlmRunDeadlineForTests(Date.now() - 1000);

  let llmCalls = 0;
  global.fetch = budgetStarveFetch(() => { llmCalls += 1; });

  await buildAndSeedMarketImplications({});

  assert.equal(llmCalls, 0, 'budget-starved tail stage must not call the LLM');
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
  __setForecastLlmRunDeadlineForTests(Date.now() + 25_000);

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
