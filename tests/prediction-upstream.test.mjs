import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchKalshiEvents,
  fetchKalshiMarketsBySeries,
  fetchKalshiSeries,
  fetchPolymarketEventsByTag,
} from '../scripts/_prediction-upstream.mjs';

describe('prediction-market upstream coverage', () => {
  it('follows the Kalshi cursor until the last page', async () => {
    const urls = [];
    const pages = [
      { events: [{ id: 'one' }], cursor: 'next-page' },
      { events: [{ id: 'two' }], cursor: '' },
    ];
    const events = await fetchKalshiEvents({
      fetchFn: async (url) => {
        urls.push(String(url));
        return Response.json(pages.shift());
      },
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
    });

    assert.deepEqual(events.map((event) => event.id), ['one', 'two']);
    assert.equal(urls.length, 2);
    assert.equal(new URL(urls[0]).searchParams.get('limit'), '200');
    assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'next-page');
  });

  it('bounds Kalshi pagination when the upstream cursor never ends', async () => {
    let calls = 0;
    const events = await fetchKalshiEvents({
      fetchFn: async () => Response.json({ events: [{ id: ++calls }], cursor: `page-${calls}` }),
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
      maxPages: 3,
    });

    assert.equal(calls, 3);
    assert.equal(events.length, 3);
  });

  it('keeps earlier Kalshi pages when a later page fails', async () => {
    const pageErrors = [];
    let calls = 0;
    const events = await fetchKalshiEvents({
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) return Response.json({ events: [{ id: 'one' }], cursor: 'next-page' });
        return new Response(null, { status: 503 });
      },
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
      onPageError: (error, page) => pageErrors.push({ message: error.message, page }),
    });

    assert.deepEqual(events.map((event) => event.id), ['one']);
    assert.deepEqual(pageErrors, [{ message: 'Kalshi HTTP 503', page: 2 }]);
  });

  it('still rejects when the first Kalshi page fails', async () => {
    await assert.rejects(
      fetchKalshiEvents({
        fetchFn: async () => new Response(null, { status: 503 }),
        baseUrl: 'https://kalshi.example.test',
        userAgent: 'test',
      }),
      /Kalshi HTTP 503/,
    );
  });

  it('rejects a malformed first Kalshi page', async () => {
    await assert.rejects(
      fetchKalshiEvents({
        fetchFn: async () => Response.json({ cursor: '' }),
        baseUrl: 'https://kalshi.example.test',
        userAgent: 'test',
      }),
      /Kalshi invalid payload: expected events array/,
    );
  });

  it('marks the projection incomplete and keeps earlier events after a malformed later Kalshi page', async () => {
    const pageErrors = [];
    let complete = true;
    let calls = 0;
    const events = await fetchKalshiEvents({
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) return Response.json({ events: [{ id: 'one' }], cursor: 'next-page' });
        return Response.json({ cursor: '' });
      },
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
      onPageError: (error, page) => {
        complete = false;
        pageErrors.push({ message: error.message, page });
      },
    });

    assert.deepEqual(events.map((event) => event.id), ['one']);
    assert.equal(complete, false);
    assert.deepEqual(pageErrors, [
      { message: 'Kalshi invalid payload: expected events array', page: 2 },
    ]);
  });

  it('accepts a valid empty Kalshi events array', async () => {
    const events = await fetchKalshiEvents({
      fetchFn: async () => Response.json({ events: [], cursor: '' }),
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
    });

    assert.deepEqual(events, []);
  });

  it('loads the complete Kalshi series catalog with volume metadata', async () => {
    let requestedUrl = '';
    const series = await fetchKalshiSeries({
      fetchFn: async (url) => {
        requestedUrl = String(url);
        return Response.json({ series: [{ ticker: 'KXUSAIRANAGREEMENT' }] });
      },
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
    });

    assert.deepEqual(series, [{ ticker: 'KXUSAIRANAGREEMENT' }]);
    assert.equal(new URL(requestedUrl).pathname, '/series');
    assert.equal(new URL(requestedUrl).searchParams.get('include_volume'), 'true');
  });

  it('hydrates selected Kalshi series sequentially and follows each cursor', async () => {
    const urls = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const pages = new Map([
      ['KXIRAN:', { markets: [{ ticker: 'IRAN-1' }], cursor: 'iran-next' }],
      ['KXIRAN:iran-next', { markets: [{ ticker: 'IRAN-2' }], cursor: '' }],
      ['KXLEBANON:', { markets: [{ ticker: 'LEBANON-1' }], cursor: '' }],
    ]);
    const markets = await fetchKalshiMarketsBySeries(['KXIRAN', 'KXLEBANON', 'KXIRAN'], {
      fetchFn: async (url) => {
        urls.push(String(url));
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        const parsed = new URL(url);
        const key = `${parsed.searchParams.get('series_ticker')}:${parsed.searchParams.get('cursor') ?? ''}`;
        return Response.json(pages.get(key));
      },
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
    });

    assert.deepEqual(markets.map((market) => market.ticker), ['IRAN-1', 'IRAN-2', 'LEBANON-1']);
    assert.equal(maxActiveRequests, 1);
    assert.equal(urls.length, 3);
    assert.equal(new URL(urls[0]).searchParams.get('status'), 'open');
    assert.equal(new URL(urls[0]).searchParams.get('limit'), '1000');
    assert.equal(new URL(urls[0]).searchParams.get('mve_filter'), 'exclude');
  });

  it('rejects an incomplete selected-series hydration', async () => {
    await assert.rejects(
      fetchKalshiMarketsBySeries(['KXIRAN'], {
        fetchFn: async () => Response.json({ markets: [{ ticker: 'IRAN-1' }], cursor: 'never-ends' }),
        baseUrl: 'https://kalshi.example.test',
        userAgent: 'test',
        maxPagesPerSeries: 2,
      }),
      /Kalshi markets pagination exceeded 2 pages for KXIRAN/,
    );
  });

  it('rejects malformed Kalshi series and market payloads', async () => {
    await assert.rejects(
      fetchKalshiSeries({
        fetchFn: async () => Response.json({}),
        baseUrl: 'https://kalshi.example.test',
        userAgent: 'test',
      }),
      /Kalshi invalid payload: expected series array/,
    );
    await assert.rejects(
      fetchKalshiMarketsBySeries(['KXIRAN'], {
        fetchFn: async () => Response.json({}),
        baseUrl: 'https://kalshi.example.test',
        userAgent: 'test',
      }),
      /Kalshi invalid payload: expected markets array/,
    );
  });

  it('requests 100 Polymarket events per tag instead of truncating at 20', async () => {
    let requestedUrl = '';
    await fetchPolymarketEventsByTag('politics', {
      fetchFn: async (url) => {
        requestedUrl = String(url);
        return Response.json([]);
      },
      baseUrl: 'https://polymarket.example.test',
      userAgent: 'test',
    });

    assert.equal(new URL(requestedUrl).searchParams.get('limit'), '100');
  });

  it('rejects a parsed non-array Polymarket body', async () => {
    await assert.rejects(
      fetchPolymarketEventsByTag('politics', {
        fetchFn: async () => Response.json({ events: [] }),
        baseUrl: 'https://polymarket.example.test',
        userAgent: 'test',
      }),
      /Polymarket invalid payload: expected an array/,
    );
  });

  it('accepts a valid empty Polymarket events array', async () => {
    const events = await fetchPolymarketEventsByTag('politics', {
      fetchFn: async () => Response.json([]),
      baseUrl: 'https://polymarket.example.test',
      userAgent: 'test',
    });

    assert.deepEqual(events, []);
  });
});
