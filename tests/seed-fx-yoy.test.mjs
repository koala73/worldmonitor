import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeYoy } from '../scripts/seed-fx-yoy.mjs';

// Build a synthetic monthly series with sequential timestamps. The bar values
// represent the USD price of 1 unit of the foreign currency (e.g. ARSUSD=X)
// — so a price drop = currency depreciation against USD.
function makeSeries(closes) {
  const month = 30 * 86400 * 1000;
  return closes.map((close, i) => ({ t: 1700000000_000 + i * month, close }));
}

describe('computeYoy — peak-to-trough drawdown', () => {
  it('finds the worst drawdown even when the currency later recovers to a new high', () => {
    // PR #3071 review regression case: a naive "global max → min after"
    // implementation would pick the later peak of 11 and report only 11→10
    // = -9.1%, missing the real 10→6 = -40% crash earlier in the series.
    const series = makeSeries([5, 10, 7, 9, 6, 11, 10]);
    const r = computeYoy(series);
    assert.equal(r.drawdown24m, -40, 'true worst drawdown is 10→6');
    assert.equal(r.peakRate, 10);
    assert.equal(r.troughRate, 6);
  });

  it('handles the trivial case where the peak is the first bar (no recovery)', () => {
    // NGN-style: currency at multi-year high at start, depreciates monotonically.
    const series = makeSeries([10, 9, 8, 7, 6, 7, 8, 7]);
    const r = computeYoy(series);
    assert.equal(r.drawdown24m, -40);
    assert.equal(r.peakRate, 10);
    assert.equal(r.troughRate, 6);
  });

  it('returns 0 drawdown for a series that only appreciates', () => {
    const series = makeSeries([5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18]);
    const r = computeYoy(series);
    assert.equal(r.drawdown24m, 0);
  });

  it('records the right peak/trough dates for a multi-trough series', () => {
    // Earlier trough (8→4 = -50%) is worse than later one (8→6 = -25%).
    const series = makeSeries([8, 4, 7, 8, 6, 8]);
    const r = computeYoy(series);
    assert.equal(r.drawdown24m, -50);
    assert.equal(r.peakRate, 8);
    assert.equal(r.troughRate, 4);
  });

  it('computes yoyChange from the bar 12 months before the latest', () => {
    // 25 monthly bars: yoyChange should compare bar[24] to bar[12].
    // Use closes that distinguish from drawdown so we don't conflate.
    const closes = Array.from({ length: 25 }, (_, i) => 100 - i * 2); // monotonic decline
    const series = makeSeries(closes);
    const r = computeYoy(series);
    // Latest = 100 - 24*2 = 52, yearAgo = 100 - 12*2 = 76
    // yoyChange = (52 - 76) / 76 * 100 = -31.578...
    assert.equal(r.yoyChange, -31.6);
  });
});
