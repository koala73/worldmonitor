import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CHINA_COUNTRY_STOCK_INDEX_KEY,
  buildCountryStockIndexSnapshot,
  buildCountryStockIndexSnapshotFromCloses,
  countryStockIndexKey,
} from '../scripts/_country-stock-index.mjs';
import { loadCountryStockIndexes } from '../scripts/_country-stock-index-registry.mjs';

const FIXED_AT = '2026-07-14T12:00:00.000Z';

test('buildCountryStockIndexSnapshot writes the public CN RPC shape from a one-month Yahoo chart', () => {
  const snapshot = buildCountryStockIndexSnapshot({
    chart: {
      result: [{
        meta: { currency: 'CNY' },
        indicators: { quote: [{ close: [3200, 3210, null, 3300, 3320, 3310, 3340, 3360, 3355] }] },
      }],
    },
  }, FIXED_AT);

  assert.deepEqual(snapshot, {
    available: true,
    code: 'CN',
    symbol: '000001.SS',
    indexName: 'SSE Composite',
    price: 3355,
    weekChangePercent: 1.67,
    currency: 'CNY',
    fetchedAt: FIXED_AT,
  });
});

test('buildCountryStockIndexSnapshot rejects incomplete Yahoo charts instead of publishing an unavailable cache row', () => {
  assert.equal(buildCountryStockIndexSnapshot({ chart: { result: [{ indicators: { quote: [{ close: [3300] }] } }] } }, FIXED_AT), null);
});

test('buildCountryStockIndexSnapshotFromCloses shares the relay-safe daily-close snapshot contract', () => {
  assert.deepEqual(buildCountryStockIndexSnapshotFromCloses([3200, 3210, 3300, 3320, 3310, 3340, 3360, 3355], 'CNY', FIXED_AT), {
    available: true,
    code: 'CN',
    symbol: '000001.SS',
    indexName: 'SSE Composite',
    price: 3355,
    weekChangePercent: 1.67,
    currency: 'CNY',
    fetchedAt: FIXED_AT,
  });
});

test('buildCountryStockIndexSnapshotFromCloses filters malformed closes before calculating the weekly movement', () => {
  assert.equal(buildCountryStockIndexSnapshotFromCloses([3200, 'broken', null], 'CNY', FIXED_AT), null);
});

test('the per-country handler keeps no CN-only gate and no legacy single key', () => {
  // #6235 replaced a CN-only branch and a single shared cache key with a
  // per-country key prefix. Both removals are absence contracts — nothing
  // executable can observe that a branch is gone — and the wiring assertions
  // that used to sit alongside them are covered behaviourally by
  // tests/country-stock-index-seed-all.test.mts.
  const handlerSource = readFileSync(
    new URL('../server/worldmonitor/market/v1/get-country-stock-index.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(handlerSource, /if \(code === 'CN'\)/);
  assert.doesNotMatch(handlerSource, /const REDIS_CACHE_KEY = 'market:stock-index:v1';/);
});


test('the whole-enum work-list is derived from the public country contract', () => {
  const indexes = loadCountryStockIndexes();
  assert.ok(indexes.length >= 45, `expected the full country enum, got ${indexes.length}`);
  assert.ok(indexes.some(i => i.code === 'CN'), 'CN must remain in the seeded set');
  assert.equal(new Set(indexes.map(i => i.code)).size, indexes.length, 'country codes must be unique');
  assert.equal(countryStockIndexKey('DE'), 'market:stock-index:v1:DE');
});
