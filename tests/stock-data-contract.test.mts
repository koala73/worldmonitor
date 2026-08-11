import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertStockBarSeriesIntegrity,
  buildMarketCacheKey,
  normalizeStockSymbol,
} from '../server/worldmonitor/market/v1/stock-data-contract';
import { getStockBars, getStockQuote } from '../server/worldmonitor/market/v1/stock-contract-disabled';
import { PROVIDER_STATUS_DISPLAY } from '../src/services/market-data-truth';
import { createMarketServiceRoutes } from '../src/generated/server/worldmonitor/market/v1/service_server';
import type { ProviderStatus, StockBar } from '../src/generated/server/worldmonitor/market/v1/service_server';
import { marketHandler } from '../server/worldmonitor/market/v1/handler';
import { serverOptions } from '../server/gateway';

const EXPECTED_PROVIDER_STATUSES: ProviderStatus[] = [
  'PROVIDER_STATUS_UNSPECIFIED',
  'PROVIDER_STATUS_REALTIME_LICENSED',
  'PROVIDER_STATUS_DELAYED_15M',
  'PROVIDER_STATUS_DELAYED_UNVERIFIED',
  'PROVIDER_STATUS_END_OF_DAY',
  'PROVIDER_STATUS_HISTORICAL_SNAPSHOT',
  'PROVIDER_STATUS_STALE',
  'PROVIDER_STATUS_DEGRADED',
  'PROVIDER_STATUS_NOT_CONFIGURED',
  'PROVIDER_STATUS_UNAVAILABLE',
  'PROVIDER_STATUS_MARKET_CLOSED',
];

test('the disabled market endpoints return explicit provenance, not synthetic bars', async () => {
  const bars = await getStockBars({} as never, {
    symbol: ' aapl ', interval: '', startUtc: 0, endUtc: 0, range: '1D',
  });
  const quote = await getStockQuote({} as never, { symbol: 'MSFT' });

  assert.equal(bars.symbol, 'AAPL');
  assert.equal(bars.interval, '1d');
  assert.deepEqual(bars.bars, []);
  assert.equal(bars.provenance?.providerStatus, 'PROVIDER_STATUS_NOT_CONFIGURED');
  assert.ok((bars.provenance?.fetchedAt ?? 0) > 0);
  assert.equal(bars.provenance?.delaySeconds, -1);
  assert.equal(bars.provenance?.freshnessSeconds, -1);
  assert.equal(quote.symbol, 'MSFT');
  assert.equal(quote.quote, undefined);
  assert.equal(quote.provenance?.providerStatus, 'PROVIDER_STATUS_NOT_CONFIGURED');
});

test('symbol validation and cache keys cannot cross-contaminate companies', () => {
  assert.equal(normalizeStockSymbol(' brk.b '), 'BRK.B');
  assert.throws(() => normalizeStockSymbol('AAPL;DROP'), /valid equity ticker/);
  assert.throws(() => normalizeStockSymbol(''), /required/);

  const symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA'];
  const keys = symbols.map(symbol => buildMarketCacheKey('massive', symbol, '1d', '1M'));
  assert.equal(new Set(keys).size, symbols.length);
  for (const [index, key] of keys.entries()) {
    assert.match(key, new RegExp(`:massive:${symbols[index]}:1d:1M$`));
  }
});

test('recorded historical fixture has valid and distinct OHLC series for AAPL, MSFT, NVDA and TSLA', async () => {
  const fixtureUrl = new URL('./fixtures/market/recorded-historical-bars-v1.json', import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as {
    source: { truthStatus: string; notice: string };
    barsBySymbol: Record<string, Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>>;
  };

  assert.equal(fixture.source.truthStatus, 'HISTORICAL_SNAPSHOT');
  assert.match(fixture.source.notice, /not a live/i);

  const fingerprints: string[] = [];
  for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'TSLA']) {
    const rows = fixture.barsBySymbol[symbol];
    assert.equal(rows.length, 3);
    assert.deepEqual([...rows].map(row => row.date), [...rows].map(row => row.date).sort());
    for (const row of rows) {
      assert.ok(row.low <= row.open && row.low <= row.close);
      assert.ok(row.high >= row.open && row.high >= row.close);
      assert.ok(row.volume >= 0);
    }
    fingerprints.push(JSON.stringify(rows));
  }
  assert.equal(new Set(fingerprints).size, 4);
});

test('bar integrity rejects a provider returning the wrong symbol or invalid OHLC', () => {
  const valid: StockBar = {
    symbol: 'AAPL', interval: '1d', timestampUtc: 1, tradingDate: '2026-03-03',
    open: 10, high: 11, low: 9, close: 10.5, volume: 100,
    vwap: 10, transactions: 1, adjusted: true, session: 'MARKET_SESSION_REGULAR', currency: 'USD', exchange: 'XNAS',
  };
  assert.doesNotThrow(() => assertStockBarSeriesIntegrity('AAPL', [valid]));
  assert.throws(() => assertStockBarSeriesIntegrity('AAPL', [{ ...valid, symbol: 'MSFT' }]), /requested AAPL/);
  assert.throws(() => assertStockBarSeriesIntegrity('AAPL', [{ ...valid, low: 12 }]), /OHLC invariant/);
});

test('the generated HTTP route preserves explicit disabled state and rejects an illegal symbol', async () => {
  const route = createMarketServiceRoutes(marketHandler, serverOptions)
    .find(candidate => candidate.path === '/api/market/v1/get-stock-bars');
  assert.ok(route);

  const disabled = await route.handler(new Request('https://local.test/api/market/v1/get-stock-bars?symbol=AAPL&interval=1d&range=1D'));
  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json() as { symbol: string; bars: unknown[]; provenance: { providerStatus: string } };
  assert.equal(disabledBody.symbol, 'AAPL');
  assert.deepEqual(disabledBody.bars, []);
  assert.equal(disabledBody.provenance.providerStatus, 'PROVIDER_STATUS_NOT_CONFIGURED');

  const invalid = await route.handler(new Request('https://local.test/api/market/v1/get-stock-bars?symbol=AAPL%3BDROP&interval=1d&range=1D'));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.text()), /valid equity ticker/);
});

test('every provider status has one front-end display mapping and only licensed real-time is live', () => {
  assert.deepEqual(Object.keys(PROVIDER_STATUS_DISPLAY).sort(), [...EXPECTED_PROVIDER_STATUSES].sort());
  for (const status of EXPECTED_PROVIDER_STATUSES) {
    assert.ok(PROVIDER_STATUS_DISPLAY[status].label);
    assert.equal(PROVIDER_STATUS_DISPLAY[status].isLive, status === 'PROVIDER_STATUS_REALTIME_LICENSED');
  }
});
