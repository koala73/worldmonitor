import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { analyzeStock } from '../server/worldmonitor/market/v1/analyze-stock.ts';
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
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response(JSON.stringify(mockChartPayload), { status: 200 });
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
