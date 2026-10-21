// Sparkline float64 precision (#5300).
//
// Yahoo returns closes as float32 widened to float64, so JSON.stringify emits the conversion
// noise verbatim — `17.209999084472656`, 18 characters to express 17.21. Measured against
// production on 2026-07-14, that noise is ~half of every quote payload we seed, and those
// payloads live in the bootstrap FAST tier, which takes ~5x more CDN origin misses than the
// slow tier:
//
//   market:commodities-bootstrap:v1  241,869 B  — 12,238 noisy floats, 53% of the key
//   market:stocks-bootstrap:v1       187,834 B  —  7,858 noisy floats, 42% of the key
//   market:gulf-quotes:v1             57,289 B  —  2,783 noisy floats, 51% of the key
//
// The load-bearing claim is that dropping this precision is INVISIBLE. These tests prove it
// against the real renderer — not a reimplementation of it — by comparing the SVG that ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYahooChart, roundSparkline, SPARKLINE_SIGNIFICANT_DIGITS } from '../scripts/_seed-utils.mjs';
import { miniSparkline, sparkline } from '../src/utils/sparkline.ts';

/** Real float64 noise, copied verbatim from market:commodities-bootstrap:v1. */
const NOISY = [
  17.209999084472656, 17.219999313354492, 17.239999771118164,
  17.190000534057617, 17.170000076293945, 17.25, 16.829999923706055,
];
/** Real FX values — the reason this rounds by SIGNIFICANT DIGITS, not decimal places. */
const NOISY_FX = [0.6917064189910889, 0.6921235918998718, 0.6908955574035645];

test('strips float64 conversion noise', () => {
  assert.deepEqual(roundSparkline(NOISY), [17.21, 17.22, 17.24, 17.19, 17.17, 17.25, 16.83]);

  const before = JSON.stringify(NOISY).length;
  const after = JSON.stringify(roundSparkline(NOISY)).length;
  assert.ok(after < before / 2, `expected >50% shrink, got ${before} -> ${after} bytes`);
});

test('an FX rate keeps its precision — this is why it is significant digits, not decimals', () => {
  // A fixed 2dp round would flatten AUDUSD=X to 0.69 and destroy the chart. Significant
  // digits keep the same number of MEANINGFUL digits at any magnitude, so a sub-1.0 FX rate
  // survives exactly as well as a five-figure index level.
  assert.deepEqual(roundSparkline(NOISY_FX), [0.6917064, 0.6921236, 0.6908956]);
  for (const v of roundSparkline(NOISY_FX)) assert.ok(v > 0.6 && v < 0.7);
});

test('the rendered SVG is byte-identical for real market series', () => {
  // The real renderer, not a copy of its maths — this is the string that ships to the DOM.
  for (const series of [NOISY, NOISY_FX]) {
    const rounded = roundSparkline(series);
    assert.equal(miniSparkline(rounded, 1, 60, 18), miniSparkline(series, 1, 60, 18));
    assert.equal(miniSparkline(rounded, -1, 50, 16), miniSparkline(series, -1, 50, 16));
    assert.equal(sparkline(rounded, '#fff', 120, 28), sparkline(series, '#fff', 120, 28));
  }
});

// Byte-identical SVG is NOT guaranteed for every possible series, and claiming it would be
// an overclaim. miniSparkline emits coordinates via toFixed(1), so its own output is only
// precise to 0.1px; a rounded value sitting near a 0.05px boundary can tip the last digit to
// the adjacent step. The real, defensible invariant is that no point can EVER move by more
// than that one quantum — the smallest difference the renderer is able to express at all.
const COORD_QUANTUM_PX = 0.1;

