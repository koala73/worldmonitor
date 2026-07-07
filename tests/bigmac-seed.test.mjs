import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchBigMacPrices, COUNTRIES } from '../scripts/seed-bigmac.mjs';

// Reproduces #4994: the 50-country EXA loop used to run STRICTLY SEQUENTIALLY
// under runSeed's 240s fetch-phase deadline, so it crashed (exit-75 "Deploy
// Crashed!" alert) the moment average EXA latency crept over 240/50 ≈ 4.8s.
// The fix runs the loop with bounded concurrency. These tests pin that in.

const PER_CALL_MS = 25;

// A fake EXA that sleeps PER_CALL_MS then returns a parseable price whose
// currency matches the queried country (query ends with the currency code).
function makeFakeExa({ failCurrencies = new Set() } = {}) {
  return async (query) => {
    await new Promise((r) => setTimeout(r, PER_CALL_MS));
    const ccy = query.trim().split(/\s+/).pop();
    if (failCurrencies.has(ccy)) throw new Error(`simulated EXA failure for ${ccy}`);
    return { results: [{ summary: `A Big Mac costs 5.00 ${ccy}`, url: 'https://test.example' }] };
  };
}

const fakeFx = async () => Object.fromEntries(COUNTRIES.map((c) => [c.currency, 1]));

describe('seed-bigmac fetchBigMacPrices', () => {
  it('runs the country loop concurrently — much faster than sequential (regression for #4994)', async () => {
    const searchExaFn = makeFakeExa();

    const seqStart = Date.now();
    await fetchBigMacPrices(null, { searchExaFn, getFxRatesFn: fakeFx, concurrency: 1 });
    const seqMs = Date.now() - seqStart;

    const conStart = Date.now();
    await fetchBigMacPrices(null, { searchExaFn, getFxRatesFn: fakeFx, concurrency: 6 });
    const conMs = Date.now() - conStart;

    // Concurrency 6 should be well under half the sequential wall-clock. (Ideal
    // ratio is ~1/6; assert < 1/3 for CI-scheduler headroom.) BEFORE the fix the
    // only path was `concurrency: 1` — this comparison would be ~1.0 and fail.
    assert.ok(
      conMs < seqMs / 3,
      `concurrent run (${conMs}ms) should be < 1/3 of sequential (${seqMs}ms)`,
    );
  });

  it('preserves country order and returns one row per country', async () => {
    const data = await fetchBigMacPrices(null, { searchExaFn: makeFakeExa(), getFxRatesFn: fakeFx, concurrency: 6 });
    assert.equal(data.countries.length, COUNTRIES.length);
    for (let i = 0; i < COUNTRIES.length; i += 1) {
      assert.equal(data.countries[i].code, COUNTRIES[i].code, `row ${i} must stay aligned with COUNTRIES order`);
    }
    // All fakes return a valid in-range price → every country available.
    assert.ok(data.countries.every((c) => c.available && c.usdPrice === 5), 'every country resolves a price');
  });

  it('a single failing country degrades to available:false, never crashing the run', async () => {
    const failCurrencies = new Set([COUNTRIES[3].currency]); // one country's EXA throws
    const data = await fetchBigMacPrices(null, { searchExaFn: makeFakeExa({ failCurrencies }), getFxRatesFn: fakeFx, concurrency: 6 });
    assert.equal(data.countries.length, COUNTRIES.length);
    const failed = data.countries.find((c) => c.currency === COUNTRIES[3].currency);
    assert.equal(failed.available, false, 'failed country is marked unavailable');
    assert.ok(data.countries.some((c) => c.available), 'other countries still resolve');
  });
});
