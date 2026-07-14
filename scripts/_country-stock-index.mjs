export const CHINA_COUNTRY_STOCK_INDEX_KEY = 'market:stock-index:v1:CN';

export function buildCountryStockIndexSnapshot(chart, fetchedAt = new Date().toISOString()) {
  const result = chart?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close?.filter((value) => Number.isFinite(value));
  if (!Array.isArray(closes) || closes.length < 2) return null;

  const weekly = closes.slice(-6);
  const latest = weekly.at(-1);
  const oldest = weekly[0];
  if (!Number.isFinite(latest) || !Number.isFinite(oldest) || oldest === 0) return null;

  return {
    available: true,
    code: 'CN',
    symbol: '000001.SS',
    indexName: 'SSE Composite',
    price: +latest.toFixed(2),
    weekChangePercent: +(((latest - oldest) / oldest) * 100).toFixed(2),
    currency: result.meta?.currency || 'CNY',
    fetchedAt,
  };
}
