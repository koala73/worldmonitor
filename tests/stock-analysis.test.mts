import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  analyzeStock,
  buildAnalysisResponse,
  buildTechnicalSnapshot,
  computeAtr,
  computeCompositeScore,
  computeFundamentalScore,
  computeMaxDrawdown,
  computeRealizedVolatility,
  deriveSignal,
  fetchYahooAnalystData,
  fetchYahooHistory,
  getFallbackOverlay,
  normalizeNewsSentiment,
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
  delete process.env.LLM_API_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
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
    assert.ok(response.ratingSignal.length > 0);
    assert.ok(response.ratingSummary.length > 0);
    assert.ok(response.ratingAction.length > 0);
    assert.ok(response.ratingConfidence.length > 0);
    assert.ok(response.ratingWhyNow.length > 0);
    assert.ok(response.ratingBullishFactors.length > 0);
    assert.ok(response.ratingRiskFactors.length > 0);
    assert.ok(response.signalScore > 0);
    assert.equal(response.engineVersion, 'v3-composite');
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
                technical: {
                  summary: 'Technical trend remains constructive.',
                  action: 'Technical buy.',
                  confidence: 'High',
                  whyNow: 'Momentum remains positive.',
                  technicalSummary: 'Trend is constructive.',
                  newsSummary: 'Coverage is stable.',
                  bullishFactors: ['Momentum'],
                  riskFactors: ['Volatility'],
                },
                rating: {
                  summary: 'Fundamentals temper the composite rating.',
                  action: 'Composite hold.',
                  confidence: 'Medium',
                  whyNow: 'Valuation and growth are mixed.',
                  technicalSummary: 'Trend is constructive.',
                  newsSummary: 'Coverage is stable.',
                  bullishFactors: ['Profitable'],
                  riskFactors: ['Leverage'],
                },
                newsSentiment: 0.42,
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

    assert.equal(response.newsSentiment, 0.42);
    assert.equal(response.summary, 'Technical trend remains constructive.');
    assert.equal(response.action, 'Technical buy.');
    assert.equal(response.confidence, 'High');
    assert.equal(response.ratingSummary, 'Fundamentals temper the composite rating.');
    assert.equal(response.ratingAction, 'Composite hold.');
    assert.equal(response.ratingConfidence, 'Medium');
    assert.equal(response.ratingWhyNow, 'Valuation and growth are mixed.');
    assert.deepEqual(response.ratingBullishFactors, ['Profitable']);
    assert.deepEqual(response.ratingRiskFactors, ['Leverage']);

    const systemPrompt = llmRequestBody?.messages?.find((message) => message.role === 'system')?.content || '';
    assert.match(systemPrompt, /debtToEquity 1\.5 means debt is 1\.5x equity/);
    assert.match(systemPrompt, /fundamentals\.financialCurrency/);
    assert.match(systemPrompt, /newsSentiment/);
    assert.match(systemPrompt, /not a cause of any price move/);

    const userMessage = llmRequestBody?.messages?.find((message) => message.role === 'user')?.content || '{}';
    const userPayload = JSON.parse(userMessage) as {
      fundamentals?: { debtToEquity?: number; financialCurrency?: string; freeCashflow?: number };
      rating?: { signal?: string; compositeScore?: number; fundamentalScore?: number };
      technical?: { signal?: string; signalScore?: number };
    };
    assert.equal(userPayload.fundamentals?.debtToEquity, 1.5);
    assert.equal(userPayload.fundamentals?.financialCurrency, 'CNY');
    assert.equal(userPayload.fundamentals?.freeCashflow, -49_000_000);
    assert.equal(userPayload.rating?.signal, response.ratingSignal);
    assert.equal(userPayload.rating?.compositeScore, response.compositeScore);
    assert.equal(userPayload.rating?.fundamentalScore, response.fundamentalScore);
    assert.equal(userPayload.technical?.signal, response.signal);
    assert.equal(userPayload.technical?.signalScore, response.signalScore);
  });

  it('falls through to the next provider when headline sentiment is missing', async () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_API_URL = 'https://generic.example/v1/chat/completions';
    process.env.LLM_API_KEY = 'test-generic-key';
    const llmPostUrls: string[] = [];

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
      if ((init?.method || 'GET') === 'GET') {
        return new Response('ok', { status: 200 });
      }
      llmPostUrls.push(url);
      const newsSentiment = url.includes('openrouter.ai') ? undefined : -0.35;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              technical: {
                summary: 'Technical provider response.',
                action: 'Technical hold.',
              },
              rating: {
                summary: 'Composite provider response.',
                action: 'Composite hold.',
              },
              newsSentiment,
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { total_tokens: 20, prompt_tokens: 15, completion_tokens: 5 },
      }), { status: 200 });
    }) as typeof fetch;

    const response = await analyzeStock({} as never, {
      symbol: 'BABA',
      name: 'Alibaba',
      includeNews: true,
    });

    assert.equal(response.provider, 'generic');
    assert.equal(response.newsSentiment, -0.35);
    assert.deepEqual(llmPostUrls, [
      'https://openrouter.ai/api/v1/chat/completions',
      'https://generic.example/v1/chat/completions',
    ]);
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

  const headline = { title: 'Earnings beat', source: 'Reuters', publishedAt: '2026-07-25T00:00:00Z' };

  it('surfaces a provided overlay news sentiment when headlines were analyzed', () => {
    const resp = buildAnalysisResponse({ ...base, headlines: [headline], overlay: { ...overlay, newsSentiment: -0.3 } });
    assert.equal(resp.newsSentiment, -0.3);
  });

  it('omits newsSentiment when no headlines were analyzed (avoids a synthetic neutral)', () => {
    const resp = buildAnalysisResponse({ ...base, headlines: [], overlay: { ...overlay, newsSentiment: 0 } });
    assert.ok(!('newsSentiment' in resp));
  });

  it('omits newsSentiment when the overlay carries none (rules fallback)', () => {
    const resp = buildAnalysisResponse({ ...base, headlines: [headline] });
    assert.ok(!('newsSentiment' in resp));
  });
});

