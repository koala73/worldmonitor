import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cronbachAlpha,
  detectChangepoints,
  detectTrend,
  exponentialSmoothing,
  minMaxNormalize,
  nrcForecast,
} from '../server/_shared/resilience-stats';

test('cronbachAlpha returns the expected coefficient for a known matrix', () => {
  const alpha = cronbachAlpha([
    [1, 2, 3],
    [2, 3, 4],
    [3, 4, 5],
    [4, 5, 6],
  ]);

  assert.ok(alpha > 0.99 && alpha <= 1, `expected alpha near 1, got ${alpha}`);
});

test('cronbachAlpha returns 0 for a single-row matrix', () => {
  assert.equal(cronbachAlpha([[1, 2, 3]]), 0);
});

test('cronbachAlpha returns 0 when all rows are identical', () => {
  assert.equal(cronbachAlpha([
    [5, 5, 5],
    [5, 5, 5],
    [5, 5, 5],
  ]), 0);
});

test('detectTrend identifies rising, falling, and flat series', () => {
  assert.equal(detectTrend([10, 20, 30, 40, 50]), 'rising');
  assert.equal(detectTrend([50, 40, 30, 20, 10]), 'falling');
  assert.equal(detectTrend([20, 20.02, 19.98, 20.01, 19.99]), 'stable');
});

test('detectTrend treats fewer than 3 values as stable', () => {
  assert.equal(detectTrend([]), 'stable');
  assert.equal(detectTrend([10]), 'stable');
  assert.equal(detectTrend([10, 15]), 'stable');
});

test('detectChangepoints finds a structural break in a bimodal series', () => {
  const changepoints = detectChangepoints([10, 11, 9, 10, 10, 50, 52, 48, 51, 49]);
  assert.ok(changepoints.some((index) => index >= 5), `expected changepoint at the break, got ${changepoints}`);
});

test('detectChangepoints returns [] for constant and short series', () => {
  assert.deepEqual(detectChangepoints([5, 5, 5, 5, 5, 5]), []);
  assert.deepEqual(detectChangepoints([1, 2, 3, 4, 5]), []);
});

test('minMaxNormalize handles empty input, identical values, and negatives', () => {
  assert.deepEqual(minMaxNormalize([]), []);
  assert.deepEqual(minMaxNormalize([7, 7, 7]), [0.5, 0.5, 0.5]);
  assert.deepEqual(minMaxNormalize([-10, 0, 10]), [0, 0.5, 1]);
});

test('exponentialSmoothing smooths a noisy series without changing length', () => {
  const result = exponentialSmoothing([10, 20, 15, 25], 0.5);
  assert.equal(result.length, 4);
  assert.deepEqual(result.map((value) => Number(value.toFixed(2))), [10, 15, 15, 20]);
});

test('nrcForecast returns the requested horizon with bounded confidence intervals', () => {
  const forecast = nrcForecast([45, 48, 50, 53, 57, 60], 7, 0.4);

  assert.equal(forecast.values.length, 7);
  assert.equal(forecast.confidenceIntervals.length, 7);
  for (const value of forecast.values) {
    assert.ok(value >= 0 && value <= 100, `forecast value out of bounds: ${value}`);
  }
  for (const interval of forecast.confidenceIntervals) {
    assert.ok(interval.lower <= interval.upper, `invalid interval: ${JSON.stringify(interval)}`);
    assert.ok(interval.lower >= 0 && interval.upper <= 100, `interval out of bounds: ${JSON.stringify(interval)}`);
    assert.equal(interval.level, 95);
  }
  assert.equal(Number((forecast.probabilityUp + forecast.probabilityDown).toFixed(2)), 1);
});

test('nrcForecast falls back to a flat 50/50 outlook for short history', () => {
  const forecast = nrcForecast([88], 3);

  assert.deepEqual(forecast.values, [88, 88, 88]);
  assert.deepEqual(forecast.confidenceIntervals, [
    { lower: 79.2, upper: 96.8, level: 95 },
    { lower: 79.2, upper: 96.8, level: 95 },
    { lower: 79.2, upper: 96.8, level: 95 },
  ]);
  assert.equal(forecast.probabilityUp, 0.5);
  assert.equal(forecast.probabilityDown, 0.5);
});
