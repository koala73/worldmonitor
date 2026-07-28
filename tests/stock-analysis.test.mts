import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  analyzeStock,
  buildAnalysisResponse,
  buildTechnicalSnapshot,
  fetchYahooAnalystData,
  getFallbackOverlay,
  selectEarningsForSymbol,
  type AnalystData,
} from '../server/worldmonitor/market/v1/analyze-stock.ts';
import { MarketServiceClient } from '../src/generated/client/worldmonitor/market/v1/service_client.ts';

const originalFetch = globalThis.fetch;

const mockChartPayload = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          regularMarketPrice: 132,
          previousClose: 131,
        },
        timestamp: Array.from({ length: 80 }, (_, index) => 1_700_000_000 + (index * 86_400)),
        indicators: {
          quote: [
            {
              open: Array.from({ length: 80 }, (_, index) => 100 + (index * 0.4)),
              high: Array.from({ length: 80 }, (_, index) => 101 + (index * 0.4)),
              low: Array.from({ length: 80 }, (_, index) => 99 + (index * 0.4)),
              close: Array.from({ length: 80 }, (_, index) => 100 + (index * 0.4)),
              volume: Array.from({ length: 80 }, (_, index) => 1_000_000 + (index * 5_000)),
            },
          ],
        },
      },
    ],
  },
};

const mockQuoteSummaryPayload = {
  quoteSummary: {
    result: [
      {
        recommendationTrend: {
          trend: [
            { period: '0m', strongBuy: 12, buy: 18, hold: 6, sell: 2, strongSell: 1 },
            { period: '-1m', strongBuy: 10, buy: 16, hold: 8, sell: 3, strongSell: 1 },
          ],
        },
        financialData: {
          financialCurrency: 'CNY',
          targetHighPrice: { raw: 250.0 },
          targetLowPrice: { raw: 160.0 },
          targetMeanPrice: { raw: 210.5 },
          targetMedianPrice: { raw: 215.0 },
          currentPrice: { raw: 132.0 },
          numberOfAnalystOpinions: { raw: 39 },
          profitMargins: { raw: 0.249 },
          grossMargins: { raw: 0.45 },
          operatingMargins: { raw: 0.31 },
          returnOnEquity: { raw: 0.4 },
          returnOnAssets: { raw: 0.15 },
          revenueGrowth: { raw: 0.12 },
          earningsGrowth: { raw: -0.03 },
          debtToEquity: { raw: 150 },
          totalCash: { raw: 100_000_000_000 },
          totalDebt: { raw: 50_000_000_000 },
          freeCashflow: { raw: -49_000_000 },
          ebitda: { raw: 20_000_000_000 },
        },
        upgradeDowngradeHistory: {
          history: [
            { firm: 'Morgan Stanley', toGrade: 'Overweight', fromGrade: 'Equal-Weight', action: 'up', epochGradeDate: 1710000000 },
            { firm: 'Goldman Sachs', toGrade: 'Buy', fromGrade: 'Neutral', action: 'up', epochGradeDate: 1709500000 },
            { firm: 'JP Morgan', toGrade: 'Neutral', fromGrade: 'Overweight', action: 'down', epochGradeDate: 1709000000 },
          ],
        },
      },
    ],
  },
};

const mockNewsXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss>
  <channel>
    <item>
      <title>Apple expands AI chip roadmap</title>
      <link>https://example.com/apple-ai</link>
      <pubDate>Sat, 08 Mar 2026 10:00:00 GMT</pubDate>
      <source>Reuters</source>
    </item>
    <item>
      <title>Apple services growth remains resilient</title>
      <link>https://example.com/apple-services</link>
      <pubDate>Sat, 08 Mar 2026 09:00:00 GMT</pubDate>
      <source>Bloomberg</source>
    </item>
  </channel>
