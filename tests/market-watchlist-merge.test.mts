/**
 * #6305 regression: the custom-watchlist cap must bound the CUSTOM entries,
 * not the merged default-plus-custom array.
 *
 * `src/app/data-loader.ts` used to stop merging once the merged array reached
 * 50. The default universe (`shared/stocks.json`) already carries 59 symbols,
 * so the very first custom ticker pushed the array past the bound and every
 * remaining pick was silently dropped — the watchlist editor happily stored up
 * to 50 tickers and told the user each one was tracked.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MARKET_WATCHLIST_MAX_ENTRIES,
  mergeWatchlistSymbols,
  normalizeWatchlistEntries,
  resolveEffectiveMarketWatchlist,
  type MarketSymbolMeta,
} from '../src/services/market-watchlist.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STOCK_CONFIG = JSON.parse(readFileSync(resolve(root, 'shared/stocks.json'), 'utf8')) as {
  symbols: MarketSymbolMeta[];
  defaultSymbols: string[];
};
const CATALOG_BY_SYMBOL = new Map(STOCK_CONFIG.symbols.map((entry) => [entry.symbol, entry]));
const DEFAULTS: MarketSymbolMeta[] = STOCK_CONFIG.defaultSymbols.map((symbol) => CATALOG_BY_SYMBOL.get(symbol)!);

const custom = (symbol: string) => ({ symbol, name: `${symbol} Inc`, display: symbol });

describe('mergeWatchlistSymbols', () => {
  it('keeps the default universe larger than the custom cap (the regression precondition)', () => {
    assert.equal(DEFAULTS.length, 59, 'catalog customization must preserve current main defaults');
    assert.ok(
      DEFAULTS.length > MARKET_WATCHLIST_MAX_ENTRIES,
      `this regression only exists because the ${DEFAULTS.length} defaults exceed the ${MARKET_WATCHLIST_MAX_ENTRIES} cap`,
    );
  });

  it('forwards every custom ticker even though the defaults already exceed the cap', () => {
    const merged = mergeWatchlistSymbols(DEFAULTS, [custom('RIVN'), custom('PLTR'), custom('SOFI')]);

    assert.equal(merged.length, DEFAULTS.length + 3);
    assert.deepEqual(merged.slice(DEFAULTS.length).map((s) => s.symbol), ['RIVN', 'PLTR', 'SOFI']);
  });

  it('bounds the custom entries at the cap rather than the merged length', () => {
    const many = Array.from({ length: MARKET_WATCHLIST_MAX_ENTRIES + 12 }, (_, i) => custom(`SYM${i}`));
    const merged = mergeWatchlistSymbols(DEFAULTS, many);

    assert.equal(merged.length, DEFAULTS.length + MARKET_WATCHLIST_MAX_ENTRIES);
    assert.equal(merged.at(-1)?.symbol, `SYM${MARKET_WATCHLIST_MAX_ENTRIES - 1}`);
  });

  it('does not spend cap budget on a custom entry that duplicates a default', () => {
    const duplicate = DEFAULTS[3]!.symbol;
    const many = [
      custom(duplicate),
      ...Array.from({ length: MARKET_WATCHLIST_MAX_ENTRIES }, (_, i) => custom(`SYM${i}`)),
    ];
    const merged = mergeWatchlistSymbols(DEFAULTS, many);

    assert.equal(merged.length, DEFAULTS.length + MARKET_WATCHLIST_MAX_ENTRIES);
    assert.equal(merged.filter((s) => s.symbol === duplicate).length, 1);
  });

  it('preserves default order first, then custom order, and falls back to the symbol for labels', () => {
    const merged = mergeWatchlistSymbols(DEFAULTS, [{ symbol: 'NET' }, custom('DDOG')]);

    assert.deepEqual(merged.slice(0, DEFAULTS.length), DEFAULTS);
    assert.deepEqual(merged[DEFAULTS.length], { symbol: 'NET', name: 'NET', display: 'NET' });
    assert.equal(merged[DEFAULTS.length + 1]?.symbol, 'DDOG');
  });

  it('returns the defaults untouched when there are no custom entries', () => {
    assert.deepEqual(mergeWatchlistSymbols(DEFAULTS, []), DEFAULTS);
  });
});

describe('normalizeWatchlistEntries', () => {
  it('trims, de-dupes, and caps at the shared limit', () => {
    const entries = normalizeWatchlistEntries([
      { symbol: ' AA PL ', name: '  Apple  ' },
      { symbol: 'AAPL' },
      ...Array.from({ length: MARKET_WATCHLIST_MAX_ENTRIES + 5 }, (_, i) => custom(`SYM${i}`)),
    ]);

    assert.equal(entries.length, MARKET_WATCHLIST_MAX_ENTRIES);
    assert.deepEqual(entries[0], { symbol: 'AAPL', name: 'Apple' });
    assert.equal(entries[1]?.symbol, 'SYM0');
  });

  it('drops entries without a usable symbol', () => {
    assert.deepEqual(normalizeWatchlistEntries([{ symbol: '   ' }, { symbol: 'TSLA' }]), [{ symbol: 'TSLA' }]);
  });
});

describe('resolveEffectiveMarketWatchlist', () => {
  it('uses all 59 defaults in current-main order when no valid selection exists', () => {
    const resolved = resolveEffectiveMarketWatchlist(STOCK_CONFIG.symbols, DEFAULTS, ['INVALID'], []);
    assert.equal(resolved.usesCatalogSelection, false);
    assert.deepEqual(resolved.symbols.map((entry) => entry.symbol), STOCK_CONFIG.defaultSymbols);
  });

  it('preserves the selected catalog subset order and ignores invalid duplicates', () => {
    const resolved = resolveEffectiveMarketWatchlist(
      STOCK_CONFIG.symbols,
      DEFAULTS,
      ['SAP', 'INVALID', 'AAPL', 'SAP', '^FTSE'],
      [],
    );
    assert.equal(resolved.usesCatalogSelection, true);
    assert.deepEqual(resolved.symbols.map((entry) => entry.symbol), ['SAP', 'AAPL', '^FTSE']);
  });

  it('appends normalized custom entries without duplicating the selected base', () => {
    const resolved = resolveEffectiveMarketWatchlist(
      STOCK_CONFIG.symbols,
      DEFAULTS,
      ['AAPL', 'SAP'],
      [{ symbol: ' AAPL ' }, { symbol: 'PLTR', name: ' Palantir ' }, { symbol: 'PLTR' }],
    );
    assert.deepEqual(resolved.symbols.map((entry) => entry.symbol), ['AAPL', 'SAP', 'PLTR']);
    assert.deepEqual(resolved.customEntries, [{ symbol: 'AAPL' }, { symbol: 'PLTR', name: 'Palantir' }]);
  });

  it('caps additive custom entries independently of the selected catalog base', () => {
    const customEntries = Array.from({ length: 60 }, (_, index) => custom(`CUSTOM${index}`));
    const resolved = resolveEffectiveMarketWatchlist(STOCK_CONFIG.symbols, DEFAULTS, ['SAP'], customEntries);
    assert.equal(resolved.symbols.length, 1 + MARKET_WATCHLIST_MAX_ENTRIES);
    assert.equal(resolved.symbols.at(-1)?.symbol, 'CUSTOM49');
  });
});
