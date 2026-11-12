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
 * Entries carrying `unavailable` stay in the enum (the RPC still validates and
 * answers them) but are excluded from the seed work-list: their symbol is one
 * Yahoo cannot serve (#6240), so fetching it every run only burns the Yahoo
 * gate and pads the failure log. `loadUnavailableCountryStockIndexes()` lists
 * them for the audit script that decides when a flag can be lifted.
 *
 * Entries carrying `source: 'moex-iss'` are served by the Moscow Exchange ISS
 * API instead of Yahoo (#6153): Yahoo stopped serving MOEX data after 2022,
 * ISS is keyless and 15-minute delayed. The seeder routes them to that
 * provider; the audit and the RPC's live Yahoo fallback skip them.
 *
 * @returns {Array<{ code: string, symbol: string, name: string, source?: string }>}
 */
export function loadCountryStockIndexes() {
  return loadDeclaredCountryStockIndexes().filter(index => !index.unavailable);
}

/** Entries the Yahoo-backed audit can probe: serviceable and Yahoo-sourced. */
export function loadYahooCountryStockIndexes() {
  return loadCountryStockIndexes().filter(index => !index.source || index.source === 'yahoo');
}

/**
 * @returns {Array<{ code: string, symbol: string, name: string, unavailable: { checked: string, reason: string } }>}
 */
export function loadUnavailableCountryStockIndexes() {
  return loadDeclaredCountryStockIndexes().filter(index => index.unavailable);
}

/** Every declared country, serviceable or not, in enum order. */
export function loadDeclaredCountryStockIndexes() {
  const raw = JSON.parse(
    readFileSync(new URL('../shared/openapi-filter-param-contracts.json', import.meta.url), 'utf8'),
  );
  const contracts = raw?.marketCountryStockIndexes;
  if (!contracts || typeof contracts !== 'object') {
    throw new Error('marketCountryStockIndexes missing from openapi-filter-param-contracts.json');
  }
  return Object.entries(contracts)
    .filter(([, index]) => index?.symbol && index?.name)
    .map(([code, index]) => ({
      code,
      symbol: index.symbol,
      name: index.name,
      ...(index.unavailable ? { unavailable: index.unavailable } : {}),
      ...(index.source ? { source: index.source } : {}),
    }));
}

/** Redis keys Railway owns for the whole seedable enum. */
export function loadCountryStockIndexKeys() {
  return loadCountryStockIndexes().map(index => countryStockIndexKey(index.code));
}
