import { readFileSync } from 'node:fs';

import { countryStockIndexKey } from './_country-stock-index.mjs';

/**
 * The whole-enum work-list, kept OUT of `_country-stock-index.mjs` on purpose.
 *
 * `scripts/ais-relay.cjs` imports that module for the CN key and the snapshot
 * builder, and it never needs this list. Putting the `readFileSync` there would
 * add `shared/openapi-filter-param-contracts.json` to the relay's Railway
 * runtime-dependency closure (tests/railway-watch-path-audit.test.mjs), forcing
 * the always-on relay to redeploy every time an unrelated country entry
 * changes. Seeder-only concerns belong in a seeder-only module.
 */

/**
 * The public country enum is the single source of truth for which countries the
 * RPC will answer, so the seeder derives its work-list from the same file
 * rather than keeping a parallel copy that could drift.
 *
 * @returns {Array<{ code: string, symbol: string, name: string }>}
 */
export function loadCountryStockIndexes() {
  const raw = JSON.parse(
    readFileSync(new URL('../shared/openapi-filter-param-contracts.json', import.meta.url), 'utf8'),
  );
  const contracts = raw?.marketCountryStockIndexes;
  if (!contracts || typeof contracts !== 'object') {
    throw new Error('marketCountryStockIndexes missing from openapi-filter-param-contracts.json');
  }
  return Object.entries(contracts)
    .filter(([, index]) => index?.symbol && index?.name)
    .map(([code, index]) => ({ code, symbol: index.symbol, name: index.name }));
}

/** Redis keys Railway owns for the whole enum. */
export function loadCountryStockIndexKeys() {
  return loadCountryStockIndexes().map(index => countryStockIndexKey(index.code));
}
