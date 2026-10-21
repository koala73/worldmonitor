// @ts-check
/**
 * Normalized authorized market-quote provider for Railway seeders (#6304).
 *
 * Decision: Finnhub + Alpha Vantage are the authorized equity providers.
 * Financial Modeling Prep (FMP) is not used — commercial display/redistribution
 * requires a separate FMP Data Display agreement (see docs/finance-data.mdx).
 *
 * Seeders consume this module's normalized `{ symbol, price, change, sparkline }`
 * shape instead of branching on provider-specific response objects.
 *
 * Order for equity seed fills:
 *   1. Alpha Vantage REALTIME_BULK_QUOTES (cheap batch when key present)
 *   2. Finnhub per-symbol for remaining non-yahooOnly symbols
 *   3. Optional Yahoo residual via caller-supplied `fetchYahooQuote` (legacy
 *      coverage for yahooOnly / regional listings until #3731 fully retires it)
 */

import { CHROME_UA, sleep } from '../_seed-utils.mjs';
import { fetchAvBulkQuotes } from '../_shared-av.mjs';

export const MARKET_QUOTE_MIN_FRESH_COVERAGE_RATIO = 0.8;

/**
 * A refresh may retain last-good records, but it must not publish fresh
 * seed-meta unless this cycle resolved most of the configured universe.
 *
 * @param {number} freshCount
 * @param {number} expectedCount
 * @param {number} [minimumRatio]
 */
export function hasSufficientFreshQuoteCoverage(
  freshCount,
  expectedCount,
  minimumRatio = MARKET_QUOTE_MIN_FRESH_COVERAGE_RATIO,
) {
  return Number.isInteger(freshCount)
    && Number.isInteger(expectedCount)
    && expectedCount > 0
    && freshCount >= Math.ceil(expectedCount * minimumRatio);
}

/**
 * @typedef {{ price: number; change: number; sparkline: number[] }} NormalizedQuote
 * @typedef {{ symbol: string; name: string; display: string; price: number; change: number; sparkline: number[] }} SeedQuote
 */

/**
 * @param {string} symbol
 * @param {NormalizedQuote} q
 * @param {{ name?: string; display?: string }} [meta]
 * @returns {SeedQuote}
 */
export function toSeedQuote(symbol, q, meta = {}) {
  return {
    symbol,
    name: meta.name || symbol,
    display: meta.display || symbol,
    price: q.price,
    change: q.change,
    sparkline: Array.isArray(q.sparkline) ? q.sparkline : [],
  };
}

/**
 * @param {string} symbol
 * @param {string} apiKey
 * @param {{ timeoutMs?: number; ua?: string }} [opts]
 * @returns {Promise<NormalizedQuote | null>}
 */
