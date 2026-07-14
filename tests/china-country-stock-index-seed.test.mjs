import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CHINA_COUNTRY_STOCK_INDEX_KEY, buildCountryStockIndexSnapshot } from '../scripts/_country-stock-index.mjs';

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

test('the Railway market seed maintains the China cache alongside its public stock bootstrap contract', () => {
  const source = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');
  const handlerSource = readFileSync(new URL('../server/worldmonitor/market/v1/get-country-stock-index.ts', import.meta.url), 'utf8');

  assert.match(source, /CHINA_COUNTRY_STOCK_INDEX_KEY/);
  assert.match(source, /writeChinaCountryStockIndex/);
  assert.match(source, /preserveKeys:\s*\[CHINA_COUNTRY_STOCK_INDEX_KEY\]/);
  assert.match(source, /China country index refresh failed/);
  assert.match(source, /await extendExistingTtl\(\[CHINA_COUNTRY_STOCK_INDEX_KEY\], CACHE_TTL\)/);
  assert.match(source, /await writeExtraKey\(CHINA_COUNTRY_STOCK_INDEX_KEY, snapshot, CACHE_TTL\)/);
  assert.match(source, /extendExistingTtl\(\[CANONICAL_KEY, 'seed-meta:market:stocks', RPC_KEY, CHINA_COUNTRY_STOCK_INDEX_KEY\]/);
  assert.match(handlerSource, /const REDIS_CACHE_KEY = 'market:stock-index:rpc:v1';/);
  assert.match(handlerSource, /const RAILWAY_SEEDED_COUNTRY_INDEX_KEY = 'market:stock-index:v1:CN';/);
  assert.match(handlerSource, /getCachedJson\(RAILWAY_SEEDED_COUNTRY_INDEX_KEY, true\)/);
  assert.doesNotMatch(handlerSource, /const REDIS_CACHE_KEY = 'market:stock-index:v1';/);
});
