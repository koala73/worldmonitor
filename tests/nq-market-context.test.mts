import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUXILIARY_STOCK_CATALOG, MARKET_SYMBOLS, STOCK_CATALOG } from '../src/config/markets.ts';
import {
  NQ_PULSE_BASKET,
  NQ_PULSE_DISCLOSURE,
  NQ_PULSE_ORDER,
  NQ_PULSE_UNITS,
} from '../src/config/nq-context.ts';
import {
  composeNqPulseHtml,
  freshnessLabelForAsOf,
  nqPulseAsOfLabel,
  orderNqPulseRows,
} from '../src/components/nq-pulse-content.ts';
import { filterMarketQuotes } from '../server/worldmonitor/market/v1/list-market-quotes.ts';
import { resolveEffectiveMarketWatchlist } from '../src/services/market-watchlist.ts';
import type { MarketData } from '../src/types/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  loadMarketSeedUniverse,
  countCatalogFreshQuotes,
} = require('../scripts/shared/market-seed-universe.cjs') as {
  loadMarketSeedUniverse: (config: unknown) => {
    catalogSymbols: string[];
    defaultSymbols: string[];
    auxiliarySymbols: string[];
    allSymbols: string[];
    coverageExpectedCount: number;
  };
  countCatalogFreshQuotes: (quotes: Array<{ symbol: string }>, catalogSymbols: string[]) => number;
};

const AUX_SYMBOLS = ['NQ=F', 'QQQ', '^VXN', '^TNX'] as const;
const stocks = JSON.parse(readFileSync(resolve(root, 'shared/stocks.json'), 'utf8'));
const railwayStocks = JSON.parse(readFileSync(resolve(root, 'scripts/shared/stocks.json'), 'utf8'));
const universe = loadMarketSeedUniverse(stocks);

function quote(
  symbol: string,
  overrides: Partial<MarketData> = {},
): MarketData {
  return {
    symbol,
    name: symbol,
    display: symbol,
    price: 100,
    change: 1,
    sparkline: [99, 100],
    ...overrides,
  };
}

