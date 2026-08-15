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
  alignStockHeadlines,
  alignUsEquityNewsTimestamp,
  buildAnalysisResponse,
  buildTechnicalSnapshot,
  getFallbackOverlay,
  fetchExtendedHoursQuote,
  nextUsEquityTradingDate,
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

function yahooHistoryPayload() {
  const timestamps = Array.from({ length: 80 }, (_, i) => 1_700_000_000 + i * 86_400);
  const closes = timestamps.map((_, i) => 100 + i * 0.4);
  return {
    chart: {
      result: [
        {
          meta: { currency: 'USD' },
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                open: closes.map((close) => close - 0.2),
                high: closes.map((close) => close + 1),
                low: closes.map((close) => close - 1),
                close: closes,
                volume: closes.map(() => 1_000_000),
              },
            ],
          },
        },
      ],
    },
  };
}

function installAnalyzeStockFetchMock(handleUrl?: (url: string) => Response | undefined) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const handled = handleUrl?.(url);
    if (handled) return handled;
    if (url.includes('range=6mo&interval=1d')) {
      return new Response(JSON.stringify(yahooHistoryPayload()), { status: 200 });
    }
    if (url.includes('modules=recommendationTrend,financialData,upgradeDowngradeHistory')) {
      return new Response(JSON.stringify({ quoteSummary: { result: [{}] } }), { status: 200 });
    }
    if (url.includes('range=5y&interval=1mo')) {
      return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: 'USD' }, events: { dividends: {} } }] } }), { status: 200 });
    }
    if (url.includes('modules=summaryDetail')) {
      return new Response(JSON.stringify({ quoteSummary: { result: [{ summaryDetail: {} }] } }), { status: 200 });
    }
    if (url.includes('range=1d&interval=5m')) {
      return new Response(JSON.stringify(extendedChartPayload({
        regularStart: 100_000,
        regularEnd: 123_400,
        timestamps: [95_000, 96_000, 100_000],
        closes: [9, 9.45, 10],
        regularMarketPrice: 9,
      })), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
  return urls;
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

  it('success path uses the injected analysis clock to fetch and attach pre-market extended fields', async () => {
    const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const previousLlmApiUrl = process.env.LLM_API_URL;
    const previousLlmApiKey = process.env.LLM_API_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;
    try {
      const urls = installAnalyzeStockFetchMock();
      const response = await analyzeStock(
        {} as never,
        { symbol: 'AAPL', name: 'Apple', includeNews: false },
        { now: new Date('2026-07-08T11:00:00Z') },
      );

      assert.equal(response.available, true);
      assert.equal(response.marketSession, 'pre');
      assert.equal(response.extendedPrice, 9.45);
      assert.equal(response.extendedChangePercent, 5);
      assert.ok(
        urls.some((url) => url.includes('range=1d&interval=5m&includePrePost=true')),
        'pre-market analysis must request the extended-hours Yahoo chart',
      );
    } finally {
      if (previousRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
      if (previousRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
      if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
      if (previousLlmApiUrl === undefined) delete process.env.LLM_API_URL;
      else process.env.LLM_API_URL = previousLlmApiUrl;
      if (previousLlmApiKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previousLlmApiKey;
    }
  });

  it('bypasses a warm shared cache when the analysis clock is injected', async () => {
    const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const previousLlmApiUrl = process.env.LLM_API_URL;
    const previousLlmApiKey = process.env.LLM_API_KEY;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;
    try {
      const staleCachedResponse = buildAnalysisResponse({ ...baseParams, marketSession: 'regular' });
      const urls = installAnalyzeStockFetchMock((url) => {
        if (url.startsWith('https://redis.example') && url.includes('market%3Aanalyze-stock')) {
          return new Response(JSON.stringify({ result: JSON.stringify(staleCachedResponse) }), { status: 200 });
        }
        if (url.startsWith('https://redis.example')) {
          return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
        }
        return undefined;
      });

      const response = await analyzeStock(
        {} as never,
        { symbol: 'AAPL', name: 'Apple', includeNews: false },
        { now: new Date('2026-07-08T11:00:00Z') },
      );

      assert.equal(response.available, true);
      assert.equal(response.marketSession, 'pre');
      assert.equal(response.extendedPrice, 9.45);
      assert.equal(response.extendedChangePercent, 5);
      assert.equal(
        urls.some((url) => url.startsWith('https://redis.example') && url.includes('market%3Aanalyze-stock')),
        false,
        'injected analysis clocks must not read session-agnostic analyze-stock cache entries',
      );
    } finally {
      if (previousRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
      if (previousRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
      if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
      if (previousLlmApiUrl === undefined) delete process.env.LLM_API_URL;
      else process.env.LLM_API_URL = previousLlmApiUrl;
      if (previousLlmApiKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previousLlmApiKey;
    }
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

describe('headline session alignment', () => {
  it('aligns a regular-session publish to the same trading date', () => {
    const alignment = alignUsEquityNewsTimestamp(Date.parse('2026-08-14T16:00:00.000Z'));
    assert.ok(alignment);
    assert.equal(alignment.marketSessionAtPublish, 'regular');
    assert.equal(alignment.alignedTradingDate, '2026-08-14');
    assert.equal(alignment.alignmentRule, 'HEADLINE_ALIGNMENT_RULE_REGULAR_SESSION_SAME_TRADING_DAY');
  });

  it('aligns after-hours and weekends to the next trading date', () => {
    const afterHours = alignUsEquityNewsTimestamp(Date.parse('2026-08-14T21:00:00.000Z'));
    assert.ok(afterHours);
    assert.equal(afterHours.marketSessionAtPublish, 'post');
    assert.equal(afterHours.alignedTradingDate, '2026-08-17');
    assert.equal(afterHours.alignmentRule, 'HEADLINE_ALIGNMENT_RULE_AFTER_HOURS_NEXT_TRADING_DAY');

    const weekend = alignUsEquityNewsTimestamp(Date.parse('2026-08-15T18:00:00.000Z'));
    assert.ok(weekend);
    assert.equal(weekend.marketSessionAtPublish, 'closed');
    // Pinned to a literal, not to nextUsEquityTradingDate(...): comparing the
    // result against the same function the production path already called is
    // f(x) === f(x) and passes for any output. Aug 15 2026 is a Saturday, so
    // the next NYSE regular session is Monday Aug 17.
    assert.equal(weekend.alignedTradingDate, '2026-08-17');
    assert.equal(weekend.alignmentRule, 'HEADLINE_ALIGNMENT_RULE_NON_SESSION_NEXT_TRADING_DAY');
  });

  it('aligns an overnight publish to the trading day that follows it hours later', () => {
    // getUsEquitySessionAt returns 'closed' for BOTH 20:00-24:00 ET and
    // 00:00-04:00 ET. Only the first should roll to the next trading day: a
    // headline published at 02:00 ET precedes that same day's 04:00 pre-market.
    const overnight = alignUsEquityNewsTimestamp(Date.parse('2026-08-18T06:00:00.000Z'));
    assert.ok(overnight);
    assert.equal(overnight.marketSessionAtPublish, 'closed');
    assert.equal(overnight.alignedTradingDate, '2026-08-18');
    assert.equal(overnight.alignmentRule, 'HEADLINE_ALIGNMENT_RULE_OVERNIGHT_SAME_TRADING_DAY');
  });

  it('does not jump three days across the 04:00 ET pre-market boundary', () => {
    // 03:59 ET and 04:00 ET on the same trading day must resolve to the same
    // trading date; before the fix they differed by a full session.
    const justBefore = alignUsEquityNewsTimestamp(Date.parse('2026-08-18T07:59:00.000Z'));
    const justAfter = alignUsEquityNewsTimestamp(Date.parse('2026-08-18T08:00:00.000Z'));
    assert.ok(justBefore);
    assert.ok(justAfter);
    assert.equal(justAfter.marketSessionAtPublish, 'pre');
    assert.equal(justBefore.alignedTradingDate, justAfter.alignedTradingDate);
    assert.equal(justBefore.alignedTradingDate, '2026-08-18');
  });

  it('still rolls an overnight publish on a non-trading day to the next session', () => {
    // 02:00 ET on a Saturday is overnight AND not a trading date, so the
    // same-day shortcut must not fire.
    const weekendOvernight = alignUsEquityNewsTimestamp(Date.parse('2026-08-15T06:00:00.000Z'));
    assert.ok(weekendOvernight);
    assert.equal(weekendOvernight.alignedTradingDate, '2026-08-17');
    assert.equal(weekendOvernight.alignmentRule, 'HEADLINE_ALIGNMENT_RULE_NON_SESSION_NEXT_TRADING_DAY');
  });

  it('rolls a post-close publish to the next trading day', () => {
    // The other half of the overloaded 'closed' state must keep rolling.
    const lateEvening = alignUsEquityNewsTimestamp(Date.parse('2026-08-19T01:00:00.000Z'));
    assert.ok(lateEvening);
    assert.equal(lateEvening.marketSessionAtPublish, 'closed');
    assert.equal(lateEvening.alignedTradingDate, '2026-08-19');
    assert.equal(lateEvening.alignmentRule, 'HEADLINE_ALIGNMENT_RULE_NON_SESSION_NEXT_TRADING_DAY');
  });

  it('aligns a pre-market publish to the same trading day', () => {
    const premarket = alignUsEquityNewsTimestamp(Date.parse('2026-08-18T12:00:00.000Z'));
    assert.ok(premarket);
    assert.equal(premarket.marketSessionAtPublish, 'pre');
    assert.equal(premarket.alignedTradingDate, '2026-08-18');
    assert.equal(premarket.alignmentRule, 'HEADLINE_ALIGNMENT_RULE_PREMARKET_SAME_TRADING_DAY');
  });

  it('omits alignment for invalid timestamps and leaves non-US headlines untouched', () => {
    assert.equal(alignUsEquityNewsTimestamp(0), null);
    assert.equal(alignUsEquityNewsTimestamp(Number.NaN), null);
    const raw = [{ title: 'X', source: 'Y', link: 'https://example.com', publishedAt: Date.parse('2026-08-14T16:00:00.000Z') }];
    assert.deepEqual(alignStockHeadlines(raw, false), [{
      ...raw[0],
      marketSessionAtPublish: '',
      alignedTradingDate: '',
      alignmentRule: 'HEADLINE_ALIGNMENT_RULE_UNSPECIFIED',
    }]);
    const aligned = alignStockHeadlines(raw, true);
    assert.equal(aligned[0]?.alignedTradingDate, '2026-08-14');
  });
});
