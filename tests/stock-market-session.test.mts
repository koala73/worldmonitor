// #4922d: marketSession / extendedPrice / extendedChangePercent on
// AnalyzeStockResponse, and the pre/post extended-hours fetch.
// Session-boundary correctness itself is covered (with the .cjs twin
// cross-check) in tests/market-hours.test.mjs.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeStock,
  buildAnalysisResponse,
  buildTechnicalSnapshot,
  getFallbackOverlay,
  fetchExtendedHoursQuote,
  usEquityHoursApply,
  type Candle,
  type AnalystData,
} from '../server/worldmonitor/market/v1/analyze-stock.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const analyzeStockSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../server/worldmonitor/market/v1/analyze-stock.ts'),
  'utf-8',
);

function extendedChartPayload(overrides: {
  regularStart: number;
  regularEnd: number;
  timestamps: number[];
  closes: Array<number | null>;
  regularMarketPrice?: number;
  preStart?: number;
  preEnd?: number;
  postStart?: number;
  postEnd?: number;
}) {
  // Yahoo reports the CURRENT session's own bounds; pre ends at the regular
  // open and post begins at the regular close by default.
  const preStart = overrides.preStart ?? overrides.regularStart - 20_000;
  const preEnd = overrides.preEnd ?? overrides.regularStart;
  const postStart = overrides.postStart ?? overrides.regularEnd;
  const postEnd = overrides.postEnd ?? overrides.regularEnd + 20_000;
  return {
    chart: {
      result: [
        {
          meta: {
            currency: 'USD',
            regularMarketPrice: overrides.regularMarketPrice,
            currentTradingPeriod: {
              pre: { start: preStart, end: preEnd },
              regular: { start: overrides.regularStart, end: overrides.regularEnd },
              post: { start: postStart, end: postEnd },
            },
          },
          timestamp: overrides.timestamps,
          indicators: { quote: [{ close: overrides.closes }] },
        },
      ],
    },
  };
}

