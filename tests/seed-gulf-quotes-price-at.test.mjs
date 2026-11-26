import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGulfQuotes } from '../scripts/seed-gulf-quotes.mjs';

const YAHOO_MARKET_TIME_S = 1_795_500_000;
const AV_COMMODITY_DATE = '2026-11-20';
const AV_FX_DATE = '2026-11-21';

const originalFetch = globalThis.fetch;
const originalAvKey = process.env.ALPHA_VANTAGE_API_KEY;

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function yahooChart(symbol) {
  const meta = { regularMarketPrice: 100, chartPreviousClose: 99 };
  if (symbol !== 'GULF') meta.regularMarketTime = YAHOO_MARKET_TIME_S;
  return { chart: { result: [{ meta, indicators: { quote: [{ close: [98, 99, 100] }] } }] } };
}

function installProviders() {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'query1.finance.yahoo.com') {
      return json(yahooChart(decodeURIComponent(url.pathname.split('/').pop())));
    }
    if (url.hostname === 'www.alphavantage.co') {
      const fn = url.searchParams.get('function');
      if (fn === 'FX_DAILY') {
        return json({ 'Time Series FX (Daily)': {
          '2026-11-20': { '4. close': '0.2665' },
          [AV_FX_DATE]: { '4. close': '0.2666' },
        } });
      }
      return json({ data: [{ date: AV_COMMODITY_DATE, value: '78.5' }, { date: '2026-11-19', value: '77.0' }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

beforeEach(installProviders);

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAvKey === undefined) delete process.env.ALPHA_VANTAGE_API_KEY;
  else process.env.ALPHA_VANTAGE_API_KEY = originalAvKey;
});

function priceAtBySymbol(quotes) {
  return Object.fromEntries(quotes.map((q) => [q.symbol, q.priceAt]));
}

test('Gulf quotes carry each provider observation time as priceAt', async () => {
  process.env.ALPHA_VANTAGE_API_KEY = 'test-key';
  const { quotes } = await fetchGulfQuotes();
  const priceAt = priceAtBySymbol(quotes);

  assert.equal(priceAt['BZ=F'], Date.parse(AV_COMMODITY_DATE));
  assert.equal(priceAt['CL=F'], Date.parse(AV_COMMODITY_DATE));
  assert.equal(priceAt['SARUSD=X'], Date.parse(AV_FX_DATE));
  assert.equal(priceAt['^TASI.SR'], YAHOO_MARKET_TIME_S * 1000);
});

test('Yahoo-sourced Gulf quotes use regularMarketTime and omit priceAt without it', async () => {
  delete process.env.ALPHA_VANTAGE_API_KEY;
  const { quotes } = await fetchGulfQuotes();
  const priceAt = priceAtBySymbol(quotes);

  assert.equal(priceAt['BZ=F'], YAHOO_MARKET_TIME_S * 1000);
  assert.equal(priceAt['SARUSD=X'], YAHOO_MARKET_TIME_S * 1000);
  assert.equal(priceAt['^TASI.SR'], YAHOO_MARKET_TIME_S * 1000);
  assert.ok(quotes.some((q) => q.symbol === 'GULF'));
  assert.equal('priceAt' in quotes.find((q) => q.symbol === 'GULF'), false);
});