test('no point ever moves more than one coordinate quantum, even on the worst series', () => {
  // 856 points, jagged: the real length of USDTRY=X, the worst case in production.
  const series = Array.from({ length: 856 }, (_, i) => {
    const v = 42.5 + Math.sin(i / 7) * 0.4 + (i % 13) * 0.011;
    return Number(new Float32Array([v])[0]); // reproduce the float32 -> float64 widening
  });
  const rounded = roundSparkline(series);

  const ys = (svg) => svg.match(/points="([^"]+)"/)[1].split(' ').map((p) => Number(p.split(',')[1]));
  const a = ys(miniSparkline(series, 1, 60, 18));
  const b = ys(miniSparkline(rounded, 1, 60, 18));

  assert.equal(a.length, b.length, 'point count must not change — precision only, never resampling');
  const worst = Math.max(...a.map((y, i) => Math.abs(y - b[i])));
  assert.ok(
    worst <= COORD_QUANTUM_PX + 1e-9,
    `worst vertical shift ${worst.toFixed(3)}px exceeds the renderer's own 0.1px coordinate quantum`,
  );
});

test('4 significant digits WOULD be visible — the guard rail on lowering this', () => {
  // Measured at 1.90px on real commodities data. Pins why the constant is not "tuned down"
  // later for a few more bytes.
  const series = Array.from({ length: 200 }, (_, i) => 42.5 + Math.sin(i / 7) * 0.4);
  const ys = (svg) => svg.match(/points="([^"]+)"/)[1].split(' ').map((p) => Number(p.split(',')[1]));
  const a = ys(miniSparkline(series, 1, 60, 18));
  const coarse = ys(miniSparkline(roundSparkline(series, 4), 1, 60, 18));

  const worst = Math.max(...a.map((y, i) => Math.abs(y - coarse[i])));
  assert.ok(worst > COORD_QUANTUM_PX, `4 digits must be demonstrably worse; got ${worst.toFixed(2)}px`);
});

// Downsampling was the obvious idea and it is WRONG. miniSparkline autoscales each series to
// its own min/max, so dropping any extreme rescales the entire curve. Measured on the 64 live
// series: 96-point resampling moved the median series 3-4px on an 18px chart and cost
// USDTRY=X 40% of its vertical range. This pins the reason so nobody "optimises" it later.
test('dropping the extremes visibly rescales the chart — why we do NOT downsample', () => {
  const series = [10, 10.1, 10.2, 99, 10.3, 10.15, 10.05, 10.2];
  const withoutPeak = series.filter((v) => v !== 99);

  const y = (svg) => svg.match(/points="([^"]+)"/)[1].split(' ').map((p) => Number(p.split(',')[1]));
  const shift = Math.abs(Math.min(...y(miniSparkline(series, 1, 60, 18))) - Math.min(...y(miniSparkline(withoutPeak, 1, 60, 18))));

  assert.ok(shift === 0, 'the min y-coordinate pins to the top either way...');
  // ...but the SHAPE below it changes completely, because the range collapsed.
  assert.notEqual(miniSparkline(withoutPeak, 1, 60, 18), miniSparkline(series.slice(0, 8), 1, 60, 18));
});

test('parseYahooChart rounds what it publishes', () => {
  // The integration point: the real function both hot seeders call.
  const parsed = parseYahooChart({
    chart: { result: [{
      meta: { regularMarketPrice: 16.83, chartPreviousClose: 17.17 },
      indicators: { quote: [{ close: [...NOISY, null, 17.3] }] },
    }] },
  }, '^VIX');

  assert.deepEqual(parsed.sparkline, [17.21, 17.22, 17.24, 17.19, 17.17, 17.25, 16.83, 17.3]);
  assert.ok(!JSON.stringify(parsed).includes('17.209999084472656'), 'noise must not reach Redis');
  assert.equal(parsed.price, 16.83, 'price is untouched — only the sparkline is rounded');
});

test('malformed upstream data degrades exactly as before', () => {
  assert.deepEqual(roundSparkline([]), []);
  for (const bad of [null, undefined, 'nope', 42, { a: 1 }]) {
    assert.equal(roundSparkline(bad), bad, 'non-arrays pass through untouched');
  }
  // Non-finite entries must survive rather than become null/0 and dent the curve.
  assert.deepEqual(roundSparkline([0, NaN, Infinity, -0]), [0, NaN, Infinity, -0]);
  assert.equal(SPARKLINE_SIGNIFICANT_DIGITS, 7);
});
