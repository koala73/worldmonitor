// fetchCoinGeckoWithRetryBudget is the one CoinGecko 429 retry loop shared by
// the seeders that fall back to CoinPaprika (tests/seed-fetch-budget.test.mjs
// proves each seeder's fallback fits its bundle section). These tests pin the
// helper's own contract through its injected clock and sleep, with no real
// time: the budget is a ceiling on the whole phase including the request that
// would follow a sleep, the log line keeps its shape, and non-429 errors
// throw without retrying.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchCoinGeckoWithRetryBudget } from '../scripts/_seed-utils.mjs';

const URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd';
const LOG_LINE = /^ {2}CoinGecko 429 — waiting \d+s \(attempt \d+, \d+s of \d+s budget\)$/;

/**
 * Drive the helper against a fake clock: each fetch answers the next status in
 * `statuses` (repeating the last) after `responseMs`, and each sleep advances
 * the clock by the requested wait.
 */
function drive(t, { statuses, responseMs, requestTimeoutMs = 15_000, budgetMs = 45_000 }) {
  let clock = 0;
  let calls = 0;
  const sleeps = [];
  const warn = t.mock.method(console, 'warn', () => {});
  const result = fetchCoinGeckoWithRetryBudget(URL, {
    requestTimeoutMs,
    budgetMs,
    fetchFn: async () => {
      clock += responseMs;
      const status = statuses[Math.min(calls, statuses.length - 1)];
      calls += 1;
      return new Response(null, { status });
    },
    sleepFn: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  return {
    result,
    sleeps,
    calls: () => calls,
    clock: () => clock,
    warnLines: () => warn.mock.calls.map((call) => call.arguments[0]),
  };
}

describe('fetchCoinGeckoWithRetryBudget', () => {
  it('gives up before a sleep plus the next request timeout would carry the phase past budgetMs', async (t) => {
    // Every 429 lands at the request timeout, the slowest outcome the budget
    // must absorb: 15s, sleep 5s, 15s = 35s; a 10s sleep plus a 15s request
    // would reach 60s, so the second 429 ends the phase at 35s.
    const run = drive(t, { statuses: [429], responseMs: 15_000 });
    await assert.rejects(run.result, /CoinGecko rate limit exceeded after 2 attempt\(s\) in 35s \(45s retry budget\)/);
    assert.equal(run.calls(), 2);
    assert.deepEqual(run.sleeps, [5_000]);
    assert.ok(run.clock() <= 45_000, `phase ran ${run.clock()}ms, past the 45000ms budget`);
    assert.deepEqual(run.warnLines(), ['  CoinGecko 429 — waiting 5s (attempt 1, 15s of 45s budget)']);
  });

  it('fits more attempts when 429s answer quickly, still without crossing budgetMs', async (t) => {
    const run = drive(t, { statuses: [429], responseMs: 1_000 });
    await assert.rejects(run.result, /CoinGecko rate limit exceeded after 3 attempt\(s\) in 18s/);
    assert.deepEqual(run.sleeps, [5_000, 10_000]);
    assert.ok(run.clock() <= 45_000, `phase ran ${run.clock()}ms, past the 45000ms budget`);
    for (const line of run.warnLines()) assert.match(line, LOG_LINE);
  });

  it('returns the first OK response after a 429', async (t) => {
    const run = drive(t, { statuses: [429, 200], responseMs: 1_000 });
    const resp = await run.result;
    assert.equal(resp.status, 200);
    assert.equal(run.calls(), 2);
    assert.deepEqual(run.sleeps, [5_000]);
  });

  it('throws on a non-429 error status without sleeping or retrying', async (t) => {
    const run = drive(t, { statuses: [503], responseMs: 1_000 });
    await assert.rejects(run.result, /CoinGecko HTTP 503/);
    assert.equal(run.calls(), 1);
    assert.deepEqual(run.sleeps, []);
  });

  it('rejects a missing or non-positive budget instead of retrying forever', async () => {
    for (const options of [{ requestTimeoutMs: 15_000 }, { requestTimeoutMs: 15_000, budgetMs: 0 }, { budgetMs: 45_000 }]) {
      await assert.rejects(
        fetchCoinGeckoWithRetryBudget(URL, { ...options, fetchFn: async () => new Response(null, { status: 429 }) }),
        TypeError,
      );
    }
  });
});
