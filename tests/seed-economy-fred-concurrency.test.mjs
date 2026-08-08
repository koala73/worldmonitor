import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fetchFredSeries, FRED_SERIES, FRED_CONCURRENCY } from '../scripts/seed-economy.mjs';

// Reproduces #5037: fetchFredSeries used to loop FRED_SERIES STRICTLY SEQUENTIALLY under
// runSeed's 240s fetch-phase deadline. fredFetchJson worst case ≈ 3×20s proxy attempts + 20s
// direct ≈ 82s/series, so with the proxy down 24 series × 82s ≫ 240s → the seed exited 75 and
// fired a recurring "Deploy Crashed!" alert ~daily. The fix runs the loop with bounded
// concurrency (allSettledWithConcurrency, FRED_CONCURRENCY). These tests pin that in.

// The seeder logs one line per series (×24) plus per-failure warnings; silence for the file
// (matches the bigmac suite — a synchronous warn burst can corrupt node:test's IPC parser).
const realLog = console.log;
const realWarn = console.warn;
before(() => { console.log = () => {}; console.warn = () => {}; });
after(() => { console.log = realLog; console.warn = realWarn; });

// The production default (FRED_CONCURRENCY in scripts/seed-economy.mjs). Hard-coded on purpose:
// a regression that drops the default back toward sequential (→ 1) must fail this suite, and an
// intentional bump must consciously update it here.
const EXPECTED_DEFAULT_CONCURRENCY = 12;

const PER_CALL_MS = 15;

// fetchFredSeries fetches observations + metadata per series in parallel, so a series that is
// "in flight" holds 2 fredFetchFn calls at once → peak in-flight = 2 × (series in flight).
function seriesIdFromUrl(url) {
  return new URL(url).searchParams.get('series_id');
}
function isObservations(url) {
  return url.includes('/series/observations');
}

// A fake fredFetchJson: sleeps PER_CALL_MS then returns the right shape for the URL kind.
function makeFakeFred({ failSeries = new Set() } = {}) {
  return async (url) => {
    await new Promise((r) => setTimeout(r, PER_CALL_MS));
    const seriesId = seriesIdFromUrl(url);
    if (isObservations(url)) {
      if (failSeries.has(seriesId)) throw new Error(`simulated FRED failure for ${seriesId}`);
      return { observations: [{ date: '2026-07-01', value: '1.23' }, { date: '2026-07-08', value: '4.56' }] };
    }
    return { seriess: [{ title: `${seriesId} title`, units: 'Percent', frequency: 'Daily' }] };
  };
}

// Same as makeFakeFred but records the peak number of simultaneously in-flight calls.
function makeTrackingFred() {
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, PER_CALL_MS));
      const seriesId = seriesIdFromUrl(url);
      return isObservations(url)
        ? { observations: [{ date: '2026-07-08', value: '4.56' }] }
        : { seriess: [{ title: `${seriesId} title`, units: 'Percent', frequency: 'Daily' }] };
    } finally {
      inFlight -= 1;
    }
  };
  return { fn, get maxInFlight() { return maxInFlight; } };
}

describe('seed-economy fetchFredSeries — bounded concurrency (#5037)', () => {
  before(() => { process.env.FRED_API_KEY = 'test-key'; });

  it('caps in-flight FRED calls at the production default when NO override is passed (pins #5037 fix)', async () => {
    const tracker = makeTrackingFred();
    await fetchFredSeries({ fredFetchFn: tracker.fn });
    // 24 series at concurrency 12 = 2 full waves; each in-flight series holds obs+meta → 12×2.
    assert.equal(
      tracker.maxInFlight,
      EXPECTED_DEFAULT_CONCURRENCY * 2,
      `default run should hold ${EXPECTED_DEFAULT_CONCURRENCY} series (×2 obs+meta = ${EXPECTED_DEFAULT_CONCURRENCY * 2}) in flight (got ${tracker.maxInFlight}); a value of 2 means the loop regressed to SEQUENTIAL and will breach the 240s deadline`,
    );
    assert.equal(FRED_CONCURRENCY, EXPECTED_DEFAULT_CONCURRENCY, 'FRED_CONCURRENCY default changed — update EXPECTED_DEFAULT_CONCURRENCY');
  });

  it('concurrency: 1 collapses to the SEQUENTIAL shape (peak = 2, obs+meta of one series) — documents the bug', async () => {
    const tracker = makeTrackingFred();
    await fetchFredSeries({ fredFetchFn: tracker.fn, concurrency: 1 });
    assert.equal(tracker.maxInFlight, 2, `sequential run should peak at 2 in-flight (got ${tracker.maxInFlight})`);
  });

  it('fetches every series when all calls succeed', async () => {
    const results = await fetchFredSeries({ fredFetchFn: makeFakeFred() });
    assert.equal(Object.keys(results).length, FRED_SERIES.length);
    for (const id of FRED_SERIES) {
      assert.ok(results[id], `missing series ${id}`);
      assert.equal(results[id].seriesId, id);
      assert.ok(results[id].observations.length > 0, `no observations for ${id}`);
    }
  });

  it('isolates per-series failures — a few flaky series do NOT sink the rest', async () => {
    const failSeries = new Set([FRED_SERIES[0], FRED_SERIES[5], FRED_SERIES[23]]);
    const results = await fetchFredSeries({ fredFetchFn: makeFakeFred({ failSeries }) });
    assert.equal(Object.keys(results).length, FRED_SERIES.length - failSeries.size);
    for (const id of failSeries) assert.equal(results[id], undefined, `failed series ${id} should be absent`);
    for (const id of FRED_SERIES) if (!failSeries.has(id)) assert.ok(results[id], `healthy series ${id} should be present`);
  });

  it('returns an empty object (does not throw) when every series fails', async () => {
    const results = await fetchFredSeries({ fredFetchFn: makeFakeFred({ failSeries: new Set(FRED_SERIES) }) });
    assert.deepEqual(results, {});
  });
});
