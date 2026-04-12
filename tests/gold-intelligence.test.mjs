import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const XAU_FX = [
  { symbol: 'EURUSD=X', label: 'EUR', flag: '🇪🇺', multiply: false },
  { symbol: 'GBPUSD=X', label: 'GBP', flag: '🇬🇧', multiply: false },
  { symbol: 'USDJPY=X', label: 'JPY', flag: '🇯🇵', multiply: true },
  { symbol: 'USDCNY=X', label: 'CNY', flag: '🇨🇳', multiply: true },
  { symbol: 'USDINR=X', label: 'INR', flag: '🇮🇳', multiply: true },
  { symbol: 'USDCHF=X', label: 'CHF', flag: '🇨🇭', multiply: false },
];

function computeGoldSilverRatio(goldPrice, silverPrice) {
  if (!goldPrice || goldPrice <= 0 || !silverPrice || silverPrice <= 0) return null;
  return goldPrice / silverPrice;
}

function computeGoldPlatinumPremium(goldPrice, platinumPrice) {
  if (!goldPrice || goldPrice <= 0 || !platinumPrice || platinumPrice <= 0) return null;
  return ((goldPrice - platinumPrice) / platinumPrice) * 100;
}

function computeCrossCurrency(goldPrice, quotes) {
  if (!goldPrice || goldPrice <= 0) return [];
  const quoteMap = new Map(quotes.map(q => [q.symbol, q]));
  const results = [];
  for (const cfg of XAU_FX) {
    const fx = quoteMap.get(cfg.symbol);
    if (!fx?.price || !Number.isFinite(fx.price) || fx.price <= 0) continue;
    const xauPrice = cfg.multiply ? goldPrice * fx.price : goldPrice / fx.price;
    if (!Number.isFinite(xauPrice) || xauPrice <= 0) continue;
    results.push({ currency: cfg.label, flag: cfg.flag, price: xauPrice });
  }
  return results;
}

function extractGoldCot(instruments) {
  if (!instruments || !Array.isArray(instruments)) return null;
  const gc = instruments.find(i => i.code === 'GC');
  if (!gc) return null;
  return {
    reportDate: String(gc.reportDate ?? ''),
    managedMoneyLong: Number(gc.assetManagerLong ?? 0),
    managedMoneyShort: Number(gc.assetManagerShort ?? 0),
    netPct: Number(gc.netPct ?? 0),
    dealerLong: Number(gc.dealerLong ?? 0),
    dealerShort: Number(gc.dealerShort ?? 0),
  };
}

describe('Gold Intelligence', () => {
  it('gold/silver ratio returns null when silver is null, zero, or negative', () => {
    assert.strictEqual(computeGoldSilverRatio(3200, null), null);
    assert.strictEqual(computeGoldSilverRatio(3200, 0), null);
    assert.strictEqual(computeGoldSilverRatio(3200, -5), null);
    assert.strictEqual(computeGoldSilverRatio(null, 35), null);
    assert.strictEqual(computeGoldSilverRatio(0, 35), null);

    const ratio = computeGoldSilverRatio(3200, 40);
    assert.strictEqual(ratio, 80);
  });

  it('COT filtering returns null when no GC instrument present', () => {
    const instruments = [
      { code: 'ES', name: 'E-mini S&P', reportDate: '2026-04-08', assetManagerLong: 100, assetManagerShort: 50, dealerLong: 30, dealerShort: 20, netPct: 33.3 },
      { code: 'NQ', name: 'E-mini Nasdaq', reportDate: '2026-04-08', assetManagerLong: 80, assetManagerShort: 60, dealerLong: 25, dealerShort: 15, netPct: 14.3 },
      { code: 'CL', name: 'Crude Oil', reportDate: '2026-04-08', assetManagerLong: 200, assetManagerShort: 150, dealerLong: 90, dealerShort: 80, netPct: 14.3 },
    ];
    assert.strictEqual(extractGoldCot(instruments), null);
    assert.strictEqual(extractGoldCot(null), null);
    assert.strictEqual(extractGoldCot([]), null);
  });

  it('FX cross-currency omits rows when FX pair is missing', () => {
    const quotes = [
      { symbol: 'EURUSD=X', price: 1.08 },
      { symbol: 'USDCNY=X', price: 7.25 },
    ];
    const result = computeCrossCurrency(3200, quotes);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].currency, 'EUR');
    assert.ok(Math.abs(result[0].price - 3200 / 1.08) < 0.01);
    assert.strictEqual(result[1].currency, 'CNY');
    assert.ok(Math.abs(result[1].price - 3200 * 7.25) < 0.01);

    const noGold = computeCrossCurrency(0, quotes);
    assert.strictEqual(noGold.length, 0);
  });

  it('gold/platinum premium returns null when platinum is null or zero', () => {
    assert.strictEqual(computeGoldPlatinumPremium(3200, null), null);
    assert.strictEqual(computeGoldPlatinumPremium(3200, 0), null);
    assert.strictEqual(computeGoldPlatinumPremium(null, 950), null);

    const premium = computeGoldPlatinumPremium(3200, 950);
    assert.ok(Math.abs(premium - ((3200 - 950) / 950) * 100) < 0.01);
  });

  it('returns unavailable when GC=F is missing from commodity snapshot', () => {
    const quotes = [
      { symbol: 'SI=F', price: 35 },
      { symbol: 'PL=F', price: 950 },
      { symbol: 'PA=F', price: 1020 },
      { symbol: 'EURUSD=X', price: 1.08 },
    ];
    const quoteMap = new Map(quotes.map(q => [q.symbol, q]));
    const gold = quoteMap.get('GC=F');
    assert.strictEqual(gold, undefined);

    const goldPrice = gold?.price ?? 0;
    assert.strictEqual(goldPrice, 0);

    const ratio = computeGoldSilverRatio(goldPrice, 35);
    assert.strictEqual(ratio, null);
    const cross = computeCrossCurrency(goldPrice, quotes);
    assert.strictEqual(cross.length, 0);
  });

  it('partial availability: price works when cot is null, and vice versa', () => {
    const goldPrice = 3200;
    const silverPrice = 35;
    const ratio = computeGoldSilverRatio(goldPrice, silverPrice);
    assert.ok(ratio !== null && Number.isFinite(ratio));
    const cot = extractGoldCot(null);
    assert.strictEqual(cot, null);

    const instruments = [
      { code: 'GC', name: 'Gold', reportDate: '2026-04-08', assetManagerLong: 248120, assetManagerShort: 94380, dealerLong: 50000, dealerShort: 60000, netPct: 62.3 },
    ];
    const cotResult = extractGoldCot(instruments);
    assert.ok(cotResult !== null);
    assert.strictEqual(cotResult.managedMoneyLong, 248120);
    assert.strictEqual(cotResult.netPct, 62.3);

    const noPriceRatio = computeGoldSilverRatio(0, 0);
    assert.strictEqual(noPriceRatio, null);
    assert.ok(cotResult !== null);
  });
});
