import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  mergeLastGoodQuotes,
  planYahooRefresh,
  resolveMergedQuotesAsOf,
} = require('../scripts/shared/market-quote-refresh.cjs');

describe('market quote refresh resilience', () => {
  it('retains last-good rows when a refresh succeeds for only part of the basket', () => {
    const previous = [
      { symbol: 'AAPL', price: 100 },
      { symbol: '^HSI', price: 24000 },
      { symbol: 'REMOVED', price: 1 },
    ];
    const fresh = [
      { symbol: 'AAPL', price: 101 },
      { symbol: '000001.SS', price: 3500 },
    ];

    assert.deepEqual(
      mergeLastGoodQuotes(['AAPL', '^HSI', '000001.SS'], fresh, previous),
      [
        { symbol: 'AAPL', price: 101 },
        { symbol: '^HSI', price: 24000 },
        { symbol: '000001.SS', price: 3500 },
      ],
    );
  });

  it('refreshes Yahoo candidates only when the bounded cadence is due', () => {
    const args = {
      mandatoryYahooSymbols: ['^GSPC', '^HSI'],
      missedPrimarySymbols: ['AAPL'],
      refreshIntervalMs: 15 * 60_000,
    };

    assert.deepEqual(planYahooRefresh({ ...args, nowMs: 1_000_000, lastRefreshAt: 0 }), {
      due: true,
      symbols: ['^GSPC', '^HSI', 'AAPL'],
    });
    assert.deepEqual(planYahooRefresh({ ...args, nowMs: 1_300_000, lastRefreshAt: 1_000_000 }), {
      due: false,
      symbols: [],
    });
    assert.deepEqual(planYahooRefresh({ ...args, nowMs: 1_900_000, lastRefreshAt: 1_000_000 }), {
      due: true,
      symbols: ['^GSPC', '^HSI', 'AAPL'],
    });
  });

  it('deduplicates Yahoo candidates shared by mandatory and fallback paths', () => {
    assert.deepEqual(planYahooRefresh({
      mandatoryYahooSymbols: ['^GSPC', 'AAPL'],
      missedPrimarySymbols: ['AAPL', 'MSFT'],
      nowMs: 10,
      lastRefreshAt: 0,
      refreshIntervalMs: 100,
    }).symbols, ['^GSPC', 'AAPL', 'MSFT']);
  });

  it('does not stamp a fresh asOf when last-good quotes were retained', () => {
    const previousAsOf = '2026-08-31T12:00:00.000Z';
    const fresh = [{ symbol: 'QQQ', price: 714 }];
    const merged = mergeLastGoodQuotes(
      ['NQ=F', 'QQQ', '^VXN', '^TNX'],
      fresh,
      [
        { symbol: 'NQ=F', price: 29400 },
        { symbol: 'QQQ', price: 710 },
        { symbol: '^VXN', price: 20 },
        { symbol: '^TNX', price: 4.2 },
      ],
    );

    assert.equal(
      resolveMergedQuotesAsOf(fresh, merged, previousAsOf, Date.parse('2026-08-31T18:00:00.000Z')),
      previousAsOf,
    );
    assert.equal(resolveMergedQuotesAsOf(fresh, merged, undefined, Date.parse('2026-08-31T18:00:00.000Z')), '');
  });

  it('stamps fetchedAt as asOf only when every published quote is from this refresh', () => {
    const fetchedAt = Date.parse('2026-08-31T18:00:00.000Z');
    const fresh = [
      { symbol: 'NQ=F', price: 29400 },
      { symbol: 'QQQ', price: 714 },
    ];
    assert.equal(
      resolveMergedQuotesAsOf(fresh, fresh, '2026-08-31T12:00:00.000Z', fetchedAt),
      '2026-08-31T18:00:00.000Z',
    );
  });

  it('wires last-good merging into both market publishers', () => {
    const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    const standalone = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

    assert.match(relay, /previousPayloadPromise = envelopeRead\('market:stocks-bootstrap:v1'\)/);
    assert.match(relay, /mergeLastGoodQuotes\(MARKET_SYMBOLS, freshQuotes, previousQuotes\)/);
    assert.match(relay, /resolveMergedQuotesAsOf\(freshQuotes, quotes, previousPayload\?\.asOf, fetchedAt\)/);
    assert.match(standalone, /resolveMergedQuotesAsOf\(quotes, mergedQuotes, previousPayload\?\.asOf, fetchedAt\)/);
    assert.match(standalone, /previousPayloadPromise = readSeedSnapshot\(CANONICAL_KEY\)/);
    assert.match(standalone, /mergeLastGoodQuotes\(MARKET_SYMBOLS, quotes, previousQuotes\)/);
    assert.match(compose, /MARKET_YAHOO_REFRESH_INTERVAL_MS:/);
    assert.match(envExample, /MARKET_YAHOO_REFRESH_INTERVAL_MS=/);
  });
});
