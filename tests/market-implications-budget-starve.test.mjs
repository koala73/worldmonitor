// market_implications budget-starve handling (#4978).
//
// market_implications is the LAST forecast LLM stage (afterPublish) and shares
// the single 200s run budget with every upstream stage. When upstream stages
// are slow (e.g. repeated LLM provider stalls, #4944) they drain that budget
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

const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'GROQ_API_KEY',
  'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER', 'FORECAST_LLM_PROVIDER_ORDER',
];
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

  // Shared 200s run budget already blown before this tail stage runs.
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
  // 40s: the resolved chain here is openrouter-only (pinned below), so the
  // reservation is just 15s + 5s guard = 20s — a 40s budget admits it (the static
  // all-provider 40s reservation would also admit, but the test still proves the
  // resolved provider chain drives admission). The mock then drains
  // the deadline mid-flight to prove a real failure is not reclassified as a starve.
  // 50s > the openrouter-only reservation (40s Flash + 5s guard = 45s), so the call
  // is ADMITTED. (Was 40s against a 15s-Flash chain; the Flash completion deadline is
  // now 40s — see _llm-model-timeouts.)
  __setForecastLlmRunDeadlineForTests(Date.now() + 50_000);

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

test('pre-call guard skips when the run budget cannot cover the full provider chain (#1/#4)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  // Default chain, both providers runnable → reservation is openrouter 15s + groq
  // 20s + 5s guard = 40s. Real keys so a broken/too-low guard would actually invoke
  // the transport rather than short-circuit on a missing key.
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.GROQ_API_KEY = 'test-key';
  delete process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER;
  delete process.env.FORECAST_LLM_PROVIDER_ORDER;

  // 25s run budget: below the 40s two-provider reservation, so it must SKIP
  // cleanly and preserve last-good instead of attempting an ambiguous, doomed call.
  __setForecastLlmRunDeadlineForTests(Date.now() + 25_000);

  let providerCalls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => { providerCalls += 1; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(providerCalls, 0, 'a call below the full-chain reservation must be skipped, not attempted with a capped (ambiguous) timeout');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'ok', 'skipping below the full-chain reservation preserves last-good, no SEED_ERROR');
  assert.equal(meta.fetchedAt, 1783340000000, 'fetchedAt untouched on a skip');
});

test('mid-call budget_exhausted result preserves last-good, no SEED_ERROR (#5 defensive branch)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);

  // Admit the call (>= the 40s full-chain reservation), then have callForecastLLM
  // report a run-budget exhaustion mid-flight. This drives the caller's mid-call
  // preserve branch (result.failureReason === BUDGET_EXHAUSTED) directly via the
  // call-override seam — retained as defense-in-depth for env-overridden provider
  // chains and mid-flight deadline drains.
  __setForecastLlmRunDeadlineForTests(Date.now() + 60_000);
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

  __setForecastLlmRunDeadlineForTests(Date.now() + 60_000);
  __setForecastLlmCallOverrideForTests(() => ({ text: '', model: '', provider: '', failureReason: PROVIDER_FAILED }));
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'error', 'a genuine provider failure (even textless) must surface SEED_ERROR, not be preserved as a starve');
});

test('a budget covering only the primary — not the fallback — skips instead of stranding groq → no SEED_ERROR (#4978 follow-up)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.GROQ_API_KEY = 'test-key';
  // The 2-provider chain is no longer the market_implications DEFAULT (it is now
  // openrouter-only — groq's free tier 429s for most of the day). Pin it explicitly:
  // the stranded-fallback logic still exists and must stay correct for any deployment
  // that configures a fallback. Without this the test would skip for the WRONG reason
  // and silently stop covering #4978.
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter,groq';
  delete process.env.FORECAST_LLM_PROVIDER_ORDER;

  // 30s budget: enough for the primary openrouter attempt (15s) + guard, but NOT
  // the full openrouter→groq chain (40s). The reported bug class is unchanged:
  // admitting only the primary can strand Groq ("groq llm budget exhausted")
  // after a timeout and misreport a recoverable timeout as SEED_ERROR. The full-
  // chain reservation makes this SKIP and preserve last-good (green) instead.
  // 50s covers the primary (40s Flash + 5s guard = 45s) but NOT the full
  // openrouter→groq chain (40 + 20 + 5 = 65s) => must SKIP rather than strand groq.
  __setForecastLlmRunDeadlineForTests(Date.now() + 50_000);

  let providerCalls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => { providerCalls += 1; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(providerCalls, 0, 'a call that cannot finish the openrouter→groq chain must skip before stranding the fallback');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'ok', 'a stranded-fallback budget must preserve last-good, not write SEED_ERROR (the health WARNING this fixes)');
  assert.equal(meta.fetchedAt, 1783340000000, 'fetchedAt untouched — STALE_SEED still escalates if the starve persists past 2h');
});

test('an admitted primary timeout falls through to the fallback in ONE attempt each — not stranded by retries (#5003 review, finding 1)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.GROQ_API_KEY = 'test-key';
  // Pin the 2-provider chain explicitly: it is no longer the market_implications
  // default, but the one-attempt-per-provider machinery must stay correct for any
  // deployment that configures a fallback. Deleting the env here would leave an
  // openrouter-only chain and the test could never reach groq — it would assert
  // nothing about the #5003 regression.
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter,groq';
  delete process.env.FORECAST_LLM_PROVIDER_ORDER;

  // 70s admits the full two-provider chain (40s Flash + 20s groq + 5s guard = 65s).
  // Every attempt times out. PRE-FIX, openrouter's 3 retries (4 attempts) drained the
  // run budget and groq was NEVER reached — a recoverable timeout became a SEED_ERROR
  // without trying the fallback. With maxRetries:0 each provider gets exactly ONE
  // attempt, so groq IS reached.
  __setForecastLlmRunDeadlineForTests(Date.now() + 70_000);

  const calls = { openrouter: 0, groq: 0 };
  __setForecastLlmTransportForTests({
    fetch: async (u) => {
      const url = String(u);
      if (url.includes('openrouter')) calls.openrouter += 1;
      else if (url.includes('groq')) calls.groq += 1;
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(calls.openrouter, 1, 'primary must be tried exactly ONCE (maxRetries:0) — no 4-attempt retry storm that burns the fallback budget');
  assert.equal(calls.groq, 1, 'the fallback MUST be reached (it was stranded pre-fix)');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.equal(meta.status, 'error', 'both providers genuinely failed → SEED_ERROR is correct (the fallback ran, it just also failed)');
});

test('a single-provider override reserves only that provider — admitted where the 2-provider chain would skip (#5003 review, finding 2)', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.GROQ_API_KEY = 'test-key';
  // Pin to openrouter only → resolved chain reserves just 40s Flash + 5s guard = 45s.
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter';

  // 50s: below the 2-provider 65s reservation (would skip) but above the pinned
  // single-provider 45s reservation — so this MUST be admitted, not skipped.
  __setForecastLlmRunDeadlineForTests(Date.now() + 50_000);

  let providerCalls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => { providerCalls += 1; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(providerCalls, 1, 'a pinned single-provider chain needs only 45s, so a 50s budget must ADMIT it (and try it once)');
});
