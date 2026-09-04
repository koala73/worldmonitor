import assert from 'node:assert/strict';
import test from 'node:test';

import { finiteObservation, parseYahooChart } from '../scripts/_seed-utils.mjs';
import { computeCpiYoy, latestUnemployment, parseVectorSeries } from '../scripts/lib/statcan-wds.mjs';

// Every one of these is Number()-coercible to 0, which is a publishable reading.
const MISSING = [null, undefined, '', '   ', false, true, [], [12], {}, NaN, Infinity, -Infinity];

function vectorDoc(values) {
  return [{
    status: 'SUCCESS',
    object: {
      vectorId: 123,
      productId: 456,
      vectorDataPoint: values.map((value, i) => ({ refPer: `2026-0${i + 1}-01`, value })),
    },
  }];
}

function chart(meta, close = []) {
  return { chart: { result: [{ meta, indicators: { quote: [{ close }] } }] } };
}

test('a missing observation is not the number zero', () => {
  for (const value of MISSING) assert.equal(finiteObservation(value), null, `accepted ${String(value)}`);
});

test('a measured zero and quoted numeric values survive', () => {
  assert.equal(finiteObservation(0), 0);
  assert.equal(finiteObservation('0'), 0);
  assert.equal(finiteObservation(' 6.5 '), 6.5);
  assert.equal(finiteObservation(-2), -2);
});

test('a suppressed StatCan observation is omitted, not published as zero', () => {
  for (const value of MISSING) {
    assert.deepEqual(parseVectorSeries(vectorDoc([value]), 123).points, [],
      `published a point for ${String(value)}`);
  }
});

test('a suppressed latest month cannot overwrite the unemployment rate with zero', () => {
  const series = parseVectorSeries(vectorDoc([6.5, null]), 123);
  const latest = latestUnemployment(series.points);
  assert.equal(latest.unemploymentPct, 6.5);
  assert.equal(latest.refPer, '2026-01-01');
});

test('a genuine StatCan zero is still a measurement', () => {
  assert.deepEqual(
    parseVectorSeries(vectorDoc([0, '0', ' 6.5 ', -2]), 123).points.map(p => p.value),
    [0, 0, 6.5, -2],
  );
});

test('a suppressed month does not fabricate a CPI year-over-year move', () => {
  const withHole = parseVectorSeries(vectorDoc([160, null]), 123);
  assert.deepEqual(withHole.points.map(p => p.value), [160]);
  assert.equal(computeCpiYoy(withHole.points), null);
});

test('a quote with no price is dropped rather than published priceless', () => {
  for (const price of MISSING) {
    assert.equal(parseYahooChart(chart({ regularMarketPrice: price }), 'TEST'), null,
      `published a quote for price ${String(price)}`);
  }
});

test('NaN closes leave a shorter sparkline, not holes', () => {
  const result = parseYahooChart(
    chart({ regularMarketPrice: 100, previousClose: 100 }, [90, null, NaN, Infinity, '95', false, 0, -2]),
    'TEST',
  );
  assert.deepEqual(result.sparkline, [90, 95, 0, -2]);
  assert.ok(result.sparkline.every(Number.isFinite));
});

test('an unusable previous close falls through to the next candidate', () => {
  for (const previous of [null, NaN, Infinity, 'bad', 0, false]) {
    const result = parseYahooChart(
      chart({ regularMarketPrice: 110, chartPreviousClose: previous, previousClose: 100 }), 'TEST');
    assert.equal(result.change, 10);
  }
});

test('with no usable previous close the change is zero, not infinite', () => {
  const result = parseYahooChart(
    chart({ regularMarketPrice: 100, chartPreviousClose: 0, previousClose: null }), 'TEST');
  assert.equal(result.change, 0);
  assert.equal(result.price, 100);
});

test('genuine zero and negative prices remain publishable', () => {
  assert.equal(parseYahooChart(chart({ regularMarketPrice: 0, previousClose: 100 }), 'TEST').change, -100);
  assert.equal(parseYahooChart(chart({ regularMarketPrice: -10, previousClose: 100 }), 'TEST').price, -10);
});
