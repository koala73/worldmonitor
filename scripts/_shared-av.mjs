// @ts-check
/**
 * Shared Alpha Vantage fetch helpers for seed scripts.
 * Single implementation used by seed-market-quotes, seed-commodity-quotes, seed-etf-flows.
 */

import { CHROME_UA, sleep } from './_seed-utils.mjs';

export const AV_PHYSICAL_MAP = {
  'CL=F': 'WTI',
  'BZ=F': 'BRENT',
  'NG=F': 'NATURAL_GAS',
  'HG=F': 'COPPER',
  'ALI=F': 'ALUMINUM',
  'GC=F': 'GOLD',
  'SI=F': 'SILVER',
};

const AV_BATCH_DELAY_MS = 500;
const AV_TIMEOUT_MS = 15_000;

async function avFetch(url, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await sleep(1000);
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(AV_TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`  [AV] ${label} HTTP ${resp.status}`);
        if (attempt === 0) continue;
        return null;
      }
      return resp;
    } catch (err) {
      console.warn(`  [AV] ${label} error: ${err.message}`);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/**
 * Fetch physical commodity quote from AV daily series.
 * Returns price, day-over-day change, and a 7-point sparkline from daily closes.
 *
 * Note: AV physical commodity endpoints are daily-close data (not intraday).
 * Prices reflect the most recent market-day close.
 *
 * @param {string} yahooSymbol
 * @param {string} apiKey
 * @returns {Promise<{ price: number; change: number; sparkline: number[] } | null>}
 */
export async function fetchAvPhysicalCommodity(yahooSymbol, apiKey) {
  const fn = AV_PHYSICAL_MAP[yahooSymbol];
  if (!fn) return null;
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=daily&apikey=${encodeURIComponent(apiKey)}`;
  const resp = await avFetch(url, fn);
  if (!resp) return null;
  try {
    const json = await resp.json();
    if (json.Information) { console.warn(`  [AV] Rate limit: ${String(json.Information).slice(0, 100)}`); return null; }
    const data = json.data;
    if (!Array.isArray(data) || data.length < 2) return null;
    const latest = parseFloat(data[0].value);
    const prev = parseFloat(data[1].value);
    if (!Number.isFinite(latest) || latest <= 0) return null;
    const change = (Number.isFinite(prev) && prev > 0) ? ((latest - prev) / prev) * 100 : 0;
    // Build sparkline from last 7 daily closes (oldest → newest)
    const sparkline = data.slice(0, 7).map(d => parseFloat(d.value)).filter(Number.isFinite).reverse();
    return { price: latest, change, sparkline };
  } catch (err) {
    console.warn(`  [AV] ${fn} parse error: ${err.message}`);
    return null;
  }
}

/**
 * Fetch daily FX time series for a currency pair (FROM → USD).
 * Returns price (latest close), day-over-day change %, and 7-point sparkline.
 * Use this when you need change% and sparkline (e.g. gulf panel currencies).
 *
 * @param {string} fromCurrency  e.g. 'SAR', 'EUR', 'JPY'
 * @param {string} apiKey
 * @returns {Promise<{ price: number; change: number; sparkline: number[] } | null>}
 */
export async function fetchAvFxDaily(fromCurrency, apiKey) {
  if (fromCurrency === 'USD') return { price: 1.0, change: 0, sparkline: [] };
  const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${encodeURIComponent(fromCurrency)}&to_symbol=USD&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`;
  const resp = await avFetch(url, `FX_DAILY/${fromCurrency}`);
  if (!resp) return null;
  try {
    const json = await resp.json();
    if (json.Information) { console.warn(`  [AV] Rate limit: ${String(json.Information).slice(0, 100)}`); return null; }
    const series = json['Time Series FX (Daily)'];
    if (!series || typeof series !== 'object') return null;
    const dates = Object.keys(series).sort().reverse(); // newest first
    if (dates.length < 2) return null;
    const latest = parseFloat(series[dates[0]]['4. close']);
    const prev = parseFloat(series[dates[1]]['4. close']);
    if (!Number.isFinite(latest) || latest <= 0) return null;
    const change = (Number.isFinite(prev) && prev > 0) ? ((latest - prev) / prev) * 100 : 0;
    const sparkline = dates.slice(0, 7).map(d => parseFloat(series[d]['4. close'])).filter(Number.isFinite).reverse();
    return { price: latest, change, sparkline };
  } catch (err) {
    console.warn(`  [AV] FX_DAILY/${fromCurrency} parse error: ${err.message}`);
    return null;
  }
}

/**
 * Fetch real-time bulk quotes from AV. Batches up to 100 symbols per call.
 * Returns a Map of symbol → { price, change, volume, prevClose }.
 *
 * @param {string[]} symbols
 * @param {string} apiKey
 * @returns {Promise<Map<string, { price: number; change: number; volume: number; prevClose: number | null }>>}
 */
export async function fetchAvBulkQuotes(symbols, apiKey) {
  if (symbols.length === 0) return new Map();
  const results = new Map();
  const BATCH = 100;
  for (let i = 0; i < symbols.length; i += BATCH) {
    if (i > 0) await sleep(AV_BATCH_DELAY_MS);
    const chunk = symbols.slice(i, i + BATCH);
    const url = `https://www.alphavantage.co/query?function=REALTIME_BULK_QUOTES&symbol=${encodeURIComponent(chunk.join(','))}&apikey=${encodeURIComponent(apiKey)}`;
    const resp = await avFetch(url, 'REALTIME_BULK_QUOTES');
    if (!resp) continue;
    try {
      const json = await resp.json();
      if (json.Information) {
        const remaining = symbols.length - i - chunk.length;
        console.warn(`  [AV] Rate limit hit${remaining > 0 ? ` — dropping ${remaining} remaining symbols` : ''}: ${String(json.Information).slice(0, 80)}`);
        break;
      }
      if (!Array.isArray(json.data)) {
        console.warn('  [AV] Unexpected response:', JSON.stringify(json).slice(0, 200));
        continue;
      }
      for (const item of json.data) {
        const price = parseFloat(item.price);
        const prevClose = parseFloat(item['previous close']);
        const volume = parseInt(item.volume || '0', 10);
        if (!Number.isFinite(price) || price <= 0) continue;
        const changePct = (Number.isFinite(prevClose) && prevClose > 0)
          ? ((price - prevClose) / prevClose) * 100
          : parseFloat((item['change percent'] || '0').replace('%', ''));
        results.set(item.symbol, {
          price,
          change: Number.isFinite(changePct) ? changePct : 0,
          volume: Number.isFinite(volume) ? volume : 0,
          prevClose: Number.isFinite(prevClose) ? prevClose : null,
        });
      }
    } catch (err) {
      console.warn(`  [AV] Bulk quotes parse error: ${err.message}`);
    }
  }
  return results;
}