function mockFetchJson(payload: unknown, capture?: { url?: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (capture) capture.url = url;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

describe('usEquityHoursApply (#4922d)', () => {
  it('applies to US listings (USD, no exchange suffix) including indices and ADRs', () => {
    assert.equal(usEquityHoursApply('AAPL', 'USD'), true);
    assert.equal(usEquityHoursApply('^GSPC', 'USD'), true);
    assert.equal(usEquityHoursApply('TSM', 'USD'), true);
  });

  it('does not apply to non-US listings', () => {
    assert.equal(usEquityHoursApply('RELIANCE.NS', 'INR'), false, 'non-USD currency');
    assert.equal(usEquityHoursApply('RELIANCE.NS', 'USD'), false, 'exchange suffix wins even with USD');
    assert.equal(usEquityHoursApply('^NSEI', 'INR'), false);
  });
});

describe('fetchExtendedHoursQuote (#4922d)', () => {
  it('post: picks the latest finite close after the regular close, change vs last regular close', async () => {
    const capture: { url?: string } = {};
    mockFetchJson(extendedChartPayload({
      regularStart: 100_000,
      regularEnd: 123_400,
      timestamps: [100_000, 110_000, 123_100, 123_700, 124_000],
      closes: [10, 11, 12.5, 12.8, 13],
      regularMarketPrice: 12.5,
    }), capture);

    const quote = await fetchExtendedHoursQuote('AAPL', 'post');
    assert.ok(quote);
    assert.equal(quote.price, 13);
    assert.equal(quote.changePercent, 4, '(13 - 12.5) / 12.5 = +4%');
    assert.match(capture.url!, /range=1d&interval=5m&includePrePost=true/);
  });

  it('pre: picks the latest finite close before the regular open', async () => {
    mockFetchJson(extendedChartPayload({
      regularStart: 100_000,
      regularEnd: 123_400,
      timestamps: [95_000, 96_000, 100_000],
      closes: [9, 9.45, 10],
      regularMarketPrice: 9,
    }));

    const quote = await fetchExtendedHoursQuote('AAPL', 'pre');
    assert.ok(quote);
    assert.equal(quote.price, 9.45, 'the 100_000 candle is regular, not pre');
    assert.equal(quote.changePercent, 5);
  });

  it('pre: does NOT return a prior-session candle before the pre window opens', async () => {
    // Early pre-market before today's pre candles publish: range=1d still
    // carries the prior session's candles (all older than today's pre window).
    // The old `ts < regularStart` gate would have returned that stale candle as
    // today's pre-market price; the bounded window must reject it and return null.
    mockFetchJson(extendedChartPayload({
      regularStart: 100_000,
      regularEnd: 123_400,
      // pre window is [80_000, 100_000); this candle sits before it.
      timestamps: [50_000],
      closes: [8],
      regularMarketPrice: 9,
    }));
    assert.equal(
      await fetchExtendedHoursQuote('AAPL', 'pre'),
      null,
      'a candle before the pre window must not be returned',
    );
  });

  it('returns null when there are no extended candles or no trading-period meta', async () => {
    mockFetchJson(extendedChartPayload({
      regularStart: 100_000,
      regularEnd: 123_400,
      timestamps: [100_000, 110_000],
      closes: [10, 11],
      regularMarketPrice: 11,
    }));
    assert.equal(await fetchExtendedHoursQuote('AAPL', 'post'), null, 'regular candles only');

    mockFetchJson({ chart: { result: [{ meta: { currency: 'USD' } }] } });
    assert.equal(await fetchExtendedHoursQuote('AAPL', 'post'), null, 'missing currentTradingPeriod');

    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    assert.equal(await fetchExtendedHoursQuote('AAPL', 'post'), null, 'fetch failure is non-fatal');
  });
});

describe('AnalyzeStockResponse marketSession / extended fields (#4922d)', () => {
  const candles: Candle[] = Array.from({ length: 80 }, (_, i) => ({
    timestamp: (1_700_000_000 + i * 86_400) * 1000,
    open: 100 + i * 0.4,
    high: 101 + i * 0.4,
    low: 99 + i * 0.4,
    close: 100 + i * 0.4,
    volume: 1_000_000,
  }));
  const technical = buildTechnicalSnapshot(candles);
  const overlay = getFallbackOverlay('Apple', technical, []);
  const analystData: AnalystData = {
    analystConsensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0, period: '' },
    priceTarget: { numberOfAnalysts: 0 },
    recentUpgrades: [],
  };
  const baseParams = {
    symbol: 'AAPL',
    name: 'Apple',
    currency: 'USD',
    technical,
    headlines: [],
    overlay,
    analystData,
    includeNews: false,
    analysisAt: 1_700_000_000_000,
    generatedAt: new Date(1_700_000_000_000).toISOString(),
  };

  it('post session with an extended quote populates both extended fields', () => {
    const response = buildAnalysisResponse({
      ...baseParams,
      marketSession: 'post',
      extended: { price: 133.5, changePercent: 1.14 },
    });
    assert.equal(response.marketSession, 'post');
    assert.equal(response.extendedPrice, 133.5);
    assert.equal(response.extendedChangePercent, 1.14);
  });

  it('regular session omits the extended keys entirely (not null, not 0)', () => {
    const response = buildAnalysisResponse({ ...baseParams, marketSession: 'regular' });
    assert.equal(response.marketSession, 'regular');
    assert.equal('extendedPrice' in response, false);
    assert.equal('extendedChangePercent' in response, false);
  });

  it('defaults marketSession to the documented not-applicable empty string', () => {
    const response = buildAnalysisResponse({ ...baseParams });
    assert.equal(response.marketSession, '');
  });

  it('error/fallback responses carry the required marketSession field', async () => {
    // Yahoo upstream down → fetchYahooHistory null → buildEmptyAnalysisResponse
    globalThis.fetch = (async () => new Response('upstream down', { status: 503 })) as typeof fetch;
    const failed = await analyzeStock({} as never, { symbol: 'AAPL', name: 'Apple', includeNews: false });
    assert.equal(failed.available, false);
    assert.equal(failed.marketSession, '');

    const invalid = await analyzeStock({} as never, { symbol: '', name: '', includeNews: false });
    assert.equal(invalid.available, false);
    assert.equal(invalid.marketSession, '');
  });
});

describe('source contracts (#4922d)', () => {
  it('both Yahoo chart pins are includePrePost=true', () => {
    const pins = analyzeStockSrc.match(/includePrePost=(true|false)/g) ?? [];
    assert.ok(pins.length >= 3, 'history + dividend + extended-hours fetches');
    assert.ok(pins.every((p) => p === 'includePrePost=true'), `found ${pins.join(', ')}`);
  });

  it('the extended-hours fetch only runs in pre/post sessions', () => {
    assert.match(
      analyzeStockSrc,
      /marketSession === 'pre' \|\| marketSession === 'post'\)\s*\? fetchExtendedHoursQuote\(/,
    );
  });
});
