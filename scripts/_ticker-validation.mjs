// @ts-check
/** @typedef {{ symbol: string, name?: string, display?: string }} StockSymbol */

const STOCKS_BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';

/**
 * Load the set of valid ticker symbols from Redis (market:stocks-bootstrap:v1).
 * Returns an empty Set if the key is missing or malformed — callers must handle gracefully.
 * @param {string} redisUrl
 * @param {string} redisToken
 * @returns {Promise<Set<string>>}
 */
export async function loadTickerSet(redisUrl, redisToken) {
  try {
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(STOCKS_BOOTSTRAP_KEY)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return new Set();
    const data = await resp.json();
    if (!data?.result) return new Set();
    /** @type {{ quotes?: StockSymbol[] } | null} */
    const parsed = (() => { try { return JSON.parse(data.result); } catch { return null; } })();
    if (!Array.isArray(parsed?.quotes)) return new Set();
    return new Set(parsed.quotes.map(s => s.symbol?.toUpperCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}
