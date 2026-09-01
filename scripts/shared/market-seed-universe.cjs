'use strict';

/**
 * Shared market-quote seed universe for the standalone seeder and Railway relay.
 *
 * `symbols` remains the Markets catalog. `auxiliarySymbols` is the NQ context
 * basket: seeders fetch both, default dashboard hydration stays on
 * `defaultSymbols` / catalog only, and seed-coverage validation ignores
 * auxiliary misses so a missing VXN cannot fail an otherwise healthy refresh.
 */

function uniquePreserveOrder(symbols) {
  const seen = new Set();
  const out = [];
  for (const symbol of symbols) {
    if (typeof symbol !== 'string' || !symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

function loadMarketSeedUniverse(stocksConfig) {
  const catalogEntries = Array.isArray(stocksConfig?.symbols) ? stocksConfig.symbols : [];
  const catalogSymbols = catalogEntries.map((entry) => entry.symbol).filter(Boolean);
  const defaultSymbols = Array.isArray(stocksConfig?.defaultSymbols)
    ? [...stocksConfig.defaultSymbols]
    : [];
  const auxiliaryEntries = Array.isArray(stocksConfig?.auxiliarySymbols)
    ? stocksConfig.auxiliarySymbols
    : [];
  const auxiliarySymbols = auxiliaryEntries.map((entry) => (
    typeof entry === 'string' ? entry : entry?.symbol
  )).filter(Boolean);

  const allSymbols = uniquePreserveOrder([...catalogSymbols, ...auxiliarySymbols]);
  const metaBySymbol = new Map();
  for (const entry of catalogEntries) {
    if (!entry?.symbol) continue;
    metaBySymbol.set(entry.symbol, { name: entry.name, display: entry.display });
  }
  for (const entry of auxiliaryEntries) {
    if (typeof entry !== 'object' || !entry?.symbol) continue;
    metaBySymbol.set(entry.symbol, { name: entry.name, display: entry.display });
  }

  return {
    catalogSymbols,
    defaultSymbols,
    auxiliarySymbols,
    allSymbols,
    metaBySymbol,
    coverageExpectedCount: catalogSymbols.length,
  };
}

function countCatalogFreshQuotes(quotes, catalogSymbols) {
  const catalog = new Set(catalogSymbols);
  if (!Array.isArray(quotes)) return 0;
  return quotes.filter((quote) => quote && catalog.has(quote.symbol)).length;
}

module.exports = {
  uniquePreserveOrder,
  loadMarketSeedUniverse,
  countCatalogFreshQuotes,
};
