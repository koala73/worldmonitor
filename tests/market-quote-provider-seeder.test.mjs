/**
 * #6304: seeder-side normalized authorized provider adapter.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';

import {
  authorizedProvidersMissingReason,
  fetchAuthorizedEquityQuotes,
  fetchFinnhubEquityQuote,
  hasSufficientFreshQuoteCoverage,
  toSeedQuote,
} from '../scripts/shared/market-quote-provider.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY,
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  mock.restoreAll();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('toSeedQuote', () => {
  it('normalizes provider output into the seed shape', () => {
    assert.deepEqual(
      toSeedQuote('AAPL', { price: 1, change: 2, sparkline: [1, 2] }, { name: 'Apple', display: 'AAPL' }),
      { symbol: 'AAPL', name: 'Apple', display: 'AAPL', price: 1, change: 2, sparkline: [1, 2] },
    );
  });
});

describe('fetchFinnhubEquityQuote', () => {
  it('returns a normalized quote on success', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ c: 10, dp: 0.5, h: 11, l: 9 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const q = await fetchFinnhubEquityQuote('AAPL', 'k');
    assert.deepEqual(q, { price: 10, change: 0.5, sparkline: [] });
  });

  it('returns null on malformed JSON (errors are not thrown as quotes)', async () => {
    globalThis.fetch = async () =>
      new Response('<<<', { status: 200, headers: { 'Content-Type': 'application/json' } });
    assert.equal(await fetchFinnhubEquityQuote('AAPL', 'k'), null);
  });
});

describe('fetchAuthorizedEquityQuotes', () => {
  it('fills the bulk path from Alpha Vantage when only avKey is configured', async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('function'), 'REALTIME_BULK_QUOTES');
      assert.equal(url.searchParams.get('apikey'), 'av');
      return new Response(JSON.stringify({
        data: [
          { symbol: 'AAPL', price: '200', 'previous close': '196', volume: '1000' },
          { symbol: 'MSFT', price: '420', 'previous close': '420', volume: '2000' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await fetchAuthorizedEquityQuotes({
      symbols: ['AAPL', 'MSFT'],
      alphaVantageKey: 'av',
      finnhubKey: undefined,
    });

    assert.deepEqual(result.quotes.map((quote) => quote.symbol), ['AAPL', 'MSFT']);
    assert.equal(result.quotes[0].price, 200);
    assert.ok(Math.abs(result.quotes[0].change - (4 / 196 * 100)) < 0.0001);
    assert.deepEqual(result.providersUsed, ['alphavantage']);
  });

  it('fills from Finnhub when AV is absent', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      assert.match(url, /finnhub\.io/);
      return new Response(JSON.stringify({ c: 99, dp: 1, h: 100, l: 98 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await fetchAuthorizedEquityQuotes({
      symbols: ['AAPL'],
      yahooOnly: [],
      metaBySymbol: { AAPL: { name: 'Apple', display: 'AAPL' } },
      alphaVantageKey: undefined,
      finnhubKey: 'fh',
    });

    assert.equal(result.quotes.length, 1);
    assert.equal(result.quotes[0].symbol, 'AAPL');
    assert.equal(result.quotes[0].price, 99);
    assert.deepEqual(result.providersUsed, ['finnhub']);
    assert.equal(result.authorizedOnly, true);
  });

  it('uses Yahoo residual only when supplied and authorized providers miss', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ c: 0, dp: 0, h: 0, l: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const result = await fetchAuthorizedEquityQuotes({
      symbols: ['^GSPC'],
      yahooOnly: ['^GSPC'],
      finnhubKey: 'fh',
      fetchYahooQuote: async (symbol) => {
        assert.equal(symbol, '^GSPC');
        return { price: 5000, change: 0.1, sparkline: [] };
      },
    });

    assert.equal(result.quotes.length, 1);
    assert.equal(result.quotes[0].price, 5000);
    assert.equal(result.authorizedOnly, false);
    assert.ok(result.providersUsed.includes('yahoo-residual'));
  });

  it('reports the shared missing-credentials reason', () => {
    assert.equal(
      authorizedProvidersMissingReason(),
      'FINNHUB_API_KEY and ALPHA_VANTAGE_API_KEY not configured',
    );
  });

  it('keeps the edge and seeder missing-credential messages in parity', () => {
    const edgeSource = readFileSync(
      new URL('../server/worldmonitor/market/v1/_quote-provider.ts', import.meta.url),
      'utf8',
    );
    const edgeReason = edgeSource.match(
      /function providerNotConfiguredReason\(\): string \{\s*return '([^']+)'/,
    )?.[1];
    assert.equal(edgeReason, authorizedProvidersMissingReason());
  });
});

describe('fresh quote coverage', () => {
  it('rejects a one-quote refresh even when last-good merge can fill the payload', () => {
    assert.equal(hasSufficientFreshQuoteCoverage(1, 3), false);
  });

  it('accepts the documented 80% fresh-coverage floor', () => {
    assert.equal(hasSufficientFreshQuoteCoverage(8, 10), true);
    assert.equal(hasSufficientFreshQuoteCoverage(7, 10), false);
  });
});
