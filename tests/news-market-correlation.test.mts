import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeNewsMarketCorrelation,
  isMarketCorrelationPayload,
  type TimeSeriesPoint,
} from '../src/services/news-market-correlation.ts';

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.parse('2026-08-01T00:00:00.000Z');

function point(hour: number, value: number): TimeSeriesPoint {
  return { timestamp: new Date(START_MS + hour * HOUR_MS).toISOString(), value };
}

function pricesFromReturns(returns: number[]): TimeSeriesPoint[] {
  const points = [point(0, 100)];
  let price = 100;
  for (let i = 0; i < returns.length; i += 1) {
    price *= 1 + returns[i]!;
    points.push(point(i + 1, price));
  }
  return points;
}

function lcg(seed: number, length: number): number[] {
  let state = seed >>> 0;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  });
}

describe('analyzeNewsMarketCorrelation', () => {
  it('reports a known positive zero-lag coefficient with n and a confidence interval', () => {
    const newsValues = Array.from({ length: 25 }, (_, i) => i + 1);
    const news = newsValues.map((value, i) => point(i + 1, value));
    const market = pricesFromReturns(newsValues.map((value) => value / 10_000));

    const result = analyzeNewsMarketCorrelation(news, market, {
      windowHours: 48,
      maxLagHours: 6,
    });

    assert.ok(result.coefficient !== null);
    assert.ok(result.coefficient > 0.999);
    assert.equal(result.sampleSize, 25);
    assert.ok(result.confidenceInterval !== null);
    assert.ok(result.confidenceInterval.low > 0.99);
    assert.ok(result.confidenceInterval.high <= 1);
    assert.equal(result.relationship, 'strong-positive');
    assert.equal(result.leadLag.relationship, 'neither');
  });

  it('detects when the news series leads market returns by two hours', () => {
    const newsValues = lcg(17, 72).map((value) => 10 + value * 90);
    const news = newsValues.map((value, i) => point(i, value));
    // pricesFromReturns applies returns[i] at hour i + 1, so using news[i - 1]
    // makes the source observation exactly two hours earlier than the return.
    const returns = newsValues.map((_, i) => (i >= 1 ? newsValues[i - 1]! / 50_000 : 0));
    const market = pricesFromReturns(returns);

    const result = analyzeNewsMarketCorrelation(news, market, {
      windowHours: 96,
      maxLagHours: 6,
    });

    assert.equal(result.leadLag.relationship, 'news-leads');
    assert.equal(result.leadLag.hours, 2);
    assert.ok(result.leadLag.coefficient !== null);
    assert.ok(result.leadLag.coefficient > 0.99);
    assert.ok(result.leadLag.sampleSize >= 60);
  });

  it('detects when market returns lead the news series by two hours', () => {
    const newsValues = lcg(31, 72).map((value) => 10 + value * 90);
    const news = newsValues.map((value, i) => point(i + 3, value));
    const market = pricesFromReturns(newsValues.map((value) => value / 50_000));

    const result = analyzeNewsMarketCorrelation(news, market, {
      windowHours: 96,
      maxLagHours: 6,
    });

    assert.equal(result.leadLag.relationship, 'market-leads');
    assert.equal(result.leadLag.hours, 2);
    assert.ok(result.leadLag.coefficient !== null);
    assert.ok(result.leadLag.coefficient > 0.99);
    assert.ok(result.leadLag.sampleSize >= 60);
  });

  it('renders an uncorrelated fixture as no clear relationship', () => {
    const newsValues = lcg(123, 240).map((value) => 1 + value * 99);
    const returns = lcg(987654, 240).map((value) => (value - 0.5) / 100);
    const news = newsValues.map((value, i) => point(i + 1, value));
    const market = pricesFromReturns(returns);

    const result = analyzeNewsMarketCorrelation(news, market, {
      windowHours: 300,
      maxLagHours: 6,
    });

    assert.ok(result.coefficient !== null);
    assert.ok(Math.abs(result.coefficient) < 0.15);
    assert.ok(result.confidenceInterval !== null);
    assert.ok(result.confidenceInterval.low < 0);
    assert.ok(result.confidenceInterval.high > 0);
    assert.equal(result.relationship, 'none');
    assert.equal(result.leadLag.relationship, 'neither');
  });

  it('fails closed when there are too few aligned returns', () => {
    const result = analyzeNewsMarketCorrelation(
      [point(1, 10), point(2, 20), point(3, 30)],
      pricesFromReturns([0.01, 0.02, 0.03]),
      { windowHours: 24, maxLagHours: 3 },
    );

    assert.equal(result.coefficient, null);
    assert.equal(result.confidenceInterval, null);
    assert.equal(result.relationship, 'insufficient-data');
    assert.equal(result.leadLag.relationship, 'neither');
  });

  it('does not turn a two-hour price move into an hourly return', () => {
    const result = analyzeNewsMarketCorrelation(
      [point(2, 50)],
      [point(0, 100), point(2, 110)],
      { windowHours: 24, maxLagHours: 0 },
    );

    assert.deepEqual(result.alignedPoints, []);
    assert.equal(result.sampleSize, 0);
  });
});

describe('isMarketCorrelationPayload', () => {
  it('accepts the persisted series shape and rejects malformed arrays', () => {
    const valid = {
      updatedAt: point(1, 1).timestamp,
      range: '14d',
      interval: '1h',
      series: [{ symbol: '^GSPC', label: 'S&P 500', points: [point(1, 100)] }],
    };

    assert.equal(isMarketCorrelationPayload(valid), true);
    assert.equal(isMarketCorrelationPayload({ ...valid, series: {} }), false);
    assert.equal(isMarketCorrelationPayload({
      ...valid,
      series: [{ ...valid.series[0], points: [{ timestamp: point(1, 1).timestamp, value: '100' }] }],
    }), false);
  });
});
