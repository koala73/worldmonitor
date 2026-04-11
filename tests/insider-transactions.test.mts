import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getInsiderTransactions } from '../server/worldmonitor/market/v1/get-insider-transactions.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function mockFinnhubResponse(data: unknown[]) {
  return new Response(JSON.stringify({ data, symbol: 'AAPL' }), { status: 200 });
}

function recentDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().split('T')[0]!;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.FINNHUB_API_KEY = originalEnv.FINNHUB_API_KEY;
});

describe('getInsiderTransactions handler', () => {
  it('returns unavailable when FINNHUB_API_KEY is missing', async () => {
    delete process.env.FINNHUB_API_KEY;
    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.unavailable, true);
    assert.equal(resp.symbol, 'AAPL');
  });

  it('returns unavailable when symbol is empty', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    const resp = await getInsiderTransactions({} as never, { symbol: '' });
    assert.equal(resp.unavailable, true);
  });

  it('aggregates purchase and sale totals for recent transactions', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([
        { name: 'Tim Cook', share: 10000, change: 10000, transactionPrice: 150, transactionCode: 'P', transactionDate: recentDate(10), filingDate: recentDate(8) },
        { name: 'Jeff Williams', share: 5000, change: -5000, transactionPrice: 155, transactionCode: 'S', transactionDate: recentDate(20), filingDate: recentDate(18) },
        { name: 'Luca Maestri', share: 2000, change: 2000, transactionPrice: 148, transactionCode: 'P', transactionDate: recentDate(30), filingDate: recentDate(28) },
      ]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.unavailable, false);
    assert.equal(resp.symbol, 'AAPL');
    assert.equal(resp.totalBuys, 10000 * 150 + 2000 * 148);
    assert.equal(resp.totalSells, 5000 * 155);
    assert.equal(resp.netValue, resp.totalBuys - resp.totalSells);
    assert.equal(resp.transactions.length, 3);
    assert.equal(resp.transactions[0]!.name, 'Tim Cook');
  });

  it('filters out transactions older than 6 months', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([
        { name: 'Recent Exec', share: 1000, change: 1000, transactionPrice: 100, transactionCode: 'P', transactionDate: recentDate(30), filingDate: recentDate(28) },
        { name: 'Old Exec', share: 5000, change: 5000, transactionPrice: 100, transactionCode: 'P', transactionDate: recentDate(200), filingDate: recentDate(198) },
      ]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.unavailable, false);
    assert.equal(resp.transactions.length, 1);
    assert.equal(resp.transactions[0]!.name, 'Recent Exec');
    assert.equal(resp.totalBuys, 100000);
  });

  it('returns unavailable on upstream failure', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return new Response('error', { status: 500 });
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.unavailable, true);
  });

  it('returns no-activity when Finnhub returns empty data', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.unavailable, false);
    assert.equal(resp.transactions.length, 0);
  });

  it('passes the symbol in the Finnhub URL', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return mockFinnhubResponse([
        { name: 'Exec', share: 100, change: 100, transactionPrice: 50, transactionCode: 'P', transactionDate: recentDate(5), filingDate: recentDate(3) },
      ]);
    }) as typeof fetch;

    await getInsiderTransactions({} as never, { symbol: 'MSFT' });
    assert.match(requestedUrl, /symbol=MSFT/);
    assert.match(requestedUrl, /token=test-key/);
  });

  it('sorts transactions by date descending', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([
        { name: 'Older', share: 100, change: 100, transactionPrice: 50, transactionCode: 'P', transactionDate: recentDate(60), filingDate: recentDate(58) },
        { name: 'Newer', share: 200, change: 200, transactionPrice: 50, transactionCode: 'S', transactionDate: recentDate(10), filingDate: recentDate(8) },
        { name: 'Middle', share: 150, change: 150, transactionPrice: 50, transactionCode: 'P', transactionDate: recentDate(30), filingDate: recentDate(28) },
      ]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.transactions[0]!.name, 'Newer');
    assert.equal(resp.transactions[1]!.name, 'Middle');
    assert.equal(resp.transactions[2]!.name, 'Older');
  });
});

describe('MarketServiceClient getInsiderTransactions', () => {
  it('serializes the query parameters using generated names', async () => {
    const { MarketServiceClient } = await import('../src/generated/client/worldmonitor/market/v1/service_client.ts');
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ unavailable: true }), { status: 200 });
    }) as typeof fetch;

    const client = new MarketServiceClient('');
    await client.getInsiderTransactions({ symbol: 'TSLA' });
    assert.match(requestedUrl, /\/api\/market\/v1\/get-insider-transactions\?/);
    assert.match(requestedUrl, /symbol=TSLA/);
  });
});