describe('NQ auxiliary quote basket', () => {
  it('keeps the browser and Railway stock configs identical', () => {
    assert.deepEqual(railwayStocks, stocks);
  });

  it('labels ^IXIC as NASDAQ Composite / COMP', () => {
    const ixic = STOCK_CATALOG.find((entry) => entry.symbol === '^IXIC');
    assert.ok(ixic);
    assert.equal(ixic.name, 'NASDAQ Composite');
    assert.equal(ixic.display, 'COMP');
  });

  it('keeps auxiliary NQ instruments out of the Markets catalog and defaults', () => {
    for (const symbol of AUX_SYMBOLS) {
      assert.ok(!STOCK_CATALOG.some((entry) => entry.symbol === symbol), `${symbol} must not be a catalog default`);
      assert.ok(!MARKET_SYMBOLS.some((entry) => entry.symbol === symbol), `${symbol} must not hydrate Markets`);
      assert.ok(universe.auxiliarySymbols.includes(symbol), `${symbol} must be auxiliary`);
      assert.ok(universe.allSymbols.includes(symbol), `${symbol} must be seeded`);
      assert.ok(stocks.yahooOnly.includes(symbol), `${symbol} must stay Yahoo-only`);
    }
    assert.equal(STOCK_CATALOG.length, 93);
    assert.equal(universe.coverageExpectedCount, universe.catalogSymbols.length);
    assert.deepEqual(universe.auxiliarySymbols, [...AUX_SYMBOLS]);
  });

  it('derives both seed paths from catalog plus auxiliary symbols without duplicates', () => {
    const standalone = readFileSync(resolve(root, 'scripts/seed-market-quotes.mjs'), 'utf8');
    const relay = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
    assert.match(standalone, /allSymbols: MARKET_SYMBOLS/);
    assert.match(relay, /const MARKET_SYMBOLS = _stockUniverse\.allSymbols/);
    assert.match(relay, /const MARKET_AUXILIARY_SYMBOLS = _stockUniverse\.auxiliarySymbols/);
    assert.match(relay, /everyCycleSymbols: MARKET_AUXILIARY_SYMBOLS\.filter\(\(s\) => YAHOO_ONLY\.has\(s\)\)/);
    assert.equal(new Set(universe.allSymbols).size, universe.allSymbols.length);
    assert.deepEqual(
      universe.allSymbols.slice(universe.catalogSymbols.length),
      [...AUX_SYMBOLS],
    );
  });

  it('does not fail seed coverage when an auxiliary quote is missing', () => {
    const quotes = universe.catalogSymbols.map((symbol) => ({ symbol }));
    assert.equal(countCatalogFreshQuotes(quotes, universe.catalogSymbols), universe.catalogSymbols.length);
    const withoutVxn = quotes.filter((quote) => quote.symbol !== '^VXN');
    assert.equal(countCatalogFreshQuotes(withoutVxn, universe.catalogSymbols), universe.catalogSymbols.length);
  });

  it('keeps Yahoo staggering at least 150 ms on both seed paths', () => {
    const standalone = readFileSync(resolve(root, 'scripts/seed-market-quotes.mjs'), 'utf8');
    const relay = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
    assert.match(standalone, /const YAHOO_DELAY_MS = 200/);
    assert.match(standalone, /yahooDelayMs: YAHOO_DELAY_MS/);
    assert.match(relay, /await sleep\(150\);/);
  });

  it('preserves asOf when a symbols-filtered RPC request returns only requested quotes', () => {
    const asOf = '2026-08-31T18:00:00.000Z';
    const filtered = filterMarketQuotes({
      quotes: [
        { symbol: 'QQQ', name: 'Invesco QQQ', display: 'QQQ', price: 500, change: 0.4, sparkline: [] },
        { symbol: 'NQ=F', name: 'E-mini Nasdaq-100', display: 'NQ', price: 21000, change: -0.2, sparkline: [] },
        { symbol: '^GSPC', name: 'S&P 500', display: 'SPX', price: 5600, change: 0.1, sparkline: [] },
      ],
      finnhubSkipped: false,
      skipReason: '',
      rateLimited: false,
      unavailableSymbols: [],
      asOf,
    }, ['NQ=F', 'QQQ']);

    assert.deepEqual(filtered.quotes.map((entry) => entry.symbol), ['NQ=F', 'QQQ']);
    assert.equal(filtered.asOf, asOf);
  });

  it('excludes auxiliary symbols from default Markets hydration', () => {
    const resolved = resolveEffectiveMarketWatchlist(STOCK_CATALOG, MARKET_SYMBOLS, null, []);
    for (const symbol of AUX_SYMBOLS) {
      assert.ok(!resolved.symbols.some((entry) => entry.symbol === symbol), `${symbol} leaked into Markets`);
    }
  });
});

