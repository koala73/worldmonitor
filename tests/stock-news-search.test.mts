import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildStockNewsSearchCacheKey,
  buildStockNewsSearchQuery,
  resetStockNewsSearchStateForTests,
  searchRecentStockHeadlines,
} from '../server/worldmonitor/market/v1/stock-news-search.ts';
import { fetchCompanyNewsMentions } from '../server/worldmonitor/intelligence/v1/_company-shared.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.EXA_API_KEYS;
  delete process.env.BRAVE_API_KEYS;
  delete process.env.SERPAPI_API_KEYS;
  resetStockNewsSearchStateForTests();
});

describe('stock news search query', () => {
  it('builds the same stock-news style query used by the source project', () => {
    assert.equal(buildStockNewsSearchQuery('aapl', 'Apple'), 'Apple AAPL stock latest news');
    assert.equal(buildStockNewsSearchQuery(' msft ', ''), 'MSFT stock latest news');
  });
});

// GHSA-4wq2-wqrh-9x7v: the key carried a 32-bit FNV hash of the query, so a
// Pro caller could pick a name whose query collided with another caller's and
// seed the shared row with headlines fetched for a different search.
describe('stock news search cache key', () => {
  it('separates queries whose 32-bit FNV hashes collide', async () => {
    const collisions: Array<[string, string]> = [
      ['Apple', 'Apple fraud investigation recall lawsuitfaT5h4'],
      ['Apple Inc.', 'QyF B('],
    ];
    for (const [a, b] of collisions) {
      assert.notEqual(
        await buildStockNewsSearchCacheKey('AAPL', a, 7, 5, 'default'),
        await buildStockNewsSearchCacheKey('AAPL', b, 7, 5, 'default'),
        `${JSON.stringify(a)} and ${JSON.stringify(b)} must not share a row`,
      );
    }
  });

  it('reuses one row for an identical search and keeps the other key dimensions', async () => {
    const key = await buildStockNewsSearchCacheKey('aapl', 'Apple', 7, 5, 'default');
    assert.equal(key, await buildStockNewsSearchCacheKey('AAPL', 'Apple', 7, 5, 'default'));
    assert.match(key, /^market:stock-news-search:v3:default:AAPL:7:5:[0-9a-f]{32}$/);
    assert.notEqual(key, await buildStockNewsSearchCacheKey('AAPL', 'Apple', 7, 5, 'other'));
    assert.notEqual(key, await buildStockNewsSearchCacheKey('AAPL', 'Apple', 3, 5, 'default'));
    assert.notEqual(key, await buildStockNewsSearchCacheKey('AAPL', 'Apple', 7, 10, 'default'));
  });
});

describe('searchRecentStockHeadlines', () => {
  it('uses Exa first when configured', async () => {
    process.env.EXA_API_KEYS = 'exa-key-1';
    const requested: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      if (url === 'https://api.exa.ai/search') {
        return new Response(JSON.stringify({
          results: [
            {
              title: 'Apple expands buyback after strong quarter',
              url: 'https://example.com/apple-buyback',
              publishedDate: '2026-03-08T12:00:00.000Z',
            },
          ],
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await searchRecentStockHeadlines('AAPL', 'Apple', 5);

    assert.equal(result.provider, 'exa');
    assert.equal(result.headlines.length, 1);
    assert.equal(result.headlines[0]?.link, 'https://example.com/apple-buyback');
    assert.deepEqual(requested, ['https://api.exa.ai/search']);
  });

  it('falls back from Exa to Brave before using RSS', async () => {
    process.env.EXA_API_KEYS = 'exa-key-1';
    process.env.BRAVE_API_KEYS = 'brave-key-1';
    const requested: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      if (url === 'https://api.exa.ai/search') {
        return new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 });
      }
      if (url.startsWith('https://api.search.brave.com/res/v1/web/search?')) {
        return new Response(JSON.stringify({
          web: {
            results: [
              {
                title: 'Apple supply chain normalizes',
                url: 'https://example.com/apple-supply-chain',
                description: 'Supply chain pressure eases for Apple.',
                age: '2 hours ago',
              },
            ],
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await searchRecentStockHeadlines('AAPL', 'Apple', 5);

    assert.equal(result.provider, 'brave');
    assert.equal(result.headlines.length, 1);
    assert.equal(result.headlines[0]?.link, 'https://example.com/apple-supply-chain');
    assert.equal(requested.length, 2);
    assert.equal(requested[0], 'https://api.exa.ai/search');
    assert.match(requested[1] || '', /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
  });

  it('falls back to Google News RSS when provider keys are unavailable', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://news.google.com/rss/search?')) {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<rss>
  <channel>
    <item>
      <title>Apple launches new enterprise AI bundle</title>
      <link>https://example.com/apple-ai-bundle</link>
      <pubDate>Sun, 08 Mar 2026 10:00:00 GMT</pubDate>
      <source>Bloomberg</source>
    </item>
  </channel>
</rss>`, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await searchRecentStockHeadlines('AAPL', 'Apple', 5);

    assert.equal(result.provider, 'google-news-rss');
    assert.equal(result.headlines.length, 1);
    assert.equal(result.headlines[0]?.source, 'Bloomberg');
  });

  it('parses SerpAPI news results when it is the first available provider', async () => {
    process.env.SERPAPI_API_KEYS = 'serp-key-1';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://serpapi.com/search.json?')) {
        return new Response(JSON.stringify({
          news_results: [
            {
              title: 'Apple opens new AI engineering hub',
              link: 'https://example.com/apple-ai-hub',
              source: 'CNBC',
              date: '3 hours ago',
            },
          ],
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await searchRecentStockHeadlines('AAPL', 'Apple', 5);

    assert.equal(result.provider, 'serpapi');
    assert.equal(result.headlines.length, 1);
    assert.equal(result.headlines[0]?.source, 'CNBC');
  });

  it('cancels the provider ladder at the corporate-intelligence deadline', async () => {
    process.env.EXA_API_KEYS = 'exa-key-1';
    process.env.BRAVE_API_KEYS = 'brave-key-1';
    const requested: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      if (url !== 'https://api.exa.ai/search') throw new Error(`Unexpected fallback after abort: ${url}`);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;

    const result = await fetchCompanyNewsMentions('ABRT', 'Abort Corp', 20);
    assert.equal(result, null);
    assert.deepEqual(requested, ['https://api.exa.ai/search']);
  });
});