describe('normalizeNewsSentiment', () => {
  it('rounds an in-range reading to two decimals', () => {
    assert.equal(normalizeNewsSentiment(0.4237), 0.42);
    assert.equal(normalizeNewsSentiment(-0.5), -0.5);
    assert.equal(normalizeNewsSentiment(0), 0);
  });

  it('clamps out-of-range readings into [-1, 1]', () => {
    assert.equal(normalizeNewsSentiment(1.4), 1);
    assert.equal(normalizeNewsSentiment(-3), -1);
  });

  it('returns undefined for missing or non-finite values', () => {
    assert.equal(normalizeNewsSentiment(undefined), undefined);
    assert.equal(normalizeNewsSentiment('0.5'), undefined);
    assert.equal(normalizeNewsSentiment(Number.NaN), undefined);
    assert.equal(normalizeNewsSentiment(Number.POSITIVE_INFINITY), undefined);
  });
});

describe('risk analytics helpers', () => {
  it('rejects non-positive OHLC bars before computing risk analytics', async () => {
    const count = 31;
    const values = Array.from({ length: count }, (_, index) => 100 + index);
    const withZero = [...values];
    withZero[15] = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      chart: {
        result: [{
          meta: { currency: 'USD' },
          timestamp: Array.from({ length: count }, (_, index) => 1_700_000_000 + index * 86_400),
          indicators: {
            quote: [{
              open: withZero,
              high: withZero.map((value) => value === 0 ? 0 : value + 1),
              low: withZero.map((value) => value === 0 ? 0 : value - 1),
              close: withZero,
              volume: Array.from({ length: count }, () => 1_000_000),
            }],
          },
        }],
      },
    }), { status: 200 })) as typeof fetch;

    const history = await fetchYahooHistory('AAPL');
    assert.ok(history);
    assert.equal(history.candles.length, 30);
    assert.ok(history.candles.every((candle) => candle.close > 0));
  });

  it('computeRealizedVolatility returns 0 for insufficient or constant-return series', () => {
    assert.equal(computeRealizedVolatility([100]), 0);
    // Every step is a constant +5%, so log returns are identical and stdev is 0.
    assert.equal(computeRealizedVolatility([100, 105, 110.25, 115.7625]), 0);
  });

  it('computeRealizedVolatility annualizes the sample stdev of log returns by sqrt(252)', () => {
    // Closes chosen so daily log returns are exactly +0.1, -0.1, +0.1, -0.1.
    const closes = [100, 100 * Math.exp(0.1), 100, 100 * Math.exp(0.1), 100];
    // Sample stdev of four ±0.1 values is 0.1 * sqrt(4 / 3); annualize by sqrt(252).
    const expected = 0.1 * Math.sqrt(4 / 3) * Math.sqrt(252);
    assert.ok(Math.abs(computeRealizedVolatility(closes) - expected) < 1e-9);
  });

  it('computeAtr returns the constant true range for flat candles', () => {
    const highs = Array.from({ length: 20 }, () => 101);
    const lows = Array.from({ length: 20 }, () => 99);
    const closes = Array.from({ length: 20 }, () => 100);
    // Every true range is high - low = 2, so Wilder's ATR is exactly 2.
    assert.equal(computeAtr(highs, lows, closes), 2);
  });

  it('computeAtr uses the max of the three true-range components across gaps', () => {
    // Seed TRs are [2, 3, 4.5, 3, then ten 2s], whose 14-period mean is 32.5/14.
    const atr = computeAtr(
      [10, 12, 11, ...Array.from({ length: 11 }, () => 11)],
      [8, 11, 7, ...Array.from({ length: 11 }, () => 9)],
      [9, 11.5, 8, ...Array.from({ length: 11 }, () => 10)],
    );
    assert.ok(Math.abs(atr - (32.5 / 14)) < 1e-9);
  });

  it('computeAtr returns 0 before the full seed period is available', () => {
    assert.equal(computeAtr([10], [8], [9]), 0);
    assert.equal(
      computeAtr(
        Array.from({ length: 13 }, () => 10),
        Array.from({ length: 13 }, () => 8),
        Array.from({ length: 13 }, () => 9),
      ),
      0,
    );
  });

  it('computeMaxDrawdown reports the deepest peak-to-trough decline as a negative ratio', () => {
    // Peak 120, trough 90 -> (90 - 120) / 120 = -0.25.
    assert.equal(computeMaxDrawdown([100, 120, 90, 110]), -0.25);
  });

  it('computeMaxDrawdown returns 0 for empty, single-point, or rising series', () => {
    assert.equal(computeMaxDrawdown([]), 0);
    assert.equal(computeMaxDrawdown([100]), 0);
    assert.equal(computeMaxDrawdown([100, 101, 102, 103]), 0);
  });
});

