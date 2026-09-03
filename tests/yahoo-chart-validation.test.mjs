import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYahooChart } from '../scripts/_seed-utils.mjs';

function chart(meta, close = []) {
  return { chart: { result: [{ meta, indicators: { quote: [{ close }] } }] } };
}

test('rejects missing and nonnumeric market prices', () => {
  for (const price of [undefined, null, NaN, Infinity, -Infinity, '100', false]) {
    assert.equal(parseYahooChart(chart({ regularMarketPrice: price }), 'TEST'), null);
  }
});

test('keeps only finite numeric observations in the sparkline', () => {
  const result = parseYahooChart(chart({ regularMarketPrice: 100 },
    [90, null, NaN, Infinity, '95', false, 0, -2, 100]), 'TEST');
  assert.deepEqual(result.sparkline, [90, 0, -2, 100]);
});

test('falls back to a valid previous close when chartPreviousClose is unusable', () => {
  for (const previous of [null, NaN, Infinity, 'bad', 0]) {
    const result = parseYahooChart(chart({ regularMarketPrice: 110,
      chartPreviousClose: previous, previousClose: 100 }), 'TEST');
    assert.equal(result.change, 10);
  }
});

test('uses the current price when neither previous close is usable', () => {
  const result = parseYahooChart(chart({ regularMarketPrice: 100,
    chartPreviousClose: Infinity, previousClose: 'bad' }), 'TEST');
  assert.equal(result.change, 0);
});

test('preserves legitimate zero and negative market prices', () => {
  assert.equal(parseYahooChart(chart({ regularMarketPrice: 0, previousClose: 100 }), 'TEST').change, -100);
  assert.equal(parseYahooChart(chart({ regularMarketPrice: -10, previousClose: 100 }), 'TEST').price, -10);
});
