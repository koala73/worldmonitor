/**
 * #6304: authorized market quote provider adapter.
 *
 * Covers Finnhub primary, Alpha Vantage fallback, cascade behaviour, quota /
 * rate-limit, malformed payloads, and unavailable credentials — without live
 * network calls.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  AlphaVantageQuoteProvider,
  CascadeQuoteProvider,
  FinnhubQuoteProvider,
  isEquityServiceableSymbol,
  isYahooNotationSymbol,
  providerNotConfiguredReason,
  resolveMarketQuoteProvider,
} from '../server/worldmonitor/market/v1/_quote-provider';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY,
};
const ORIGINAL_INFO = console.info;
const ORIGINAL_WARN = console.warn;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.info = ORIGINAL_INFO;
  console.warn = ORIGINAL_WARN;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('symbol serviceability', () => {
  it('declines Yahoo-notation futures, FX, and index tickers', () => {
    assert.equal(isYahooNotationSymbol('GC=F'), true);
    assert.equal(isYahooNotationSymbol('EURUSD=X'), true);
    assert.equal(isYahooNotationSymbol('^GSPC'), true);
    assert.equal(isYahooNotationSymbol('AAPL'), false);
    assert.equal(isEquityServiceableSymbol('AAPL'), true);
    assert.equal(isEquityServiceableSymbol('GC=F'), false);
  });
});

describe('FinnhubQuoteProvider', () => {
  it('returns ok on a primary success', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ c: 190.5, dp: 1.25, h: 191, l: 189, o: 190, pc: 188, t: 1 })) as typeof fetch;
    const p = new FinnhubQuoteProvider('test-key');
    const out = await p.fetchQuote('AAPL');
    assert.deepEqual(out, {
      status: 'ok',
      quote: { price: 190.5, change: 1.25, sparkline: [] },
    });
  });

  it('maps HTTP 429 to rate_limited', async () => {
    globalThis.fetch = (async () => new Response('', { status: 429 })) as typeof fetch;
    const out = await new FinnhubQuoteProvider('k').fetchQuote('AAPL');
    assert.equal(out.status, 'rate_limited');
  });

  it('maps all-zero Finnhub payload to not_found', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ c: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 })) as typeof fetch;
    const out = await new FinnhubQuoteProvider('k').fetchQuote('ZZZZ');
    assert.equal(out.status, 'not_found');
  });

  it('maps malformed JSON to error', async () => {
    globalThis.fetch = (async () =>
      new Response('not-json{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const out = await new FinnhubQuoteProvider('k').fetchQuote('AAPL');
    assert.equal(out.status, 'error');
    if (out.status === 'error') assert.match(out.message, /malformed/i);
  });
});

describe('AlphaVantageQuoteProvider', () => {
  it('returns ok on GLOBAL_QUOTE success', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        'Global Quote': {
          '01. symbol': 'MSFT',
          '05. price': '420.10',
          '10. change percent': '0.55%',
        },
      })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('av-key').fetchQuote('MSFT');
    assert.deepEqual(out, {
      status: 'ok',
      quote: { price: 420.1, change: 0.55, sparkline: [] },
    });
  });

  it('maps Note rate-limit text to rate_limited', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 25 requests per day.',
      })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('av-key').fetchQuote('MSFT');
    assert.equal(out.status, 'rate_limited');
  });

  it('maps provider-busy Information text to rate_limited', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ Information: 'The Alpha Vantage API is too busy at this time. Please retry.' })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('av-key').fetchQuote('MSFT');
    assert.equal(out.status, 'rate_limited');
  });

  it('maps empty Global Quote to not_found', async () => {
    globalThis.fetch = (async () => jsonResponse({ 'Global Quote': {} })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('av-key').fetchQuote('NOPE');
    assert.equal(out.status, 'not_found');
  });

  it('does not classify a bare invalid-call Error Message as not_found', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ 'Error Message': 'Invalid API call. Please retry or visit the documentation.' })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('av-key').fetchQuote('@@@');
    assert.equal(out.status, 'error');
  });

  it('maps an explicit invalid-symbol Error Message to not_found', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ 'Error Message': 'Invalid symbol supplied for GLOBAL_QUOTE.' })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('av-key').fetchQuote('@@@');
    assert.equal(out.status, 'not_found');
  });

  it('keeps HTTP credential failures as errors, not shared-quota backoff', async () => {
    globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('bad-key').fetchQuote('AAPL');
    assert.equal(out.status, 'error');
  });

  it('maps non-symbol Error Message to error (not negative-cached as missing)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ 'Error Message': 'the parameter apikey is invalid or missing' })) as typeof fetch;
    const out = await new AlphaVantageQuoteProvider('bad-key').fetchQuote('AAPL');
    assert.equal(out.status, 'error');
  });
});

describe('CascadeQuoteProvider', () => {
  it('falls through to Alpha Vantage after Finnhub rate_limited (fallback success)', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.includes('finnhub.io')) return new Response('', { status: 429 });
      if (url.includes('alphavantage.co')) {
        return jsonResponse({
          'Global Quote': {
            '01. symbol': 'RIVN',
            '05. price': '12.34',
            '10. change percent': '-1.2%',
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const cascade = new CascadeQuoteProvider([
      new FinnhubQuoteProvider('fh'),
      new AlphaVantageQuoteProvider('av'),
    ]);
    assert.equal(cascade.name, 'finnhub+alphavantage');
    const out = await cascade.fetchQuote('RIVN');
    assert.equal(out.status, 'ok');
    if (out.status === 'ok') {
      assert.equal(out.quote.price, 12.34);
      assert.equal(out.quote.change, -1.2);
    }
    assert.equal(calls, 2);
  });

  it('falls through after Finnhub not_found when AV has the symbol', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('finnhub.io')) {
        return jsonResponse({ c: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 });
      }
      return jsonResponse({
        'Global Quote': {
          '05. price': '50',
          '10. change percent': '2%',
        },
      });
    }) as typeof fetch;

    const out = await new CascadeQuoteProvider([
      new FinnhubQuoteProvider('fh'),
      new AlphaVantageQuoteProvider('av'),
    ]).fetchQuote('SOME');
    assert.equal(out.status, 'ok');
    if (out.status === 'ok') assert.equal(out.quote.price, 50);
  });

  it('returns rate_limited when every serviceable provider is rate-limited', async () => {
    globalThis.fetch = (async () => new Response('', { status: 429 })) as typeof fetch;
    const out = await new CascadeQuoteProvider([
      new FinnhubQuoteProvider('fh'),
      new AlphaVantageQuoteProvider('av'),
    ]).fetchQuote('AAPL');
    assert.equal(out.status, 'rate_limited');
  });

  it('declines futures without calling any provider', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('', { status: 500 });
    }) as typeof fetch;
    const cascade = new CascadeQuoteProvider([
      new FinnhubQuoteProvider('fh'),
      new AlphaVantageQuoteProvider('av'),
    ]);
    assert.equal(cascade.canQuote('CL=F'), false);
    const out = await cascade.fetchQuote('CL=F');
    assert.equal(out.status, 'error');
    assert.equal(calls, 0);
  });

  it('does not treat mixed not_found + rate_limited as definitive not_found', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('finnhub.io')) {
        return jsonResponse({ c: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 });
      }
      return new Response('', { status: 429 });
    }) as typeof fetch;

    const out = await new CascadeQuoteProvider([
      new FinnhubQuoteProvider('fh'),
      new AlphaVantageQuoteProvider('av'),
    ]).fetchQuote('RIVN');
    // Must not negative-cache: AV never confirmed the symbol is missing.
    assert.equal(out.status, 'rate_limited');
  });

  it('does not treat mixed not_found + error as definitive not_found', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('finnhub.io')) {
        return jsonResponse({ c: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 });
      }
      return new Response('', { status: 503 });
    }) as typeof fetch;

    const out = await new CascadeQuoteProvider([
      new FinnhubQuoteProvider('fh'),
      new AlphaVantageQuoteProvider('av'),
    ]).fetchQuote('RIVN');
    assert.equal(out.status, 'error');
  });

  it('returns not_found only when every provider agrees', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('finnhub.io')) {
        return jsonResponse({ c: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 });
      }
      return jsonResponse({ 'Global Quote': {} });
    }) as typeof fetch;

    const out = await new CascadeQuoteProvider([
      new FinnhubQuoteProvider('fh'),
      new AlphaVantageQuoteProvider('av'),
    ]).fetchQuote('NOSUCH');
    assert.equal(out.status, 'not_found');
  });
});

describe('resolveMarketQuoteProvider', () => {
  it('returns null when credentials are unavailable', () => {
    assert.equal(resolveMarketQuoteProvider({ finnhubKey: null, alphaVantageKey: null }), null);
    assert.match(providerNotConfiguredReason(), /FINNHUB_API_KEY/);
    assert.match(providerNotConfiguredReason(), /ALPHA_VANTAGE_API_KEY/);
  });

  it('returns Finnhub alone when only FINNHUB_API_KEY is set', () => {
    const p = resolveMarketQuoteProvider({ finnhubKey: 'fh', alphaVantageKey: null });
    assert.ok(p);
    assert.equal(p!.name, 'finnhub');
  });

  it('returns Alpha Vantage alone when only ALPHA_VANTAGE_API_KEY is set', () => {
    const p = resolveMarketQuoteProvider({ finnhubKey: null, alphaVantageKey: 'av' });
    assert.ok(p);
    assert.equal(p!.name, 'alphavantage');
  });

  it('returns a cascade when both keys are present', () => {
    const p = resolveMarketQuoteProvider({ finnhubKey: 'fh', alphaVantageKey: 'av' });
    assert.ok(p);
    assert.equal(p!.name, 'finnhub+alphavantage');
  });

  it('reads process.env when opts are omitted', () => {
    process.env.FINNHUB_API_KEY = 'env-fh';
    delete process.env.ALPHA_VANTAGE_API_KEY;
    const p = resolveMarketQuoteProvider();
    assert.ok(p);
    assert.equal(p!.name, 'finnhub');
  });
});
