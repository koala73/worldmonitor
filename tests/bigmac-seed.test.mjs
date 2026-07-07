import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fetchBigMacPrices, declareRecords, COUNTRIES } from '../scripts/seed-bigmac.mjs';
import { allSettledWithConcurrency } from '../scripts/_seed-utils.mjs';

// The seeder logs one line per country (×50) plus per-failure warnings. Under the
// full `tsx --test --test-concurrency=16` suite that flood corrupts node:test's
// child-process message parser (FileTest.parseMessage crash) — especially the
// total-outage test, which emits 50 warns in one synchronous burst. Silence the
// seeder's chatter for the duration of this file; restore afterward.
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
before(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
after(() => { console.log = realLog; console.warn = realWarn; console.error = realError; });

// Reproduces #4994: the 50-country EXA loop used to run STRICTLY SEQUENTIALLY
// under runSeed's 240s fetch-phase deadline, so it crashed (exit-75 "Deploy
// Crashed!" alert) the moment average EXA latency crept over 240/50 ≈ 4.8s.
// The fix runs the loop with bounded concurrency. These tests pin that in.

// The production default (EXA_CONCURRENCY in scripts/seed-bigmac.mjs). Hard-coded
// on purpose: a regression that drops the default back toward sequential (→ 1)
// must fail this suite, and an intentional bump must consciously update it here.
const EXPECTED_DEFAULT_CONCURRENCY = 6;

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

// Same as makeFakeExa but records the peak number of simultaneously in-flight calls.
function makeTrackingExa() {
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (query) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, PER_CALL_MS));
      const ccy = query.trim().split(/\s+/).pop();
      return { results: [{ summary: `A Big Mac costs 5.00 ${ccy}`, url: 'https://test.example' }] };
    } finally {
      inFlight -= 1;
    }
  };
  return { fn, get maxInFlight() { return maxInFlight; } };
}

const fakeFx = async () => Object.fromEntries(COUNTRIES.map((c) => [c.currency, 1]));

describe('seed-bigmac fetchBigMacPrices', () => {
  it('caps in-flight EXA calls at the production default when NO override is passed (pins #4994 fix)', async () => {
    const exa = makeTrackingExa();
    // Deliberately omit `concurrency` so this exercises the real EXA_CONCURRENCY default.
    await fetchBigMacPrices(null, { searchExaFn: exa.fn, getFxRatesFn: fakeFx });
    assert.equal(
      exa.maxInFlight,
      EXPECTED_DEFAULT_CONCURRENCY,
      `default run should hold exactly ${EXPECTED_DEFAULT_CONCURRENCY} EXA calls in flight (got ${exa.maxInFlight}); a value of 1 means the loop regressed to sequential`,
    );
  });

  // NOTE: concurrency is proven by the deterministic max-in-flight test above, not
  // by a wall-clock ratio — timing assertions flake under `--test-concurrency=16`.

  it('preserves country order and returns one row per country', async () => {
    const data = await fetchBigMacPrices(null, { searchExaFn: makeFakeExa(), getFxRatesFn: fakeFx });
    assert.equal(data.countries.length, COUNTRIES.length);
    for (let i = 0; i < COUNTRIES.length; i += 1) {
      assert.equal(data.countries[i].code, COUNTRIES[i].code, `row ${i} must stay aligned with COUNTRIES order`);
    }
    // All fakes return a valid in-range price → every country available.
    assert.ok(data.countries.every((c) => c.available && c.usdPrice === 5), 'every country resolves a price');
  });

  it('a single failing country degrades to available:false, never crashing the run', async () => {
    const failCurrencies = new Set([COUNTRIES[3].currency]); // one country's EXA throws
    const data = await fetchBigMacPrices(null, { searchExaFn: makeFakeExa({ failCurrencies }), getFxRatesFn: fakeFx });
    assert.equal(data.countries.length, COUNTRIES.length);
    const failed = data.countries.find((c) => c.currency === COUNTRIES[3].currency);
    assert.equal(failed.available, false, 'failed country is marked unavailable');
    assert.ok(data.countries.some((c) => c.available), 'other countries still resolve');
  });

  it('total EXA outage → all rows unavailable, empty extremes, declareRecords 0 (no bogus publish)', async () => {
    const allFail = async () => { throw new Error('EXA down'); };
    const data = await fetchBigMacPrices(null, { searchExaFn: allFail, getFxRatesFn: fakeFx });
    // Row per country is still returned, but none is available.
    assert.equal(data.countries.length, COUNTRIES.length);
    assert.ok(data.countries.every((c) => c.available === false), 'no country resolves a price on total outage');
    assert.equal(data.cheapestCountry, '', 'no cheapest country when everything is unavailable');
    assert.equal(data.mostExpensiveCountry, '', 'no most-expensive country when everything is unavailable');
    // recordCount 0 is the contract that drives runSeed to retry / not publish a
    // zero-record snapshot (validateFn only checks countries.length > 0).
    assert.equal(declareRecords(data), 0, 'declareRecords must be 0 on a total outage');
  });
});

describe('allSettledWithConcurrency invalid concurrency', () => {
  for (const bad of [0, NaN, -3, undefined, 2.9]) {
    it(`processes every item and returns a dense result when concurrency is ${String(bad)}`, async () => {
      const items = [1, 2, 3, 4, 5];
      const seen = [];
      const results = await allSettledWithConcurrency(items, bad, async (x) => { seen.push(x); return x * 2; });
      assert.equal(results.length, items.length);
      assert.ok(results.every((r) => r && r.status === 'fulfilled'), 'no result slot left empty (no sparse array)');
      assert.deepEqual(results.map((r) => r.value), [2, 4, 6, 8, 10]);
      assert.equal(seen.length, items.length, 'mapper ran for every item');
    });
  }

  it('empty input returns an empty array regardless of concurrency', async () => {
    assert.deepEqual(await allSettledWithConcurrency([], 6, async (x) => x), []);
  });
});
