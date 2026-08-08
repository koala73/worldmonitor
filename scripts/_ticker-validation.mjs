// @ts-check
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

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
    // market:stocks-bootstrap:v1 is written in contract mode ({_seed, data}) by
    // both seed-market-quotes.mjs (runSeed declareRecords) and the AIS relay
    // (envelopeWrite). Reading `.quotes` off the raw parse returned undefined —
    // the quotes live under `.data.quotes` — so this set was empty on every run
    // (Railway log 2026-07-01). unwrapEnvelope strips _seed and passes legacy
    // bare shapes through unchanged, so `.quotes` resolves for both.
    /** @type {{ quotes?: StockSymbol[] } | null} */
    const payload = unwrapEnvelope(data.result).data;
    if (!Array.isArray(payload?.quotes)) return new Set();
    return new Set(payload.quotes.map(s => s.symbol?.toUpperCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}
