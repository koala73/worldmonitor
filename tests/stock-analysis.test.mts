import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { analyzeStock, fetchYahooAnalystData } from '../server/worldmonitor/market/v1/analyze-stock.ts';
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
          targetHighPrice: { raw: 250.0 },
          targetLowPrice: { raw: 160.0 },
          targetMeanPrice: { raw: 210.5 },
          targetMedianPrice: { raw: 215.0 },
          currentPrice: { raw: 132.0 },
          numberOfAnalystOpinions: { raw: 39 },
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
              targetHighPrice: { raw: 'not a number' },
              targetLowPrice: {},
              numberOfAnalystOpinions: { raw: 10 },
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
