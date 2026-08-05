import { readFileSync } from 'node:fs';

/** Redis key Railway owns for a country's audit-backed index snapshot. */
export function countryStockIndexKey(code) {
  return `market:stock-index:v1:${code}`;
}

/**
 * China stays a named export because the AIS relay writes it on its own
 * cadence (fresh Yahoo chart alongside the live quote stream), separately from
 * the market seeder's whole-enum pass.
 */
export const CHINA_COUNTRY_STOCK_INDEX = Object.freeze({
  code: 'CN',
  symbol: '000001.SS',
  name: 'SSE Composite',
});
export const CHINA_COUNTRY_STOCK_INDEX_KEY = countryStockIndexKey('CN');

/**
 * The public country enum is the single source of truth for which countries
 * the RPC will answer, so the seeder derives its work-list from the same file
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

export function buildCountryStockIndexSnapshotFromCloses(
  closes,
  currency = 'CNY',
  fetchedAt = new Date().toISOString(),
  index = CHINA_COUNTRY_STOCK_INDEX,
) {
  const finiteCloses = Array.isArray(closes) ? closes.filter((value) => Number.isFinite(value)) : [];
  if (finiteCloses.length < 2) return null;

  const weekly = finiteCloses.slice(-6);
  const latest = weekly.at(-1);
  const oldest = weekly[0];
  if (!Number.isFinite(latest) || !Number.isFinite(oldest) || oldest === 0) return null;

  return {
    available: true,
    code: index.code,
    symbol: index.symbol,
    indexName: index.name,
    price: +latest.toFixed(2),
    weekChangePercent: +(((latest - oldest) / oldest) * 100).toFixed(2),
    currency,
    fetchedAt,
  };
}

export function buildCountryStockIndexSnapshot(
  chart,
  fetchedAt = new Date().toISOString(),
  index = CHINA_COUNTRY_STOCK_INDEX,
) {
  const result = chart?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close?.filter((value) => Number.isFinite(value));
  return buildCountryStockIndexSnapshotFromCloses(closes, result?.meta?.currency || 'CNY', fetchedAt, index);
}