</rss>`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OLLAMA_API_URL;
  delete process.env.OLLAMA_MODEL;
});

describe('analyzeStock handler', () => {
  it('builds a structured fallback report from Yahoo history and RSS headlines', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com/v8/finance/chart')) {
        return new Response(JSON.stringify(mockChartPayload), { status: 200 });
      }
      if (url.includes('query1.finance.yahoo.com/v10/finance/quoteSummary')) {
        return new Response(JSON.stringify(mockQuoteSummaryPayload), { status: 200 });
      }
      if (url.includes('news.google.com')) {
        return new Response(mockNewsXml, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const response = await analyzeStock({} as never, {
      symbol: 'AAPL',
      name: 'Apple',
      includeNews: true,
    });

    assert.equal(response.available, true);
    assert.equal(response.symbol, 'AAPL');
    assert.equal(response.name, 'Apple');
    assert.equal(response.currency, 'USD');
    assert.ok(response.signal.length > 0);
    assert.ok(response.signalScore > 0);
    assert.equal(response.provider, 'rules');
    assert.equal(response.fallback, true);
    assert.equal(response.newsSearched, true);
    assert.match(response.analysisId, /^stock:/);
    assert.ok(response.analysisAt > 0);
    assert.ok(response.stopLoss > 0);
    assert.ok(response.takeProfit > 0);
    assert.equal(response.headlines.length, 2);
    assert.match(response.summary, /apple/i);
    assert.ok(response.bullishFactors.length > 0);

    assert.ok(response.analystConsensus);
    assert.equal(response.analystConsensus.strongBuy, 12);
    assert.equal(response.analystConsensus.buy, 18);
    assert.equal(response.analystConsensus.hold, 6);
    assert.equal(response.analystConsensus.sell, 2);
    assert.equal(response.analystConsensus.strongSell, 1);
    assert.equal(response.analystConsensus.total, 39);

    assert.ok(response.priceTarget);
    assert.equal(response.priceTarget.high, 250);
    assert.equal(response.priceTarget.low, 160);
    assert.equal(response.priceTarget.mean, 210.5);
    assert.equal(response.priceTarget.median, 215);
    assert.equal(response.priceTarget.numberOfAnalysts, 39);

    assert.ok(response.fundamentals);
    assert.equal(response.fundamentals.profitMargin, 0.249);
    assert.equal(response.fundamentals.earningsGrowth, -0.03);
    assert.equal(response.fundamentals.debtToEquity, 1.5);
    assert.equal(response.fundamentals.freeCashflow, -49_000_000);
    assert.equal(response.fundamentals.financialCurrency, 'CNY');

    assert.ok(response.recentUpgrades);
    assert.equal(response.recentUpgrades.length, 3);
    assert.equal(response.recentUpgrades[0].firm, 'Morgan Stanley');
    assert.equal(response.recentUpgrades[0].action, 'up');
    assert.equal(response.recentUpgrades[0].toGrade, 'Overweight');
    assert.equal(response.recentUpgrades[0].fromGrade, 'Equal-Weight');
  });
});

describe('fetchYahooAnalystData', () => {
  it('extracts recommendation trend, price target, and upgrade history', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(mockQuoteSummaryPayload), { status: 200 });
    }) as typeof fetch;

    const data = await fetchYahooAnalystData('AAPL');

    assert.equal(data.analystConsensus.strongBuy, 12);
    assert.equal(data.analystConsensus.buy, 18);
    assert.equal(data.analystConsensus.hold, 6);
    assert.equal(data.analystConsensus.sell, 2);
    assert.equal(data.analystConsensus.strongSell, 1);
    assert.equal(data.analystConsensus.total, 39);
    assert.equal(data.analystConsensus.period, '0m');

    assert.equal(data.priceTarget.high, 250);
    assert.equal(data.priceTarget.low, 160);
    assert.equal(data.priceTarget.mean, 210.5);
    assert.equal(data.priceTarget.median, 215);
    assert.equal(data.priceTarget.current, 132);
    assert.equal(data.priceTarget.numberOfAnalysts, 39);

    assert.equal(data.fundamentals.profitMargin, 0.249);
    assert.equal(data.fundamentals.grossMargin, 0.45);
    assert.equal(data.fundamentals.operatingMargin, 0.31);
    assert.equal(data.fundamentals.returnOnEquity, 0.4);
    assert.equal(data.fundamentals.returnOnAssets, 0.15);
    assert.equal(data.fundamentals.revenueGrowth, 0.12);
    assert.equal(data.fundamentals.earningsGrowth, -0.03);
    assert.equal(data.fundamentals.debtToEquity, 1.5);
    assert.equal(data.fundamentals.totalCash, 100_000_000_000);
    assert.equal(data.fundamentals.totalDebt, 50_000_000_000);
    assert.equal(data.fundamentals.freeCashflow, -49_000_000);
    assert.equal(data.fundamentals.ebitda, 20_000_000_000);
    assert.equal(data.fundamentals.financialCurrency, 'CNY');

    assert.equal(data.recentUpgrades.length, 3);
    assert.equal(data.recentUpgrades[0].firm, 'Morgan Stanley');
    assert.equal(data.recentUpgrades[0].action, 'up');
    assert.equal(data.recentUpgrades[1].firm, 'Goldman Sachs');
    assert.equal(data.recentUpgrades[2].firm, 'JP Morgan');
    assert.equal(data.recentUpgrades[2].action, 'down');
  });

  it('returns empty data on HTTP error', async () => {
    globalThis.fetch = (async () => {
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const data = await fetchYahooAnalystData('INVALID');
    assert.equal(data.analystConsensus.total, 0);
    assert.equal(data.priceTarget.numberOfAnalysts, 0);
    assert.equal(data.recentUpgrades.length, 0);
  });

  it('returns empty data on network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network error');
    }) as typeof fetch;

    const data = await fetchYahooAnalystData('AAPL');
    assert.equal(data.analystConsensus.total, 0);
    assert.equal(data.priceTarget.numberOfAnalysts, 0);
    assert.equal(data.recentUpgrades.length, 0);
  });

  it('handles missing modules gracefully', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        quoteSummary: { result: [{}] },
      }), { status: 200 });
    }) as typeof fetch;

    const data = await fetchYahooAnalystData('AAPL');
    assert.equal(data.analystConsensus.total, 0);
    assert.equal(data.priceTarget.numberOfAnalysts, 0);
    assert.equal(data.recentUpgrades.length, 0);
  });

  it('uses typeof guards for upstream numeric fields and omits invalid targets', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        quoteSummary: {
          result: [{
            recommendationTrend: {
              trend: [{ period: '0m', strongBuy: 'five', buy: null, hold: 3, sell: undefined, strongSell: 0 }],
            },
            financialData: {
              financialCurrency: 'not-a-currency',
              targetHighPrice: { raw: 'not a number' },
              targetLowPrice: {},
              numberOfAnalystOpinions: { raw: 10 },
              profitMargins: { raw: 'not a number' },
              debtToEquity: { raw: Number.NaN },
            },
          }],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const data = await fetchYahooAnalystData('AAPL');
    assert.equal(data.analystConsensus.strongBuy, 0);
    assert.equal(data.analystConsensus.buy, 0);
    assert.equal(data.analystConsensus.hold, 3);
    assert.equal(data.analystConsensus.sell, 0);
    assert.equal(data.analystConsensus.strongSell, 0);
    assert.equal(data.analystConsensus.total, 3);
    assert.equal(data.priceTarget.high, undefined);
    assert.equal(data.priceTarget.low, undefined);
    assert.equal(data.priceTarget.mean, undefined);
    assert.equal(data.priceTarget.median, undefined);
    assert.equal(data.priceTarget.current, undefined);
    assert.equal(data.priceTarget.numberOfAnalysts, 10);
    assert.equal(data.fundamentals.profitMargin, undefined);
    assert.equal(data.fundamentals.debtToEquity, undefined);
    assert.equal(data.fundamentals.financialCurrency, undefined);
  });

  it('returns undefined price target fields when financialData is entirely absent', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        quoteSummary: {
          result: [{
            recommendationTrend: {
              trend: [{ period: '0m', strongBuy: 5, buy: 3, hold: 2, sell: 0, strongSell: 0 }],
            },
          }],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const data = await fetchYahooAnalystData('AAPL');
    assert.equal(data.analystConsensus.total, 10);
    assert.equal(data.priceTarget.high, undefined);
    assert.equal(data.priceTarget.low, undefined);
    assert.equal(data.priceTarget.mean, undefined);
    assert.equal(data.priceTarget.median, undefined);
    assert.equal(data.priceTarget.numberOfAnalysts, 0);
    assert.deepEqual(data.fundamentals, {});
  });

  it('sends normalized, currency-labelled fundamentals to the analysis LLM', async () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    let llmRequestBody: {
      messages?: Array<{ role?: string; content?: string }>;
    } | undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com/v8/finance/chart')) {
        return new Response(JSON.stringify(mockChartPayload), { status: 200 });
      }
      if (url.includes('query1.finance.yahoo.com/v10/finance/quoteSummary')) {
        return new Response(JSON.stringify(mockQuoteSummaryPayload), { status: 200 });
      }
      if (url.includes('news.google.com')) {
        return new Response(mockNewsXml, { status: 200 });
      }
      if (url === 'https://openrouter.ai' || url === 'https://openrouter.ai/') {
        return new Response('ok', { status: 200 });
      }
      if (url === 'https://openrouter.ai/api/v1/chat/completions') {
        llmRequestBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as typeof llmRequestBody;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: 'Fundamentals included.',
                action: 'Hold',
                confidence: 'Medium',
                whyNow: 'Valuation and growth are mixed.',
                technicalSummary: 'Trend is constructive.',
                newsSummary: 'Coverage is stable.',
                bullishFactors: ['Profitable'],
                riskFactors: ['Leverage'],
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const response = await analyzeStock({} as never, {
      symbol: 'BABA',
      name: 'Alibaba',
      includeNews: true,
    });

    assert.equal(response.provider, 'openrouter');
    assert.equal(response.fundamentals?.debtToEquity, 1.5);
    assert.equal(response.fundamentals?.financialCurrency, 'CNY');

    const systemPrompt = llmRequestBody?.messages?.find((message) => message.role === 'system')?.content || '';
    assert.match(systemPrompt, /debtToEquity 1\.5 means debt is 1\.5x equity/);
    assert.match(systemPrompt, /fundamentals\.financialCurrency/);

    const userMessage = llmRequestBody?.messages?.find((message) => message.role === 'user')?.content || '{}';
    const userPayload = JSON.parse(userMessage) as {
      fundamentals?: { debtToEquity?: number; financialCurrency?: string; freeCashflow?: number };
    };
    assert.equal(userPayload.fundamentals?.debtToEquity, 1.5);
    assert.equal(userPayload.fundamentals?.financialCurrency, 'CNY');
    assert.equal(userPayload.fundamentals?.freeCashflow, -49_000_000);
  });
});

describe('MarketServiceClient analyzeStock', () => {
  it('serializes the analyze-stock query parameters using generated names', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ available: false }), { status: 200 });
    }) as typeof fetch;

    const client = new MarketServiceClient('');
    await client.analyzeStock({ symbol: 'MSFT', name: 'Microsoft', includeNews: true });

    assert.match(requestedUrl, /\/api\/market\/v1\/analyze-stock\?/);
    assert.match(requestedUrl, /symbol=MSFT/);
    assert.match(requestedUrl, /name=Microsoft/);
    assert.match(requestedUrl, /include_news=true/);
  });
});

describe('selectEarningsForSymbol', () => {
  const TODAY = '2026-07-26';
  const entry = (over: Record<string, unknown> = {}) => ({
    symbol: 'AAPL', company: 'Apple', date: '2026-07-30', hour: 'amc',
    epsEstimate: 1.25, revenueEstimate: 90_000_000_000, epsActual: 0, revenueActual: 0,
    hasActuals: false, surpriseDirection: '', ...over,
  });

  it('returns the next upcoming entry with consensus estimates', () => {
    const result = selectEarningsForSymbol([entry()], 'AAPL', TODAY);
    assert.deepEqual(result, { nextEarningsDate: '2026-07-30', consensusEps: 1.25, consensusRevenue: 90_000_000_000 });
  });

  it('returns null when the only entry has already reported (hasActuals)', () => {
    assert.equal(selectEarningsForSymbol([entry({ hasActuals: true })], 'AAPL', TODAY), null);
  });

  it('returns null when the only entry is dated before today', () => {
    assert.equal(selectEarningsForSymbol([entry({ date: '2026-07-20' })], 'AAPL', TODAY), null);
  });

  it('returns null when no entry matches the symbol', () => {
    assert.equal(selectEarningsForSymbol([entry()], 'MSFT', TODAY), null);
  });

  it('picks the earliest upcoming entry, skipping reported and past ones', () => {
    const result = selectEarningsForSymbol([
      entry({ date: '2026-08-15' }),
      entry({ date: '2026-07-20', hasActuals: true }), // past, already reported
      entry({ date: '2026-07-28' }),                    // earliest still-upcoming
    ], 'AAPL', TODAY);
    assert.equal(result?.nextEarningsDate, '2026-07-28');
  });

  it('surfaces the date but omits absent/zero estimates', () => {
    const result = selectEarningsForSymbol([entry({ epsEstimate: 0, revenueEstimate: 0 })], 'AAPL', TODAY);
    assert.deepEqual(result, { nextEarningsDate: '2026-07-30' });
  });

  it('treats an entry dated exactly today as upcoming', () => {
    const result = selectEarningsForSymbol([entry({ date: TODAY })], 'AAPL', TODAY);
    assert.equal(result?.nextEarningsDate, TODAY);
  });
});

describe('buildAnalysisResponse earnings surfacing', () => {
  const candles = Array.from({ length: 80 }, (_, i) => ({
    timestamp: 1_700_000_000_000 + i * 86_400_000,
    open: 100 + i * 0.4, high: 101 + i * 0.4, low: 99 + i * 0.4,
    close: 100 + i * 0.4, volume: 1_000_000 + i * 5_000,
  }));
  const technical = buildTechnicalSnapshot(candles);
  const overlay = getFallbackOverlay('Test', technical, []);
  const emptyAnalystData: AnalystData = {
    analystConsensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0, period: '' },
    priceTarget: { numberOfAnalysts: 0 },
    recentUpgrades: [],
    fundamentals: {},
  };
  const base = {
    symbol: 'AAPL', name: 'Apple', currency: 'USD', technical, headlines: [],
    overlay, analystData: emptyAnalystData, includeNews: false,
    analysisAt: Date.now(), generatedAt: new Date().toISOString(),
  };

  it('surfaces the earnings fields when an upcoming event is provided', () => {
    const resp = buildAnalysisResponse({ ...base, earnings: { nextEarningsDate: '2026-07-30', consensusEps: 1.25, consensusRevenue: 9e10 } });
    assert.equal(resp.nextEarningsDate, '2026-07-30');
    assert.equal(resp.consensusEps, 1.25);
    assert.equal(resp.consensusRevenue, 9e10);
  });

  it('omits all earnings keys when there is no upcoming event', () => {
    const resp = buildAnalysisResponse({ ...base });
    assert.ok(!('nextEarningsDate' in resp));
    assert.ok(!('consensusEps' in resp));
    assert.ok(!('consensusRevenue' in resp));
  });

  it('omits the consensus keys when only the date is known', () => {
    const resp = buildAnalysisResponse({ ...base, earnings: { nextEarningsDate: '2026-07-30' } });
    assert.equal(resp.nextEarningsDate, '2026-07-30');
    assert.ok(!('consensusEps' in resp));
    assert.ok(!('consensusRevenue' in resp));
  });
});
