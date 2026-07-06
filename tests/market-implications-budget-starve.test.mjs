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
  __setForecastLlmRunDeadlineForTests,
} from '../scripts/seed-forecasts.mjs';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  __setRedisStoreForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
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

test('a genuine provider failure (budget remaining) still writes a SEED_ERROR', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  // No run deadline set → budget is effectively unlimited, so a null result is a
  // real provider failure, not a starve.
  global.fetch = async () => { throw new Error('provider down'); };

  await buildAndSeedMarketImplications({});

  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'error', 'a real LLM failure with budget remaining must still surface SEED_ERROR');
});
