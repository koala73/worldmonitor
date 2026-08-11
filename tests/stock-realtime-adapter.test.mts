import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  getMassiveStockBars,
  resolveMassiveBarWindow,
} from '../server/worldmonitor/market/v1/massive-stock-provider';
import { resolveUsEquityMarketState } from '../server/worldmonitor/market/v1/market-calendar';
import {
  MarketStockStreamRelay,
  type WebSocketLike,
} from '../server/worldmonitor/market/v1/market-stream-relay';
import { createStockContractLiveHandlers } from '../server/worldmonitor/market/v1/stock-contract-live';
import { assertNoSuspiciousFlatline } from '../server/worldmonitor/market/v1/stock-data-contract';
import type { StockBar } from '../src/generated/server/worldmonitor/market/v1/service_server';

const NOW = Date.UTC(2026, 7, 11, 15, 0, 0); // 11:00 America/New_York, regular session.

const RECORDED_AGGREGATES: Record<string, Array<{ t: number; o: number; h: number; l: number; c: number; v: number; vw: number; n: number }>> = {
  AAPL: [
    { t: Date.UTC(2026, 2, 2), o: 262.41, h: 266.53, l: 260.2, c: 264.72, v: 41827946, vw: 263.2, n: 100 },
    { t: Date.UTC(2026, 2, 3), o: 263.48, h: 265.56, l: 260.13, c: 263.75, v: 38568921, vw: 263.1, n: 101 },
  ],
  MSFT: [
    { t: Date.UTC(2026, 2, 2), o: 392.855, h: 401.19, l: 390.63, c: 398.55, v: 35474907, vw: 396.8, n: 102 },
    { t: Date.UTC(2026, 2, 3), o: 393.14, h: 406.7, l: 392.67, c: 403.93, v: 38199209, vw: 400.2, n: 103 },
  ],
  NVDA: [
    { t: Date.UTC(2026, 2, 2), o: 175.01, h: 183.46, l: 174.64, c: 182.48, v: 209095331, vw: 180.9, n: 104 },
    { t: Date.UTC(2026, 2, 3), o: 178.49, h: 180.9, l: 176.92, c: 180.05, v: 178099430, vw: 178.9, n: 105 },
  ],
  TSLA: [
    { t: Date.UTC(2026, 2, 2), o: 390.6, h: 404.54, l: 388.25, c: 403.32, v: 55088338, vw: 398.9, n: 106 },
    { t: Date.UTC(2026, 2, 3), o: 395.09, h: 396.34, l: 385.39, c: 392.43, v: 62617298, vw: 391.7, n: 107 },
  ],
};

function massiveFetch(input: URL | RequestInfo): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const match = /\/ticker\/([A-Z0-9.-]+)\/range\//.exec(url.pathname);
  const symbol = match?.[1] ?? '';
  const results = RECORDED_AGGREGATES[symbol];
  return Promise.resolve(new Response(JSON.stringify({
    status: 'OK', ticker: symbol, request_id: `recorded-${symbol}`, adjusted: true, results,
  }), { headers: { 'Content-Type': 'application/json' } }));
}

test('recorded OHLC replays stay symbol-isolated and never receive a shared cache/series shape', async () => {
  const fingerprints: string[] = [];
  for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'TSLA']) {
    const result = await getMassiveStockBars({ symbol, interval: '1d', range: '1M', startUtc: 0, endUtc: 0 }, {
      apiKey: 'test-key-not-a-secret', fetchImpl: massiveFetch, now: () => NOW,
    });
    assert.equal(result.symbol, symbol);
    assert.equal(result.provenance.provider, 'massive');
    assert.equal(result.provenance.providerStatus, 'PROVIDER_STATUS_END_OF_DAY');
    assert.ok(result.bars.every(bar => bar.symbol === symbol));
    assert.ok(result.bars.every(bar => bar.low <= bar.open && bar.low <= bar.close && bar.high >= bar.open && bar.high >= bar.close));
    fingerprints.push(createHash('sha256').update(JSON.stringify(result.bars)).digest('hex'));
  }
  assert.equal(new Set(fingerprints).size, 4, 'distinct requested symbols must have distinct OHLC fingerprints');
});

test('a Massive response with a cross-symbol ticker is rejected before it reaches a client', async () => {
  await assert.rejects(
    () => getMassiveStockBars({ symbol: 'AAPL', interval: '1d', range: '1M', startUtc: 0, endUtc: 0 }, {
      apiKey: 'test-key-not-a-secret', now: () => NOW,
      fetchImpl: async () => new Response(JSON.stringify({ ticker: 'MSFT', results: RECORDED_AGGREGATES.MSFT })),
    }),
    /requested AAPL/,
  );
});

test('range requests map to a real bounded interval rather than one reused default window', () => {
  const ranges = ['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'];
  const windows = ranges.map(range => resolveMassiveBarWindow({ symbol: 'AAPL', interval: '1d', range, startUtc: 0, endUtc: 0 }, NOW));
  assert.equal(new Set(windows.map(window => window.cacheWindow)).size, ranges.length);
  assert.equal(windows[0]!.to, windows.at(-1)!.to);
  assert.ok(windows[0]!.from > windows[6]!.from, '1D must cover less history than MAX');
});