describe('analyzeStock cache contract', () => {
  it('rotates the cache namespace for the additive rating-signal contract', () => {
    const source = readFileSync(
      new URL('../server/worldmonitor/market/v1/analyze-stock.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /market:analyze-stock:v8:/);
    assert.doesNotMatch(source, /market:analyze-stock:v7:/);
  });
});

describe('buildAnalysisResponse risk-analytics surfacing', () => {
  // 40 rising bars then 20 falling bars guarantees a real drawdown and volatility.
  const candles = Array.from({ length: 60 }, (_, i) => {
    const close = i < 40 ? 100 + i * 2 : 180 - (i - 39) * 3;
    return {
      timestamp: 1_700_000_000_000 + i * 86_400_000,
      open: close, high: close + 1, low: close - 1, close, volume: 1_000_000,
    };
  });
  const technical = buildTechnicalSnapshot(candles);
  const overlay = getFallbackOverlay('Test', technical, []);
  const emptyAnalystData: AnalystData = {
    analystConsensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0, period: '' },
    priceTarget: { numberOfAnalysts: 0 },
    recentUpgrades: [],
    fundamentals: {},
  };
  const resp = buildAnalysisResponse({
    symbol: 'AAPL', name: 'Apple', currency: 'USD', technical, headlines: [],
    overlay, analystData: emptyAnalystData, includeNews: false,
    analysisAt: Date.now(), generatedAt: new Date().toISOString(),
  });

  it('passes the snapshot risk metrics straight through to the response', () => {
    assert.equal(resp.realizedVolatility, technical.realizedVolatility);
    assert.equal(resp.atr, technical.atr);
    assert.equal(resp.maxDrawdown, technical.maxDrawdown);
  });

  it('produces finite metrics with the expected signs', () => {
    assert.ok(Number.isFinite(resp.realizedVolatility) && resp.realizedVolatility > 0);
    assert.ok(Number.isFinite(resp.atr) && resp.atr > 0);
    assert.ok(Number.isFinite(resp.maxDrawdown) && resp.maxDrawdown < 0);
  });
});

describe('deriveSignal', () => {
  it('keeps the technicals-only thresholds and trend gates', () => {
    assert.equal(deriveSignal(80, 'Strong bull'), 'Strong buy');
    assert.equal(deriveSignal(80, 'Weak bull'), 'Buy'); // >=75 but the trend gate blocks Strong buy
    assert.equal(deriveSignal(62, 'Bull'), 'Buy');
    assert.equal(deriveSignal(50, 'Consolidation'), 'Hold');
    assert.equal(deriveSignal(35, 'Consolidation'), 'Watch');
    assert.equal(deriveSignal(20, 'Strong bear'), 'Strong sell');
    assert.equal(deriveSignal(20, 'Consolidation'), 'Sell');
  });
});

describe('fallback rating semantics', () => {
  it('uses the composite rating score for the summary and confidence', () => {
    const technical = buildTechnicalSnapshot(Array.from({ length: 80 }, (_, index) => {
      const close = 100 + (index * 0.4);
      return {
        timestamp: 1_700_000_000_000 + (index * 86_400_000),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000_000 + (index * 5_000),
      };
    }));
    technical.signal = 'Strong buy';
    technical.signalScore = 78;

    const overlay = getFallbackOverlay('Example', technical, [], 57, 'Hold');

    assert.match(overlay.summary, /hold/i);
    assert.match(overlay.summary, /57\/100/);
    assert.doesNotMatch(overlay.summary, /78\/100/);
    assert.equal(overlay.confidence, 'Medium');
  });
});

describe('computeFundamentalScore', () => {
  it('returns null when the data is too sparse to score', () => {
    assert.equal(computeFundamentalScore({}), null);
    assert.equal(computeFundamentalScore({ profitMargin: 0.2 }), null); // one metric
    // Two metrics but only one dimension (quality) present -> still null.
    assert.equal(computeFundamentalScore({ profitMargin: 0.2, grossMargin: 0.6 }), null);
  });

  it('scores strong quality/growth/leverage fundamentals high', () => {
    const score = computeFundamentalScore({
      profitMargin: 0.25, operatingMargin: 0.30, grossMargin: 0.65,
      returnOnEquity: 0.35, returnOnAssets: 0.18, freeCashflow: 9e10,
      revenueGrowth: 0.20, earningsGrowth: 0.28,
      debtToEquity: 0.45, totalCash: 6e10, totalDebt: 2e10,
    });
    assert.equal(typeof score, 'number');
    assert.ok((score ?? 0) > 80, `expected > 80, got ${score}`);
  });

  it('scores weak, loss-making, levered fundamentals low', () => {
    const score = computeFundamentalScore({
      profitMargin: -0.10, operatingMargin: -0.05, returnOnEquity: -0.20,
      revenueGrowth: -0.20, earningsGrowth: -0.30,
      debtToEquity: 3,
    });
    assert.equal(typeof score, 'number');
    assert.ok((score ?? 100) < 30, `expected < 30, got ${score}`);
  });

  it('scores the already-normalized debt-to-equity ratio directly', () => {
    const low = computeFundamentalScore({ profitMargin: 0.1, revenueGrowth: 0.1, debtToEquity: 0.45 });
    const high = computeFundamentalScore({ profitMargin: 0.1, revenueGrowth: 0.1, debtToEquity: 2.5 });
    assert.ok((low ?? 0) > (high ?? 0), `expected 0.45x D/E to beat 2.5x, got ${low} vs ${high}`);
  });

  it('keeps normalized leverage above 10x in the worst scoring band', () => {
    const extreme = computeFundamentalScore({ profitMargin: 0.1, revenueGrowth: 0.1, debtToEquity: 15 });
    const high = computeFundamentalScore({ profitMargin: 0.1, revenueGrowth: 0.1, debtToEquity: 3 });
    assert.equal(extreme, high);
  });
});

describe('computeCompositeScore', () => {
  it('passes the technical score through untouched when fundamentals are null', () => {
    assert.equal(computeCompositeScore(72, null), 72);
    assert.equal(computeCompositeScore(0, null), 0);
  });

  it('blends 65% technical / 35% fundamental', () => {
    assert.equal(computeCompositeScore(80, 40), 66); // 0.65*80 + 0.35*40
    assert.equal(computeCompositeScore(50, 90), 64);
  });
});

describe('fundamentals-blended rating', () => {
  const weakFundamentals = {
    profitMargin: -0.10, operatingMargin: -0.05, returnOnEquity: -0.20,
    revenueGrowth: -0.20, earningsGrowth: -0.30, debtToEquity: 3,
  };
  const strongFundamentals = {
    profitMargin: 0.25, operatingMargin: 0.30, grossMargin: 0.65,
    returnOnEquity: 0.35, returnOnAssets: 0.18, freeCashflow: 9e10,
    revenueGrowth: 0.20, earningsGrowth: 0.28,
    debtToEquity: 0.45, totalCash: 6e10, totalDebt: 2e10,
  };

  it('downgrades a technical Strong buy when fundamentals are weak', () => {
    const signalScore = 78;
    assert.equal(deriveSignal(signalScore, 'Strong bull'), 'Strong buy');
    const composite = computeCompositeScore(signalScore, computeFundamentalScore(weakFundamentals));
    assert.ok(composite < signalScore);
    assert.notEqual(deriveSignal(composite, 'Strong bull'), 'Strong buy');
  });

  it('leaves a technical Strong buy intact when fundamentals are strong', () => {
    const composite = computeCompositeScore(78, computeFundamentalScore(strongFundamentals));
    assert.equal(deriveSignal(composite, 'Strong bull'), 'Strong buy');
  });

  it('never changes the rating when fundamentals are unscoreable', () => {
    const composite = computeCompositeScore(78, computeFundamentalScore({}));
    assert.equal(composite, 78);
    assert.equal(deriveSignal(composite, 'Strong bull'), 'Strong buy');
  });
});

describe('analyzeStock fundamental scoring wiring', () => {
  const strongFundamentalsPayload = {
    quoteSummary: {
      result: [{
        recommendationTrend: { trend: [{ period: '0m', strongBuy: 10, buy: 12, hold: 4, sell: 1, strongSell: 0 }] },
        financialData: {
          currentPrice: { raw: 132 },
          profitMargins: { raw: 0.25 },
          grossMargins: { raw: 0.65 },
          operatingMargins: { raw: 0.30 },
          returnOnEquity: { raw: 0.35 },
          returnOnAssets: { raw: 0.18 },
          revenueGrowth: { raw: 0.20 },
          earningsGrowth: { raw: 0.28 },
          debtToEquity: { raw: 45 },
          totalCash: { raw: 6e10 },
          totalDebt: { raw: 2e10 },
          freeCashflow: { raw: 9e10 },
        },
      }],
    },
  };
  const weakFundamentalsPayload = {
    quoteSummary: {
      result: [{
        recommendationTrend: { trend: [{ period: '0m', strongBuy: 1, buy: 2, hold: 8, sell: 7, strongSell: 5 }] },
        financialData: {
          currentPrice: { raw: 132 },
          profitMargins: { raw: -0.10 },
          operatingMargins: { raw: -0.05 },
          returnOnEquity: { raw: -0.20 },
          revenueGrowth: { raw: -0.20 },
          earningsGrowth: { raw: -0.30 },
          debtToEquity: { raw: 1500 },
          totalCash: { raw: 1e9 },
          totalDebt: { raw: 20e9 },
          freeCashflow: { raw: -2e9 },
        },
      }],
    },
  };
  // Monday, US regular hours -> marketSession 'regular' so no extended-hours fetch;
  // passing `now` also takes the direct fetch path (no Redis cache) for determinism.
  const regularSession = new Date('2026-07-20T17:00:00Z');

  it('surfaces fundamentalScore and compositeScore when Yahoo returns fundamentals', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com/v10/finance/quoteSummary')) {
        return new Response(JSON.stringify(strongFundamentalsPayload), { status: 200 });
      }
      if (url.includes('query1.finance.yahoo.com/v8/finance/chart')) {
        return new Response(JSON.stringify(mockChartPayload), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const response = await analyzeStock({} as never, { symbol: 'AAPL', name: 'Apple', includeNews: false }, { now: regularSession });

    assert.equal(response.available, true);
    assert.equal(typeof response.compositeScore, 'number');
    assert.equal(typeof response.fundamentalScore, 'number');
    const fundamental = response.fundamentalScore ?? -1;
    assert.ok(fundamental > 60 && fundamental <= 100, `expected strong fundamentalScore, got ${fundamental}`);
    assert.ok(response.signalScore >= 0); // signalScore stays technicals-only
  });

  it('keeps legacy technical fields paired while the additive rating uses weak fundamentals', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com/v10/finance/quoteSummary')) {
        return new Response(JSON.stringify(weakFundamentalsPayload), { status: 200 });
      }
      if (url.includes('query1.finance.yahoo.com/v8/finance/chart')) {
        return new Response(JSON.stringify(mockChartPayload), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const response = await analyzeStock({} as never, { symbol: 'AAPL', name: 'Apple', includeNews: false }, { now: regularSession });
    const trendStatus = response.trendStatus as Parameters<typeof deriveSignal>[1];

    assert.equal(response.available, true);
    assert.equal(response.fundamentals?.debtToEquity, 15);
    assert.ok(response.compositeScore < response.signalScore);
    assert.equal(response.signal, deriveSignal(response.signalScore, trendStatus));
    assert.equal(response.ratingSignal, deriveSignal(response.compositeScore, trendStatus));
    assert.notEqual(response.ratingSignal, response.signal);
    assert.equal(response.fallback, true);
    assert.match(response.summary, new RegExp(`${response.signalScore}/100`));
    assert.doesNotMatch(response.summary, new RegExp(`${response.compositeScore}/100`));
    assert.match(response.ratingSummary, new RegExp(`${response.compositeScore}/100`));
    assert.doesNotMatch(response.ratingSummary, new RegExp(`${response.signalScore}/100`));
    assert.equal(
      response.confidence,
      response.signalScore >= 75 ? 'High' : response.signalScore >= 55 ? 'Medium' : 'Low',
    );
    assert.equal(
      response.ratingConfidence,
      response.compositeScore >= 75 ? 'High' : response.compositeScore >= 55 ? 'Medium' : 'Low',
    );
    assert.notEqual(response.ratingAction, response.action);
    assert.match(response.ratingWhyNow, new RegExp(`${response.signalScore}/100 technical score`));
    assert.match(response.ratingWhyNow, new RegExp(`${response.fundamentalScore}/100 fundamental score`));
    assert.match(response.ratingRiskFactors.join(' '), /Fundamental quality scores/);
  });

  it('omits fundamentalScore and sets compositeScore = signalScore when fundamentals are absent', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('query1.finance.yahoo.com/v10/finance/quoteSummary')) {
        return new Response(JSON.stringify({ quoteSummary: { result: [{ financialData: {} }] } }), { status: 200 });
      }
      if (url.includes('query1.finance.yahoo.com/v8/finance/chart')) {
        return new Response(JSON.stringify(mockChartPayload), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const response = await analyzeStock({} as never, { symbol: 'AAPL', name: 'Apple', includeNews: false }, { now: regularSession });

    assert.equal(response.available, true);
    assert.equal(response.fundamentalScore, undefined);
    assert.equal(response.compositeScore, response.signalScore);
    assert.equal(response.ratingSignal, response.signal);
    assert.equal(response.ratingSummary, response.summary);
    assert.equal(response.ratingAction, response.action);
    assert.equal(response.ratingConfidence, response.confidence);
  });
});
