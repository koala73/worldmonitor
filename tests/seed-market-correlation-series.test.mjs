import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  declareRecords,
  fetchMarketCorrelationSeries,
  normalizeYahooSeries,
} from '../scripts/seed-market-correlation-series.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

function yahooFixture() {
  return {
    chart: {
      result: [{
        timestamp: [1_722_470_400, 1_722_474_000, 1_722_477_600],
        indicators: { quote: [{ close: [100, null, 102.5] }] },
      }],
      error: null,
    },
  };
}

describe('market correlation series seeder', () => {
  it('preserves real quote timestamps and filters missing closes', () => {
    assert.deepEqual(normalizeYahooSeries('^GSPC', 'S&P 500', yahooFixture()), {
      symbol: '^GSPC',
      label: 'S&P 500',
      points: [
        { timestamp: '2024-08-01T00:00:00.000Z', value: 100 },
        { timestamp: '2024-08-01T02:00:00.000Z', value: 102.5 },
      ],
    });
  });

  it('publishes successful series and records a bounded failure for an unavailable symbol', async () => {
    const calls = [];
    const result = await fetchMarketCorrelationSeries({
      markets: [
        { symbol: '^GSPC', label: 'S&P 500' },
        { symbol: 'BTC-USD', label: 'Bitcoin' },
      ],
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      fetchJson: async (_url, { label }) => {
        calls.push(label);
        if (label === 'BTC-USD') throw new Error('secret upstream detail');
        return yahooFixture();
      },
      sleep: async () => {},
    });

    assert.deepEqual(calls, ['^GSPC', 'BTC-USD']);
    assert.equal(result.updatedAt, '2026-08-12T00:00:00.000Z');
    assert.equal(result.interval, '1h');
    assert.equal(result.range, '14d');
    assert.equal(result.series.length, 1);
    assert.deepEqual(result.failures, [{ symbol: 'BTC-USD', reason: 'upstream-unavailable' }]);
    assert.equal(declareRecords(result), 1);
  });

  it('rejects a run when every configured market fails', async () => {
    await assert.rejects(
      fetchMarketCorrelationSeries({
        markets: [{ symbol: '^GSPC', label: 'S&P 500' }],
        fetchJson: async () => { throw new Error('blocked'); },
        sleep: async () => {},
      }),
      /all market correlation series fetches failed/i,
    );
  });

  it('reports partial health until every configured market is covered', () => {
    const { BOOTSTRAP_KEYS, SEED_META, classifyKey } = healthTesting;
    const dataKey = BOOTSTRAP_KEYS.marketCorrelationSeries;
    const metaKey = SEED_META.marketCorrelationSeries.key;
    const classify = (recordCount) => classifyKey(
      'marketCorrelationSeries',
      dataKey,
      { allowOnDemand: true },
      {
        keyStrens: new Map([[dataKey, 2048]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[metaKey, JSON.stringify({
          fetchedAt: Date.now() - 60_000,
          recordCount,
        })]]),
        keyMetaErrors: new Map(),
        now: Date.now(),
      },
    );

    assert.equal(SEED_META.marketCorrelationSeries.minRecordCount, 6);
    assert.equal(classify(1).status, 'COVERAGE_PARTIAL');
    assert.equal(classify(6).status, 'OK');
  });
});
