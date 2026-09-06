/**
 * getGoldIntelligence — the gold panel's server handler.
 *
 * Every case calls the production handler with the five cache keys it reads
 * served from an in-memory store through the Upstash REST shape, the same
 * seam tests/get-airport-ops-summary-coverage.test.mjs uses. The file this
 * replaced re-implemented the ratio, premium, cross-currency and COT logic
 * locally and passed with no production file present (#7770).
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const COMMODITY_KEY = 'market:commodities-bootstrap:v1';
const COT_KEY = 'market:cot:v1';
const GOLD_EXTENDED_KEY = 'market:gold-extended:v1';

const cacheStore = new Map();
const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

let getGoldIntelligence;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.VERCEL_ENV = 'production';

  globalThis.fetch = async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const getMatch = urlStr.match(/\/get\/([^/?#]+)$/);
    if (getMatch) {
      const key = decodeURIComponent(getMatch[1]);
      return jsonResponse({ result: cacheStore.has(key) ? JSON.stringify(cacheStore.get(key)) : null });
    }
    if (urlStr.includes('/set/')) return jsonResponse({ result: 'OK' });
    return originalFetch(url, init);
  };

  ({ getGoldIntelligence } = await import('../server/worldmonitor/market/v1/get-gold-intelligence.ts'));
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  cacheStore.clear();
});

const quote = (symbol, price, change = 0) => ({ symbol, price, change, sparkline: [] });

function seedQuotes(quotes) {
  cacheStore.set(COMMODITY_KEY, { quotes });
}

const call = () => getGoldIntelligence({}, {});

describe('getGoldIntelligence', () => {
  it('reports unavailable when the commodity snapshot is missing or has no GC=F', async () => {
    const empty = await call();
    assert.equal(empty.unavailable, true);
    assert.equal(empty.goldPrice, 0);
    assert.deepEqual(empty.crossCurrencyPrices, []);

    seedQuotes([quote('SI=F', 35), quote('PL=F', 950), quote('EURUSD=X', 1.08)]);
    const noGold = await call();
    assert.equal(noGold.unavailable, true);
    assert.equal(noGold.goldPrice, 0);
    assert.equal(noGold.goldSilverRatio, undefined);
    assert.deepEqual(noGold.crossCurrencyPrices, []);
  });

  it('gold/silver ratio is absent when silver is missing, zero or negative, and 80 for 3200 over 40', async () => {
    for (const silver of [undefined, 0, -5]) {
      seedQuotes([quote('GC=F', 3200), ...(silver === undefined ? [] : [quote('SI=F', silver)])]);
      const res = await call();
      assert.equal(res.unavailable, false);
      assert.equal(res.goldSilverRatio, undefined, `silver=${silver}`);
    }
    seedQuotes([quote('GC=F', 3200), quote('SI=F', 40)]);
    const res = await call();
    assert.equal(res.goldSilverRatio, 80);
    assert.equal(res.silverPrice, 40);
  });

  it('gold/platinum premium is absent when platinum is missing or zero, and (gold - pt) / pt otherwise', async () => {
    for (const platinum of [undefined, 0]) {
      seedQuotes([quote('GC=F', 3200), ...(platinum === undefined ? [] : [quote('PL=F', platinum)])]);
      const res = await call();
      assert.equal(res.goldPlatinumPremiumPct, undefined, `platinum=${platinum}`);
    }
    seedQuotes([quote('GC=F', 3200), quote('PL=F', 950)]);
    const res = await call();
    assert.ok(Math.abs(res.goldPlatinumPremiumPct - ((3200 - 950) / 950) * 100) < 1e-9);
    assert.equal(res.platinumPrice, 950);
  });

  it('cross-currency prices divide USD-quoted pairs, multiply USD-base pairs, and omit missing or unusable pairs', async () => {
    seedQuotes([
      quote('GC=F', 3200),
      quote('EURUSD=X', 1.08),
      quote('USDJPY=X', 0),
      quote('GBPUSD=X', Number.NaN),
      quote('USDCNY=X', 7.25),
      quote('USDINR=X', -1),
    ]);
    const res = await call();
    assert.deepEqual(
      res.crossCurrencyPrices.map(({ currency, price }) => ({ currency, price: Number(price.toFixed(4)) })),
      [
        { currency: 'EUR', price: Number((3200 / 1.08).toFixed(4)) },
        { currency: 'CNY', price: Number((3200 * 7.25).toFixed(4)) },
      ],
      'EUR is quoted as USD per unit so gold divides; CNY is quoted as units per USD so gold multiplies; JPY, GBP, INR and CHF have no usable quote',
    );
    for (const row of res.crossCurrencyPrices) assert.ok(row.flag.length > 0, `${row.currency} carries a flag`);
  });

  it('COT is absent without a GC instrument and maps legacy flat long/short fields into the v2 categories', async () => {
    seedQuotes([quote('GC=F', 3200)]);
    cacheStore.set(COT_KEY, {
      instruments: [
        { code: 'ES', name: 'E-mini S&P', reportDate: '2026-04-08', assetManagerLong: 100, assetManagerShort: 50 },
        { code: 'CL', name: 'Crude Oil', reportDate: '2026-04-08', assetManagerLong: 200, assetManagerShort: 150 },
      ],
    });
    assert.equal((await call()).cot, undefined, 'no GC row');

    cacheStore.set(COT_KEY, { instruments: [] });
    assert.equal((await call()).cot, undefined, 'empty instruments');

    cacheStore.set(COT_KEY, {
      instruments: [{
        code: 'GC', name: 'Gold', reportDate: '2026-04-08',
        assetManagerLong: 248120, assetManagerShort: 94380, dealerLong: 50000, dealerShort: 60000, netPct: 62.3,
      }],
    });
    const { cot } = await call();
    assert.ok(cot, 'GC row maps to positioning');
    assert.equal(cot.reportDate, '2026-04-08');
    assert.equal(cot.managedMoney.longPositions, '248120');
    assert.equal(cot.managedMoney.shortPositions, '94380');
    assert.equal(cot.managedMoney.netPct, 62.3, 'a seeded netPct wins over the derived one');
    assert.equal(cot.producerSwap.longPositions, '50000');
    assert.equal(cot.producerSwap.shortPositions, '60000');
    assert.ok(Math.abs(cot.producerSwap.netPct - ((50000 - 60000) / 110000) * 100) < 1e-9, 'dealer net is derived from long and short');
    assert.equal(cot.openInterest, '0', 'legacy payloads carry no open interest');
  });

  it('partial availability: prices render without COT, and COT renders without the enrichment layer', async () => {
    seedQuotes([quote('GC=F', 3200, 1.25), quote('SI=F', 35)]);
    const priceOnly = await call();
    assert.equal(priceOnly.unavailable, false);
    assert.equal(priceOnly.cot, undefined);
    assert.ok(Number.isFinite(priceOnly.goldSilverRatio));
    assert.equal(priceOnly.goldChangePct, 1.25);
    assert.equal(priceOnly.updatedAt, '', 'no extended payload means no freshness stamp');
    assert.equal(priceOnly.session, undefined);

    cacheStore.set(COT_KEY, {
      instruments: [{ code: 'GC', name: 'Gold', reportDate: '2026-04-08', assetManagerLong: 1, assetManagerShort: 1 }],
    });
    cacheStore.set(GOLD_EXTENDED_KEY, {
      updatedAt: '2026-04-09T00:00:00.000Z',
      gold: { price: 3200, dayHigh: 3250, dayLow: 3150, prevClose: 3180, returns: { w1: 1, m1: 2, ytd: 3, y1: 4 }, range52w: { hi: 3300, lo: 2000, positionPct: 90 } },
      drivers: [],
    });
    const enriched = await call();
    assert.ok(enriched.cot);
    assert.equal(enriched.updatedAt, '2026-04-09T00:00:00.000Z');
    assert.deepEqual(enriched.session, { dayHigh: 3250, dayLow: 3150, prevClose: 3180 });
    assert.deepEqual(enriched.returns, { w1: 1, m1: 2, ytd: 3, y1: 4 });
  });
});
