// Deliberately free of filesystem reads. scripts/ais-relay.cjs imports this
// module, and every file this module touches joins the relay's Railway
// runtime-dependency closure. The whole-enum work-list lives in
// ./_country-stock-index-registry.mjs for that reason.

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