test('the exchange calendar marks a Sunday and NYSE holiday closed, without creating a bar', () => {
  const sunday = resolveUsEquityMarketState(new Date('2026-08-09T16:00:00.000Z'));
  const christmas = resolveUsEquityMarketState(new Date('2026-12-25T16:00:00.000Z'));
  assert.equal(sunday.marketClosed, true);
  assert.equal(christmas.marketClosed, true);
  assert.equal(sunday.session, 'MARKET_SESSION_CLOSED');
  assert.equal(christmas.session, 'MARKET_SESSION_CLOSED');
});

test('a long identical traded OHLC run is rejected instead of being labelled live', () => {
  const bars: StockBar[] = Array.from({ length: 6 }, (_, index) => ({
    symbol: 'AAPL', interval: '1m', timestampUtc: index + 1, tradingDate: '2026-08-11',
    open: 100, high: 100, low: 100, close: 100, volume: 25, vwap: 100, transactions: 2,
    adjusted: false, session: 'MARKET_SESSION_REGULAR', currency: 'USD', exchange: 'XNAS',
  }));
  assert.throws(() => assertNoSuspiciousFlatline('AAPL', bars), /cannot be labelled live/);
});

test('primary failure uses an explicitly-labelled quote fallback, never a fallback candle series', async () => {
  const handlers = createStockContractLiveHandlers({
    massive: { apiKey: 'test-key-not-a-secret', fetchImpl: async () => { throw new Error('provider unavailable'); } },
    fallbackQuote: async symbol => ({
      quote: { symbol, price: 401, change: 0, changePercent: 1.25, currency: 'USD', exchange: 'XNAS', session: 'MARKET_SESSION_REGULAR' },
      provenance: {
        provider: 'finnhub', providerStatus: 'PROVIDER_STATUS_DELAYED_UNVERIFIED', sourceUrl: 'https://finnhub.io/docs/api/quote',
        sourceId: `stock-quote:finnhub:${symbol}`, observedAt: 0, fetchedAt: NOW, asOf: 0, delaySeconds: -1, freshnessSeconds: -1,
        isFallback: true, fallbackReason: 'Massive primary quote failed.', licenseNote: 'Not a real-time claim.',
      },
    }),
  });
  const quote = await handlers.getStockQuote({} as never, { symbol: 'MSFT' });
  const bars = await handlers.getStockBars({} as never, { symbol: 'MSFT', interval: '1m', range: '1D', startUtc: 0, endUtc: 0 });
  assert.equal(quote.quote?.price, 401);
  assert.equal(quote.provenance?.isFallback, true);
  assert.equal(quote.provenance?.providerStatus, 'PROVIDER_STATUS_DELAYED_UNVERIFIED');
  assert.deepEqual(bars.bars, []);
  assert.equal(bars.provenance?.providerStatus, 'PROVIDER_STATUS_UNAVAILABLE');
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.({}); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  message(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

test('server relay authenticates upstream only, upserts minute bars and exposes no key to subscribers', async () => {
  const socket = new FakeSocket();
  const browserEvents: unknown[] = [];
  const relay = new MarketStockStreamRelay({
    apiKey: 'test-key-not-a-secret', realtimeDisplayAndRedistributionConfirmed: true,
    socketFactory: () => socket, now: () => NOW, unsubscribeDelayMs: 1,
  });
  const unsubscribe = relay.subscribe('AAPL', event => browserEvents.push(event));
  socket.open();
  assert.ok(socket.sent.some(message => message.includes('"action":"auth"')));
  assert.ok(socket.sent.some(message => message.includes('AM.AAPL')));

  socket.message({ ev: 'AM', sym: 'AAPL', v: 20, vw: 101, o: 100, c: 101, h: 102, l: 99, n: 4, s: NOW, e: NOW + 60_000 });
  socket.message({ ev: 'AM', sym: 'AAPL', v: 21, vw: 101.5, o: 100, c: 101.5, h: 102, l: 99, n: 5, s: NOW, e: NOW + 60_000 });
  socket.message({ ev: 'AM', sym: 'MSFT', v: 20, vw: 401, o: 400, c: 401, h: 402, l: 399, n: 4, s: NOW, e: NOW + 60_000 });

  const snapshot = relay.snapshot('AAPL');
  assert.equal(snapshot.length, 1, 'same symbol/interval/timestamp must upsert rather than append');
  assert.equal(snapshot[0]?.close, 101.5);
  assert.equal(relay.snapshot('MSFT').length, 0, 'unsubscribed symbols cannot enter another symbol ring buffer');
  assert.equal(JSON.stringify(browserEvents).includes('test-key-not-a-secret'), false, 'browser events must never expose the upstream credential');

  unsubscribe();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(socket.sent.some(message => message.includes('"action":"unsubscribe"')));
  relay.stop();
});

test('relay remains disabled until real-time display and redistribution entitlement is confirmed', () => {
  let factoryCalls = 0;
  const relay = new MarketStockStreamRelay({
    apiKey: 'test-key-not-a-secret', realtimeDisplayAndRedistributionConfirmed: false,
    socketFactory: () => { factoryCalls += 1; return new FakeSocket(); }, now: () => NOW,
  });
  const unsubscribe = relay.subscribe('AAPL', () => {});
  assert.equal(factoryCalls, 0);
  assert.equal(relay.status.providerStatus, 'PROVIDER_STATUS_DELAYED_UNVERIFIED');
  unsubscribe();
  relay.stop();
});
