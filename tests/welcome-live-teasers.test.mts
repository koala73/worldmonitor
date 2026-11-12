// The welcome strip renders the committed weekly pulse first, then swaps each
// card for live data when its fetch succeeds. A card that never swaps shows
// "Published pulse <date>" under a "Live right now" heading, which a visitor
// reads as a stale site. On 2026-11-06 production answered every request with
// 200 and two of the four cards still never went live:
// - Markets: ^VIX is a commodities.json symbol, served by list-commodity-quotes.
//   The strip asked list-market-quotes, which answers NOT_FOUND, so the
//   all-twelve-symbols rule could never pass (the 2 Nov snapshot has 11 quotes).
// - Chokepoints: get-chokepoint-status flags upstreamUnavailable when any one
//   source is short for any one of the 13 rows. That is a coverage caveat on
//   rows computed in the last five minutes, not stale data.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  COMMODITY_QUOTE_SYMBOLS as FROZEN_COMMODITY_QUOTE_SYMBOLS,
  MARKET_QUOTE_SYMBOLS as FROZEN_MARKET_QUOTE_SYMBOLS,
} from '../scripts/freeze-crawlable-live-pulse.mjs';
import {
  COMMODITY_QUOTE_SYMBOLS,
  MARKET_QUOTE_SYMBOLS,
  QUOTE_SYMBOLS,
  fetchLiveTeasers,
} from '../pro-test/src/services/teasers.ts';

const MARKET_SYMBOLS = new Set(['^GSPC', '^IXIC']);
const COMMODITY_SYMBOLS = new Set(['^VIX', 'CL=F', 'BZ=F', 'GC=F', 'HG=F', 'NG=F', 'EURUSD=X', 'USDJPY=X']);

function quote(symbol: string) {
  return { symbol, display: symbol, price: 100, change: 1, sparkline: [1, 2, 3] };
}

function requested(url: URL, key: string): string[] {
  return url.searchParams.getAll(key);
}

type Overrides = { chokepoints?: Record<string, unknown> };

// Mirrors production on 2026-11-06: each quote endpoint returns only the
// symbols it serves and names the rest as NOT_FOUND.
function productionLikeFetch(overrides: Overrides = {}) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), 'https://www.worldmonitor.app');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    switch (url.pathname) {
      case '/api/wm-session':
        return json({ ok: true });
      case '/api/market/v1/list-market-quotes': {
        const symbols = requested(url, 'symbols');
        return json({
          quotes: symbols.filter(s => MARKET_SYMBOLS.has(s)).map(quote),
          rateLimited: false,
          unavailableSymbols: symbols.filter(s => !MARKET_SYMBOLS.has(s)).map(symbol => ({ symbol, reason: 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND' })),
        });
      }
      case '/api/market/v1/list-commodity-quotes':
        return json({ quotes: requested(url, 'symbols').filter(s => COMMODITY_SYMBOLS.has(s)).map(quote) });
      case '/api/market/v1/list-crypto-quotes':
        return json({ quotes: [quote('BTC'), quote('ETH')], provider: 'seed' });
      case '/api/supply-chain/v1/get-chokepoint-status':
        return json({
          chokepoints: [
            { name: 'Strait of Hormuz', status: 'red', disruptionScore: 80 },
            { name: 'Suez Canal', status: 'yellow', disruptionScore: 40 },
            { name: 'Panama Canal', status: 'green', disruptionScore: 5 },
          ],
          fetchedAt: new Date().toISOString(),
          upstreamUnavailable: true,
          ...overrides.chokepoints,
        });
      default:
        return new Response('{}', { status: 503 });
    }
  };
}

describe('welcome strip upgrades to live data', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = productionLikeFetch() as typeof fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('asks each quote endpoint only for the symbols it serves', () => {
    assert.deepEqual([...MARKET_QUOTE_SYMBOLS].sort(), [...MARKET_SYMBOLS].sort());
    assert.ok(COMMODITY_QUOTE_SYMBOLS.includes('^VIX'), 'VIX is a commodities.json symbol');
    assert.deepEqual(
      [...MARKET_QUOTE_SYMBOLS, ...COMMODITY_QUOTE_SYMBOLS, 'BTC', 'ETH'].sort(),
      [...QUOTE_SYMBOLS].sort(),
      'every strip symbol is requested from exactly one endpoint',
    );
  });

  it('the weekly freeze asks the same endpoints for the same symbols', () => {
    assert.deepEqual(FROZEN_MARKET_QUOTE_SYMBOLS, MARKET_QUOTE_SYMBOLS);
    assert.deepEqual(FROZEN_COMMODITY_QUOTE_SYMBOLS, COMMODITY_QUOTE_SYMBOLS);
  });

  it('shows the market tape as live when production serves every symbol', async () => {
    const state = await fetchLiveTeasers();
    assert.equal(state.quotes.live, true);
    assert.deepEqual(state.quotes.items.map(q => q.symbol), [...QUOTE_SYMBOLS]);
  });

  it('shows freshly computed chokepoints as live even when one source is short', async () => {
    const state = await fetchLiveTeasers();
    assert.equal(state.chokepoints.live, true);
    assert.equal(state.chokepoints.total, 3);
    assert.equal(state.chokepoints.disrupted, 2);
    assert.equal(state.chokepoints.items[0].name, 'Strait of Hormuz');
  });

  it('keeps the published snapshot when the chokepoint rows are old', async () => {
    globalThis.fetch = productionLikeFetch({
      chokepoints: { fetchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
    }) as typeof fetch;
    const state = await fetchLiveTeasers();
    assert.equal(state.chokepoints.live, false);
  });

  it('keeps the published snapshot when no chokepoint rows come back', async () => {
    globalThis.fetch = productionLikeFetch({ chokepoints: { chokepoints: [] } }) as typeof fetch;
    const state = await fetchLiveTeasers();
    assert.equal(state.chokepoints.live, false);
  });
});