export async function fetchFinnhubEquityQuote(symbol, apiKey, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ua = opts.ua ?? CHROME_UA;
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': ua, 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 429) {
      console.warn(`  [Finnhub] ${symbol} rate-limited`);
      return null;
    }
    if (!resp.ok) return null;
    let data;
    try {
      data = await resp.json();
    } catch {
      console.warn(`  [Finnhub] ${symbol} malformed JSON`);
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    if (data.c === 0 && data.h === 0 && data.l === 0) return null;
    if (!Number.isFinite(data.c) || data.c <= 0) return null;
    return {
      price: data.c,
      change: Number.isFinite(data.dp) ? data.dp : 0,
      sparkline: [],
    };
  } catch (err) {
    console.warn(`  [Finnhub] ${symbol} error: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a symbol set through authorized providers first.
 *
 * @param {object} args
 * @param {string[]} args.symbols
 * @param {Set<string> | string[]} [args.yahooOnly]
 * @param {Map<string, { name?: string; display?: string }> | Record<string, { name?: string; display?: string }>} [args.metaBySymbol]
 * @param {string | undefined} [args.alphaVantageKey]
 * @param {string | undefined} [args.finnhubKey]
 * @param {(symbol: string) => Promise<NormalizedQuote | null>} [args.fetchYahooQuote]
 *   Optional residual path for yahooOnly / regional symbols. Omit to stay
 *   fully on authorized providers (gaps stay missing).
 * @param {number} [args.yahooDelayMs]
 * @param {number} [args.finnhubPaceEvery]
 * @returns {Promise<{ quotes: SeedQuote[]; covered: Set<string>; providersUsed: string[]; authorizedOnly: boolean }>}
 */
export async function fetchAuthorizedEquityQuotes({
  symbols,
  yahooOnly = [],
  metaBySymbol = {},
  alphaVantageKey,
  finnhubKey,
  fetchYahooQuote,
  yahooDelayMs = 200,
  finnhubPaceEvery = 10,
}) {
  const yahooOnlySet = yahooOnly instanceof Set ? yahooOnly : new Set(yahooOnly);
  const meta = metaBySymbol instanceof Map
    ? metaBySymbol
    : new Map(Object.entries(metaBySymbol));

  /** @type {SeedQuote[]} */
  const quotes = [];
  const covered = new Set();
  /** @type {string[]} */
  const providersUsed = [];

  const avKey = alphaVantageKey ?? process.env.ALPHA_VANTAGE_API_KEY;
  const fhKey = finnhubKey ?? process.env.FINNHUB_API_KEY;

  // --- Primary authorized: Alpha Vantage bulk ---
  if (avKey) {
    const avSymbols = symbols.filter((s) => !yahooOnlySet.has(s) && !s.endsWith('.NS'));
    if (avSymbols.length > 0) {
      const avResults = await fetchAvBulkQuotes(avSymbols, avKey);
      if (avResults.size > 0 && !providersUsed.includes('alphavantage')) {
        providersUsed.push('alphavantage');
      }
      for (const [sym, q] of avResults) {
        quotes.push(toSeedQuote(sym, q, meta.get(sym)));
        covered.add(sym);
        console.log(`  [AV] ${sym}: $${q.price} (${q.change > 0 ? '+' : ''}${Number(q.change).toFixed(2)}%)`);
      }
    }
  }

  // --- Secondary authorized: Finnhub ---
  if (fhKey) {
    const finnhubSymbols = symbols.filter((s) => !covered.has(s) && !yahooOnlySet.has(s));
    let any = false;
    for (let i = 0; i < finnhubSymbols.length; i++) {
      if (i > 0 && i % finnhubPaceEvery === 0) await sleep(100);
      const sym = finnhubSymbols[i];
      const r = await fetchFinnhubEquityQuote(sym, fhKey);
      if (r) {
        any = true;
        quotes.push(toSeedQuote(sym, r, meta.get(sym)));
        covered.add(sym);
        console.log(`  [Finnhub] ${sym}: $${r.price} (${r.change > 0 ? '+' : ''}${r.change}%)`);
      }
    }
    if (any && !providersUsed.includes('finnhub')) providersUsed.push('finnhub');
  }

  // --- Residual (optional, not authorized under #3731) ---
  let usedYahoo = false;
  if (typeof fetchYahooQuote === 'function') {
    const remaining = symbols.filter((s) => !covered.has(s));
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      if (i > 0) await sleep(yahooDelayMs);
      const q = await fetchYahooQuote(s);
      if (q) {
        usedYahoo = true;
        quotes.push(toSeedQuote(s, q, meta.get(s)));
        covered.add(s);
        console.log(`  [Yahoo] ${s}: $${q.price} (${q.change > 0 ? '+' : ''}${Number(q.change).toFixed(2)}%)`);
      }
    }
    if (usedYahoo && !providersUsed.includes('yahoo-residual')) {
      providersUsed.push('yahoo-residual');
    }
  }

  return {
    quotes,
    covered,
    providersUsed,
    authorizedOnly: !usedYahoo,
  };
}

/**
 * Skip reason when neither authorized equity key is present.
 * @returns {string}
 */
export function authorizedProvidersMissingReason() {
  return 'FINNHUB_API_KEY and ALPHA_VANTAGE_API_KEY not configured';
}
