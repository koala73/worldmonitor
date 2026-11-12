// @ts-check
//
// Moscow Exchange ISS leg of the country stock-index seeder (#6153).
//
// Yahoo Finance stopped serving MOEX data after 2022, so the RU entry in the
// public country enum was flagged `unavailable` (#6240). ISS is the exchange's
// own API: keyless, no registration, 15-minute delayed, UTF-8 JSON. The
// endpoints return columnar `{ columns, data }` tables, so every cell
// is read by column NAME, never by position, and an upstream column insertion
// cannot shift a field silently.
//
// Deliberately free of filesystem reads, like _country-stock-index.mjs, and
// free of network calls: the seeder injects fetch so this stays unit-testable.

import { buildCountryStockIndexSnapshotFromCloses } from './_country-stock-index.mjs';

export const MOEX_SOURCE = 'moex-iss';
export const MOEX_CURRENCY = 'RUB';
export const MOEX_HISTORY_DAYS = 45; // enough trading days for the 6-close weekly window across holidays
export const MOEX_USER_AGENT = 'WorldMonitor country-index seeder (+https://worldmonitor.app)';
const MOEX_ISS_ORIGIN = 'https://iss.moex.com';
const MOEX_TIMEOUT_MS = 15_000;

/** @param {string} symbol @param {Date} [now] */
export function moexHistoryUrl(symbol, now = new Date()) {
  const from = new Date(now.getTime() - MOEX_HISTORY_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const till = now.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    'iss.meta': 'off',
    'iss.only': 'history',
    'history.columns': 'TRADEDATE,CLOSE',
    from,
    till,
  });
  return `${MOEX_ISS_ORIGIN}/iss/history/engines/stock/markets/index/securities/${encodeURIComponent(symbol)}.json?${params.toString()}`;
}

/** @param {unknown} payload @param {string} name */
function moexTable(payload, name) {
  if (!payload || typeof payload !== 'object') return null;
  const table = /** @type {Record<string, unknown>} */ (payload)[name];
  if (!table || typeof table !== 'object' || !('columns' in table) || !('data' in table)) return null;
  if (!Array.isArray(table.columns) || !Array.isArray(table.data)) return null;
  return { columns: table.columns, data: table.data };
}

/** @param {unknown} value */
function positivePrice(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    && Number.isFinite(Number(value)) && Number(value) > 0;
}

/** @param {unknown} payload @param {string} [beforeDate] @returns {number[]} */
export function parseMoexHistoryCloses(payload, beforeDate) {
  const history = moexTable(payload, 'history');
  if (!history) return [];
  const dateAt = history.columns.indexOf('TRADEDATE');
  const closeAt = history.columns.indexOf('CLOSE');
  if (dateAt === -1 || closeAt === -1) return [];
  return history.data
    .filter((row) => Array.isArray(row) && typeof row[dateAt] === 'string'
      && (!beforeDate || row[dateAt] < beforeDate) && positivePrice(row[closeAt]))
    .sort((a, b) => String(a[dateAt]).localeCompare(String(b[dateAt])))
    .map((row) => Number(row[closeAt]));
}

/** @param {string} symbol */
export function moexMarketdataUrl(symbol) {
  const params = new URLSearchParams({
    'iss.meta': 'off', 'iss.only': 'marketdata',
    'marketdata.columns': 'SECID,CURRENTVALUE,TRADEDATE,UPDATETIME',
  });
  return `${MOEX_ISS_ORIGIN}/iss/engines/stock/markets/index/securities/${encodeURIComponent(symbol)}.json?${params.toString()}`;
}

/** @param {unknown} payload @param {string} symbol */
function currentIndex(payload, symbol) {
  const market = moexTable(payload, 'marketdata');
  if (!market) return null;
  const symbolAt = market.columns.indexOf('SECID');
  const priceAt = market.columns.indexOf('CURRENTVALUE');
  const dateAt = market.columns.indexOf('TRADEDATE');
  if (symbolAt < 0 || priceAt < 0 || dateAt < 0) return null;
  const row = market.data.find((row) => Array.isArray(row) && row[symbolAt] === symbol);
  if (!row || !positivePrice(row[priceAt]) || typeof row[dateAt] !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(row[dateAt]) || !Number.isFinite(Date.parse(row[dateAt]))) return null;
  return { price: Number(row[priceAt]), tradeDate: row[dateAt] };
}

/**
 * Current delayed quote plus the preceding daily closes. History can already
 * contain today's close, so exclude that date before appending the quote.
 * @param {unknown} history
 * @param {unknown} marketdata
 * @param {{ code: string, symbol: string, name: string }} index
 * @param {string} [fetchedAt]
 */
export function buildMoexCountryStockIndexSnapshot(history, marketdata, index, fetchedAt = new Date().toISOString()) {
  const current = currentIndex(marketdata, index.symbol);
  if (!current) return null;
  const closes = parseMoexHistoryCloses(history, current.tradeDate);
  return buildCountryStockIndexSnapshotFromCloses([...closes, current.price], MOEX_CURRENCY, fetchedAt, index);
}

/**
 * @param {{ code: string, symbol: string, name: string }} index
 * @param {{ fetchImpl?: typeof fetch, now?: Date }} [options]
 */
export async function fetchMoexCountryStockIndexSnapshot(index, { fetchImpl = (...args) => globalThis.fetch(...args), now = new Date() } = {}) {
  const [history, marketdata] = await Promise.all(
    [moexHistoryUrl(index.symbol, now), moexMarketdataUrl(index.symbol)].map(async (url) => {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': MOEX_USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(MOEX_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`MOEX ISS HTTP ${response.status}`);
      return response.json();
    }),
  );
  const snapshot = buildMoexCountryStockIndexSnapshot(history, marketdata, index, now.toISOString());
  if (!snapshot) throw new Error('insufficient market data');
  return snapshot;
}