describe('NQ Pulse rendering', () => {
  it('renders NQ, QQQ, VXN, and US 10Y in that order regardless of RPC order', () => {
    assert.deepEqual([...NQ_PULSE_ORDER], ['NQ=F', 'QQQ', '^VXN', '^TNX']);
    assert.deepEqual(NQ_PULSE_BASKET.map((entry) => entry.display), ['NQ', 'QQQ', 'VXN', 'US 10Y']);
    const rows = orderNqPulseRows([
      quote('^TNX', { price: 4.2, change: 0.01 }),
      quote('QQQ', { price: 500, change: 0.4 }),
      quote('NQ=F', { price: 21000, change: -0.2 }),
      quote('^VXN', { price: 18, change: 1.1 }),
    ]);
    assert.deepEqual(rows.map((row) => row.display), ['NQ', 'QQQ', 'VXN', 'US 10Y']);
    assert.ok(rows.every((row) => row.kind === 'quote'));
  });

  it('renders each NQ instrument in its declared unit', () => {
    assert.deepEqual(NQ_PULSE_UNITS, {
      'NQ=F': 'points',
      QQQ: 'currency',
      '^VXN': 'points',
      '^TNX': 'percent',
    });
    const html = composeNqPulseHtml({
      rows: orderNqPulseRows([
        quote('NQ=F', { price: 21000, change: -0.2 }),
        quote('QQQ', { price: 500, change: 0.4 }),
        quote('^VXN', { price: 18, change: 1.1 }),
        quote('^TNX', { price: 4.2, change: 0.01 }),
      ]),
      freshness: 'Current',
      asOfLabel: 'As of 2026-08-31T18:00:00.000Z',
    });
    const prices = [...html.matchAll(/<span class="market-price">([^<]+)<\/span>/g)]
      .map((match) => match[1]);
    assert.deepEqual(prices, ['21,000', '$500.00', '18.00', '4.20%']);
  });

  it('keeps peers visible when one instrument is unavailable', () => {
    const rows = orderNqPulseRows([
      quote('NQ=F', { price: 21000, change: -0.2 }),
      quote('QQQ', { price: 500, change: 0.4 }),
      quote('^TNX', { price: 4.2, change: 0.01 }),
    ]);
    assert.equal(rows[0]?.kind, 'quote');
    assert.equal(rows[1]?.kind, 'quote');
    assert.equal(rows[2]?.kind, 'unavailable');
    assert.equal(rows[2]?.display, 'VXN');
    assert.equal(rows[3]?.kind, 'quote');
    const html = composeNqPulseHtml({
      rows,
      freshness: 'Current',
      asOfLabel: 'As of 2026-08-31T18:00:00.000Z',
    });
    assert.match(html, /Unavailable/);
    assert.match(html, />NQ</);
    assert.match(html, />QQQ</);
    assert.doesNotMatch(html, /bullish|bearish|entry|stop|target|buy|sell/i);
  });

  it('labels freshness at the 10-minute and 30-minute boundaries', () => {
    const now = Date.parse('2026-08-31T18:00:00.000Z');
    assert.equal(freshnessLabelForAsOf('2026-08-31T17:50:00.000Z', now), 'Current');
    assert.equal(freshnessLabelForAsOf('2026-08-31T17:49:59.000Z', now), 'Delayed');
    assert.equal(freshnessLabelForAsOf('2026-08-31T17:30:00.000Z', now), 'Delayed');
    assert.equal(freshnessLabelForAsOf('2026-08-31T17:29:59.000Z', now), 'Stale');
  });

  it('never labels missing or invalid asOf as Current', () => {
    const now = Date.parse('2026-08-31T18:00:00.000Z');
    for (const asOf of [undefined, '', 'not-a-date', '2026-08-31T18:01:00.000Z']) {
      assert.equal(freshnessLabelForAsOf(asOf, now), 'Freshness unavailable');
      assert.equal(nqPulseAsOfLabel(asOf, 'Freshness unavailable'), 'As of: Freshness unavailable');
    }
  });

  it('keeps the non-execution disclosure on empty and stale states', () => {
    const rows = orderNqPulseRows([]);
    assert.ok(rows.every((row) => row.kind === 'unavailable'));
    const html = composeNqPulseHtml({
      rows,
      freshness: 'Stale',
      asOfLabel: nqPulseAsOfLabel('2026-08-31T17:20:00.000Z', 'Stale'),
    });
    assert.ok(html.includes(NQ_PULSE_DISCLOSURE));
    assert.match(html, />Stale</);
    assert.doesNotMatch(html, /execution-grade prices|real[- ]time tape/i);
  });

  it('ignores late responses after the pulse and catalysts panels are destroyed', () => {
    const pulse = readFileSync(resolve(root, 'src/components/NqPulsePanel.ts'), 'utf8');
    const catalysts = readFileSync(resolve(root, 'src/components/NqCatalystsPanel.ts'), 'utf8');
    assert.match(pulse, /this\.signal\.aborted/);
    assert.match(pulse, /LatestRequestGuard/);
    assert.match(pulse, /createTimeoutSignal/);
    assert.match(catalysts, /LatestRequestGuard/);
    assert.match(catalysts, /createTimeoutSignal/);
  });
});
