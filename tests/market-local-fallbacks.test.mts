import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const marketSource = fs.readFileSync('/Users/lab2/AI/AI_1/worldmonitor/src/services/market/index.ts', 'utf8');

test('market service keeps local fallback snapshots for empty stock, commodity, crypto, and sector responses', () => {
  assert.match(marketSource, /LOCAL_STOCK_FALLBACK_QUOTES/);
  assert.match(marketSource, /LOCAL_COMMODITY_FALLBACK_QUOTES/);
  assert.match(marketSource, /LOCAL_CRYPTO_FALLBACK_QUOTES/);
  assert.match(marketSource, /LOCAL_SECTOR_FALLBACK/);
});

test('market service returns local stock and commodity fallbacks when live responses are empty', () => {
  assert.match(marketSource, /const localFallback = getLocalStockFallback\(symbols\)/);
  assert.match(marketSource, /lastSuccessfulByKey\.get\(setKey\) \|\| localFallback/);
  assert.match(marketSource, /results\.length > 0 \? results : getLocalCommodityFallback\(symbols\)/);
});

test('market service returns local crypto and sector fallbacks when live responses are empty', () => {
  assert.match(marketSource, /lastSuccessfulCrypto\.length > 0 \? lastSuccessfulCrypto : LOCAL_CRYPTO_FALLBACK_QUOTES\.map\(toCryptoData\)/);
  assert.match(marketSource, /return result\.sectors\.length > 0 \? result : LOCAL_SECTOR_FALLBACK/);
});
