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

  it('surfaces exercise-only (code M) activity so panels do not show empty', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([
        { name: 'CFO Exercise', share: 5000, change: 5000, transactionPrice: 10, transactionCode: 'M', transactionDate: recentDate(15), filingDate: recentDate(13) },
        { name: 'CTO Exercise', share: 3000, change: 3000, transactionPrice: 8, transactionCode: 'M', transactionDate: recentDate(25), filingDate: recentDate(23) },
      ]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.unavailable, false);
    assert.equal(resp.transactions.length, 2, 'exercise-only activity must reach the client so panels render the table');
    assert.equal(resp.transactions[0]!.transactionCode, 'M');
    // Exercise activity does not contribute to buys/sells dollar totals because
    // transactionPrice is the option strike, not a market purchase/sale price.
    assert.equal(resp.totalBuys, 0);
    assert.equal(resp.totalSells, 0);
    assert.equal(resp.netValue, 0);
  });

  it('zeros out per-row value for exercise (code M) rows so UI can render a dash placeholder', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([
        { name: 'CFO Exercise', share: 5000, change: 5000, transactionPrice: 10, transactionCode: 'M', transactionDate: recentDate(15), filingDate: recentDate(13) },
        { name: 'Buyer', share: 1000, change: 1000, transactionPrice: 100, transactionCode: 'P', transactionDate: recentDate(5), filingDate: recentDate(3) },
      ]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    const mRow = resp.transactions.find(t => t.transactionCode === 'M');
    const pRow = resp.transactions.find(t => t.transactionCode === 'P');
    assert.ok(mRow, 'M row should be present');
    assert.ok(pRow, 'P row should be present');
    // Shares should still be populated for exercise rows.
    assert.equal(mRow!.shares, 5000);
    // But the dollar value must be zero because transactionPrice is the
    // strike price, not a market execution price. Rendering the naive
    // product would be misleading and contradict the buy/sell totals.
    assert.equal(mRow!.value, 0, 'exercise row must carry value: 0');
    // Regular buys still carry a real dollar value.
    assert.equal(pRow!.value, 100_000);
  });

  it('excludes non-market Form 4 codes (A/D/F) from buy/sell totals', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([
        // Grant/award — compensation, not a market purchase.
        { name: 'Awardee', share: 10000, change: 10000, transactionPrice: 150, transactionCode: 'A', transactionDate: recentDate(5), filingDate: recentDate(3) },
        // Disposition to issuer — e.g. buyback redemption.
        { name: 'Dispositioner', share: 5000, change: -5000, transactionPrice: 160, transactionCode: 'D', transactionDate: recentDate(10), filingDate: recentDate(8) },
        // Payment of exercise price / tax withholding — mechanical, not discretionary.
        { name: 'TaxPayer', share: 2000, change: -2000, transactionPrice: 155, transactionCode: 'F', transactionDate: recentDate(15), filingDate: recentDate(13) },
        // One real buy so we can assert only P counts toward totalBuys.
        { name: 'Buyer', share: 1000, change: 1000, transactionPrice: 100, transactionCode: 'P', transactionDate: recentDate(20), filingDate: recentDate(18) },
      ]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.unavailable, false);
    // Only the P row contributes to totalBuys; A/D/F contribute nothing.
    assert.equal(resp.totalBuys, 100_000);
    assert.equal(resp.totalSells, 0);
    assert.equal(resp.netValue, 100_000);
    // A/D/F rows still reach the client so the panel does not look empty,
    // but their per-row dollar value is zeroed out (rendered as a dash).
    assert.equal(resp.transactions.length, 4);
    const aRow = resp.transactions.find(t => t.transactionCode === 'A');
    const dRow = resp.transactions.find(t => t.transactionCode === 'D');
    const fRow = resp.transactions.find(t => t.transactionCode === 'F');
    assert.ok(aRow && dRow && fRow, 'A/D/F rows should be surfaced');
    assert.equal(aRow!.value, 0);
    assert.equal(dRow!.value, 0);
    assert.equal(fRow!.value, 0);
  });

  it('blends exercise codes with buys and sells', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return mockFinnhubResponse([
        { name: 'Buyer', share: 1000, change: 1000, transactionPrice: 100, transactionCode: 'P', transactionDate: recentDate(5), filingDate: recentDate(3) },
        { name: 'Exerciser', share: 500, change: 500, transactionPrice: 10, transactionCode: 'M', transactionDate: recentDate(10), filingDate: recentDate(8) },
        { name: 'Seller', share: 2000, change: -2000, transactionPrice: 105, transactionCode: 'S', transactionDate: recentDate(15), filingDate: recentDate(13) },
      ]);
    }) as typeof fetch;

    const resp = await getInsiderTransactions({} as never, { symbol: 'AAPL' });
    assert.equal(resp.transactions.length, 3);
    assert.equal(resp.totalBuys, 100000);
    assert.equal(resp.totalSells, 210000);
    const codes = resp.transactions.map(t => t.transactionCode).sort();
    assert.deepEqual(codes, ['M', 'P', 'S']);
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
