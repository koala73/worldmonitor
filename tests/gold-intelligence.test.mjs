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
import { buildReservesPayload } from '../scripts/seed-gold-cb-reserves.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const COMMODITY_KEY = 'market:commodities-bootstrap:v1';
const COT_KEY = 'market:cot:v1';
const GOLD_EXTENDED_KEY = 'market:gold-extended:v1';
const GOLD_CB_RESERVES_KEY = 'market:gold-cb-reserves:v1';

const cacheStore = new Map();
const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

let getGoldIntelligence;
let goldRoute;
let goldTool;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.VERCEL_ENV = 'production';

  globalThis.fetch = async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (new URL(urlStr).pathname === '/api/market/v1/get-gold-intelligence') {
      return goldRoute.handler(new Request(urlStr, init));
    }
    const getMatch = urlStr.match(/\/get\/([^/?#]+)$/);
    if (getMatch) {
      const key = decodeURIComponent(getMatch[1]);
      return jsonResponse({ result: cacheStore.has(key) ? JSON.stringify(cacheStore.get(key)) : null });
    }
    if (urlStr.includes('/set/')) return jsonResponse({ result: 'OK' });
    return originalFetch(url, init);
  };

  ({ getGoldIntelligence } = await import('../server/worldmonitor/market/v1/get-gold-intelligence.ts'));
  const { createMarketServiceRoutes } = await import('../src/generated/server/worldmonitor/market/v1/service_server.ts');
  goldRoute = createMarketServiceRoutes({ getGoldIntelligence }).find(route => route.path.endsWith('/get-gold-intelligence'));
  const { PUBLIC_DOMAIN_TOOLS } = await import('../api/mcp/registry/public-domain-tools.ts');
  goldTool = PUBLIC_DOMAIN_TOOLS.find(tool => tool.name === 'get_gold_intelligence');
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
const callTool = () => goldTool._execute({}, 'https://worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' });

function reservesFixture(indicator) {
  const raw = Object.fromEntries(['USA', 'DEU', 'ITA', 'FRA', 'CHN'].map((iso3, i) => [iso3, {
    byMonth: { '2026-09': 32150.7466 * (10 + i), '2025-09': 32150.7466 * 10 },
  }]));
  const goldUsd = Object.fromEntries(Object.keys(raw).map(iso3 => [iso3, { byMonth: { '2026-09': 50 } }]));
  const totalUsd = Object.fromEntries(Object.keys(raw).map(iso3 => [iso3, { byMonth: { '2026-09': 100 } }]));
  return buildReservesPayload(raw, indicator, goldUsd, totalUsd);
}

describe('gold reserve quantities through HTTP and MCP', () => {
  it('marks legacy USD-fallback zeroes as unmeasured while retaining percentages, source units and prices', async () => {
    seedQuotes([quote('GC=F', 3200)]);
    cacheStore.set(GOLD_CB_RESERVES_KEY, reservesFixture('IRFCLDT1_IRFCL56_USD'));
    const result = await callTool();
    assert.equal(result.unavailable, false);
    assert.equal(result.goldPrice, 3200);
    assert.equal(result.cbReserves.totalTonnes, 0);
    assert.ok(result.cbReserves.topHolders.every(holder => holder.tonnes === 0));
    assert.ok(result.cbReserves.topHolders.every(holder => holder.pctOfReserves === 50));
    assert.equal(result.cbReserves.indicator, 'IRFCLDT1_IRFCL56_USD');
    assert.equal(result.cbReserves.valueIsOunces, false);
    assert.equal(result.cbReserves.asOfMonth, '2026-09');
    assert.deepEqual(result.cbReserves.topBuyers12m, []);
    assert.deepEqual(result.cbReserves.topSellers12m, []);
    const ajv = new Ajv2020({ strict: false });
    assert.ok(ajv.validate(goldTool.outputSchema, result), ajv.errorsText());
    const properties = goldTool.outputSchema.properties.cbReserves.properties;
    assert.equal(properties.valueIsOunces.type, 'boolean');
    assert.equal(properties.indicator.type, 'string');
  });

  it('preserves measured ounce-based quantities, movers and genuine zero quantities', async () => {
    seedQuotes([quote('GC=F', 3200)]);
    const payload = reservesFixture('IRFCLDT1_IRFCL56_FTO');
    cacheStore.set(GOLD_CB_RESERVES_KEY, payload);
    const { cbReserves } = await callTool();
    assert.equal(cbReserves.totalTonnes, 60);
    assert.equal(cbReserves.valueIsOunces, true);
    assert.deepEqual(cbReserves.topHolders.map(holder => holder.tonnes), [14, 13, 12, 11, 10]);
    assert.deepEqual(cbReserves.topBuyers12m.map(holder => holder.deltaTonnes12m), [4, 3, 2, 1]);
    payload.totalTonnes = 0;
    payload.topHolders.forEach(holder => { holder.tonnes = 0; });
    const zero = await callTool();
    assert.equal(zero.cbReserves.valueIsOunces, true, 'a measured zero remains distinct from a fallback placeholder');
    assert.equal(zero.cbReserves.totalTonnes, 0);
    assert.ok(zero.cbReserves.topHolders.every(holder => holder.tonnes === 0));
  });

  it('does not infer quantity availability from missing unit metadata or expose fallback movers', async () => {
    seedQuotes([quote('GC=F', 3200)]);
    const payload = reservesFixture('IRFCLDT1_IRFCL56_USD');
    payload.topBuyers12m = [{ iso3: 'USA', name: 'United States', deltaTonnes12m: 1 }];
    cacheStore.set(GOLD_CB_RESERVES_KEY, payload);
    assert.deepEqual((await callTool()).cbReserves.topBuyers12m, []);
    delete payload.valueIsOunces;
    const { cbReserves } = await callTool();
    assert.equal(cbReserves.totalTonnes, 0);
    assert.ok(!Object.hasOwn(cbReserves, 'valueIsOunces'));
    assert.ok(cbReserves.topHolders.every(holder => holder.tonnes === 0));
    assert.deepEqual(cbReserves.topBuyers12m, []);
  });

  it('keeps a missing reserves snapshot absent without making valid quotes unavailable', async () => {
    seedQuotes([quote('GC=F', 3200)]);
    const result = await callTool();
    assert.equal(result.unavailable, false);
    assert.ok(!Object.hasOwn(result, 'cbReserves'));
  });
});

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

  it('converts gold to CHF with the USD-base exchange rate', async () => {
    seedQuotes([quote('GC=F', 3200), quote('USDCHF=X', 0.8)]);
    const res = await call();
    assert.equal(res.crossCurrencyPrices.find(({ currency }) => currency === 'CHF')?.price, 2560);
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
