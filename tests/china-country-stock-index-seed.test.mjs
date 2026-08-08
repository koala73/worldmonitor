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

test('the Railway market seed maintains every country cache alongside its public stock bootstrap contract', () => {
  const source = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');
  const handlerSource = readFileSync(new URL('../server/worldmonitor/market/v1/get-country-stock-index.ts', import.meta.url), 'utf8');

  // #6235: the seed covers the whole enum, not just CN. These assertions pin
  // the wiring; the behavioural coverage lives in
  // tests/country-stock-index-seed-all.test.mts.
  assert.match(source, /COUNTRY_STOCK_INDEX_KEYS/);
  assert.match(source, /writeCountryStockIndexes/);
  assert.match(source, /preserveKeys:\s*COUNTRY_STOCK_INDEX_KEYS/);
  assert.match(source, /Country index refresh/);
  assert.match(source, /await extendExistingTtl\(\[key\], CACHE_TTL\)/);
  assert.match(source, /await writeExtraKey\(key, snapshot, CACHE_TTL\)/);
  // The country keys are extended best-effort via extendExistingTtlDetailed
  // rather than gating the canonical fast path — see
  // tests/country-stock-index-health.test.mjs for why.
  assert.match(source, /extendExistingTtlDetailed\(COUNTRY_STOCK_INDEX_KEYS, CACHE_TTL\)/);
  assert.match(handlerSource, /const REDIS_CACHE_KEY = 'market:stock-index:rpc:v1';/);
  assert.match(handlerSource, /const RAILWAY_SEEDED_COUNTRY_INDEX_KEY_PREFIX = 'market:stock-index:v1:';/);
  assert.match(handlerSource, /getCachedJson\(railwaySeededKey\(code\), true\)/);
  assert.doesNotMatch(handlerSource, /const REDIS_CACHE_KEY = 'market:stock-index:v1';/);
  // The CN-only gate is what #6235 removed — it must not come back.
  assert.doesNotMatch(handlerSource, /if \(code === 'CN'\)/);
});

test('the whole-enum work-list is derived from the public country contract', () => {
  const indexes = loadCountryStockIndexes();
  assert.ok(indexes.length >= 45, `expected the full country enum, got ${indexes.length}`);
  assert.ok(indexes.some(i => i.code === 'CN'), 'CN must remain in the seeded set');
  assert.equal(new Set(indexes.map(i => i.code)).size, indexes.length, 'country codes must be unique');
  assert.equal(countryStockIndexKey('DE'), 'market:stock-index:v1:DE');
});

test('the live AIS relay writes the China index only from a fresh one-month Yahoo chart', () => {
  const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

  assert.match(source, /import\('\.\/_country-stock-index\.mjs'\)/);
  assert.match(source, /fetchYahooChartDirect\(CHINA_COUNTRY_STOCK_SYMBOL, '\?range=1mo&interval=1d'\)/);
  assert.match(source, /freshQuotes\.some\(\(quote\) => quote\.symbol === CHINA_COUNTRY_STOCK_SYMBOL\)/);
  assert.match(source, /upstashSet\(CHINA_COUNTRY_STOCK_INDEX_KEY, snapshot, MARKET_SEED_TTL\)/);
  assert.match(source, /CHINA_COUNTRY_STOCK_INDEX_KEY,\s*\n\s*buildCountryStockIndexSnapshotFromCloses,/);
  assert.doesNotMatch(source, /const CHINA_COUNTRY_STOCK_INDEX_KEY = 'market:stock-index:v1:CN';/);
  assert.match(source, /preserveKeys:\s*\[CHINA_COUNTRY_STOCK_INDEX_KEY\]/);
});
