import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import capturedBooks from './fixtures/prediction-kalshi-orderbooks.json' with { type: 'json' };
import {
  attachKalshiLiquidity,
  fetchKalshiEvents,
  fetchKalshiMarketsBySeries,
  fetchKalshiOrderbookDepths,
  kalshiOrderbookDepth,
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
    assert.deepEqual(markets.map((market) => market.series_ticker), ['KXIRAN', 'KXIRAN', 'KXLEBANON']);
    assert.equal(maxActiveRequests, 1);
    assert.equal(urls.length, 3);
    assert.equal(new URL(urls[0]).searchParams.get('status'), 'open');
    assert.equal(new URL(urls[0]).searchParams.get('limit'), '1000');
    assert.equal(new URL(urls[0]).searchParams.get('mve_filter'), 'exclude');
  });

  it('rejects an incomplete selected-series hydration', async () => {
    let calls = 0;
    await assert.rejects(
      fetchKalshiMarketsBySeries(['KXIRAN'], {
        fetchFn: async () => Response.json({
          markets: [{ ticker: `IRAN-${calls + 1}` }],
          cursor: `page-${++calls}`,
        }),
        baseUrl: 'https://kalshi.example.test',
        userAgent: 'test',
        maxPagesPerSeries: 2,
      }),
      /Kalshi markets pagination exceeded 2 pages for KXIRAN/,
    );
  });

  it('bounds requests across all selected series', async () => {
    let calls = 0;
    await assert.rejects(
      fetchKalshiMarketsBySeries(['KXIRAN', 'KXLEBANON'], {
        fetchFn: async () => Response.json({
          markets: [{ ticker: `MARKET-${++calls}` }],
          cursor: calls === 1 ? 'next-page' : '',
        }),
        baseUrl: 'https://kalshi.example.test',
        userAgent: 'test',
        maxRequests: 2,
      }),
      /Kalshi markets request budget exceeded 2 requests/,
    );
    assert.equal(calls, 2);
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

const BOOKS = capturedBooks.response.orderbooks;
const bookByTicker = new Map(BOOKS.map((book) => [book.ticker, book]));

function orderbookFetch({ calls = [], fail = () => false } = {}) {
  return async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, headers: init?.headers });
    const tickers = parsed.searchParams.getAll('tickers');
    if (fail(tickers, calls.length)) return new Response('upstream down', { status: 503 });
    return Response.json({ orderbooks: tickers.filter((t) => bookByTicker.has(t)).map((t) => bookByTicker.get(t)) });
  };
}

describe('Kalshi order-book liquidity', () => {
  it('sums price times size over both bid sides of a captured book, in USD', () => {
    assert.equal(kalshiOrderbookDepth(bookByTicker.get('KXELONMARS-99')), 754.4);
    assert.equal(kalshiOrderbookDepth(bookByTicker.get('KXNEXTNATOSECGEN-99-KIOH')), 89.45);
  });

  it('reads an empty book as zero depth and an unreadable book as unknown', () => {
    assert.equal(kalshiOrderbookDepth({ ticker: 'EMPTY', orderbook_fp: { yes_dollars: [], no_dollars: null } }), 0);
    assert.equal(kalshiOrderbookDepth({ ticker: 'MISSING' }), null);
    assert.equal(kalshiOrderbookDepth({ ticker: 'BAD', orderbook_fp: { yes_dollars: [['0.5', 'lots']] } }), null);
    assert.equal(kalshiOrderbookDepth({ ticker: 'BAD', orderbook_fp: { yes_dollars: [['-0.5', '10']] } }), null);
    for (const level of [['0.5', null], [null, '10'], ['0.5', ''], ['0.5'], [true, '10']]) {
      assert.equal(kalshiOrderbookDepth({ ticker: 'BAD', orderbook_fp: { no_dollars: [level] } }), null, JSON.stringify(level));
    }
  });

  it('requests at most 100 tickers per call as repeated tickers= parameters', async () => {
    const calls = [];
    const tickers = Array.from({ length: 250 }, (_, i) => `KXT-${i}`);
    await fetchKalshiOrderbookDepths([...tickers, 'KXT-0'], {
      fetchFn: orderbookFetch({ calls }),
      baseUrl: 'https://kalshi.example.test/trade-api/v2/',
      userAgent: 'test-agent',
    });
    assert.deepEqual(calls.map(({ url }) => url.searchParams.getAll('tickers').length), [100, 100, 50]);
    assert.ok(calls.every(({ url }) => url.pathname === '/trade-api/v2/markets/orderbooks'));
    assert.ok(calls.every(({ url }) => url.searchParams.getAll('tickers').every((t) => !t.includes(','))));
    assert.ok(calls.every(({ headers }) => headers['User-Agent'] === 'test-agent'));
  });

  it('leaves a failed chunk unknown without failing the other chunks', async () => {
    const failures = [];
    const tickers = [...Array.from({ length: 100 }, (_, i) => `KXFILL-${i}`), 'KXELONMARS-99'];
    const depths = await fetchKalshiOrderbookDepths(['KXNEXTNATOSECGEN-99-KIOH', ...tickers], {
      fetchFn: orderbookFetch({ fail: (_tickers, call) => call === 2 }),
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
      onChunkError: (error, chunk) => failures.push({ error, chunk }),
    });
    assert.equal(depths.get('KXNEXTNATOSECGEN-99-KIOH'), 89.45);
    assert.equal(depths.has('KXELONMARS-99'), false);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].chunk, ['KXFILL-99', 'KXELONMARS-99']);
    assert.match(failures[0].error.message, /503/);
  });

  it('attaches depth to published Kalshi records only and never writes 0 for an unpriced market', async () => {
    const records = [
      { title: 'mars', source: 'kalshi', url: 'https://kalshi.com/markets/KXELONMARS-99' },
      { title: 'mars again', source: 'kalshi', url: 'https://kalshi.com/markets/KXELONMARS-99' },
      { title: 'not returned', source: 'kalshi', url: 'https://kalshi.com/markets/KXNOT-RETURNED' },
      { title: 'poly', source: 'polymarket', url: 'https://polymarket.com/event/x', liquidity: 1234 },
    ];
    const summary = await attachKalshiLiquidity(records, {
      fetchFn: orderbookFetch(),
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
    });
    assert.equal(records[0].liquidity, 754.4);
    assert.equal(records[1].liquidity, 754.4);
    assert.equal('liquidity' in records[2], false);
    assert.equal(records[3].liquidity, 1234);
    assert.deepEqual(summary, { tickers: 2, priced: 1 });
  });

  it('survives a total order-book outage', async () => {
    const records = [{ title: 'mars', source: 'kalshi', url: 'https://kalshi.com/markets/KXELONMARS-99' }];
    const summary = await attachKalshiLiquidity(records, {
      fetchFn: async () => { throw new Error('network down'); },
      baseUrl: 'https://kalshi.example.test',
      userAgent: 'test',
      onChunkError: () => {},
    });
    assert.equal('liquidity' in records[0], false);
    assert.deepEqual(summary, { tickers: 1, priced: 0 });
  });
});
