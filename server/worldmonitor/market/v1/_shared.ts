/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */
import { CHROME_UA } from '../../../_shared/constants';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
export { getRelayBaseUrl, getRelayHeaders };
import cryptoConfig from '../../../../shared/crypto.json';
import stablecoinConfig from '../../../../shared/stablecoins.json';
export { parseStringArray } from '../../../_shared/parse-string-array';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

export function sanitizeSymbol(raw: string): string {
  return raw.trim().replace(/\s+/g, '').slice(0, 32).toUpperCase();
}

// The Yahoo-only symbol list that used to live here was dead after #1684 (the
// handler became a pure seed read) and had drifted to a subset of the routing
// list the relay actually uses. `shared/stocks.json#yahooOnly` is the single
// source of truth; `./_quote-provider.ts` reads it to decide what Finnhub can
// serve.

export const CRYPTO_META: Record<string, { name: string; symbol: string }> = cryptoConfig.meta;

// ========================================================================
// Types
// ========================================================================

export interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      indicators?: {
        quote?: Array<{ close?: (number | null)[] }>;
      };
    }>;
  };
}

export interface CoinGeckoMarketItem {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  sparkline_in_7d?: { price: number[] };
  // Extended fields (present from both CoinGecko and CoinPaprika fallback)
  price_change_percentage_7d_in_currency?: number;
  market_cap?: number;
  total_volume?: number;
  symbol?: string;
  name?: string;
  image?: string;
}

// ========================================================================
// CoinGecko fetcher
// ========================================================================

/**
 * Resolve the CoinGecko base URL + auth header for the configured key tier.
 *
 * CoinGecko's free Demo plan and paid Pro plan share the `CG-` key prefix but
 * use different hosts and auth headers — a Demo key sent to the Pro host fails
 * with HTTP 400 (error 10011: "change your root URL from pro-api.coingecko.com
 * to api.coingecko.com"). The key string can't reveal the tier, so it is
 * selected explicitly by which env var is set; Pro wins so existing Pro
 * deployments are unaffected, and no key falls back to the public endpoint.
 */
export function coingeckoEndpoint(): { baseUrl: string; headers: Record<string, string>; tier: 'pro' | 'demo' | 'keyless' } {
  const proKey = process.env.COINGECKO_API_KEY;
  const demoKey = process.env.COINGECKO_DEMO_API_KEY;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (proKey) {
    headers['x-cg-pro-api-key'] = proKey;
    return { baseUrl: 'https://pro-api.coingecko.com/api/v3', headers, tier: 'pro' };
  }
  if (demoKey) {
    headers['x-cg-demo-api-key'] = demoKey;
    return { baseUrl: 'https://api.coingecko.com/api/v3', headers, tier: 'demo' };
  }
  return { baseUrl: 'https://api.coingecko.com/api/v3', headers, tier: 'keyless' };
}

/**
 * Shape of the `/coins/markets` projection. Defaults reproduce the original
 * call exactly (sparkline on, 24h window) so existing callers are unchanged;
 * the stablecoin RPC asks for `24h,7d` and no sparkline, because it must
 * populate a `change7d` field and renders no chart. Requesting `7d` is not
 * optional there: CoinGecko omits `price_change_percentage_7d_in_currency`
 * unless the window is named, which would silently zero the column.
 */
export interface CoinGeckoMarketsOpts {
  sparkline?: boolean;
  priceChangePercentage?: string;
}

export async function fetchCoinGeckoMarkets(
  ids: string[],
  opts: CoinGeckoMarketsOpts = {},
): Promise<CoinGeckoMarketItem[]> {
  const { sparkline = true, priceChangePercentage = '24h' } = opts;
  const { baseUrl, headers } = coingeckoEndpoint();
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=${sparkline}&price_change_percentage=${encodeURIComponent(priceChangePercentage)}`;

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`CoinGecko HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error(`CoinGecko returned non-array: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// ========================================================================
// CoinPaprika fallback fetcher
// ========================================================================

// CoinGecko ID → CoinPaprika ID mapping (shared ids + stablecoin-specific)
const COINPAPRIKA_ID_MAP: Record<string, string> = {
  ...cryptoConfig.coinpaprika,
  ...stablecoinConfig.coinpaprika,
};

interface CoinPaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  quotes: {
    USD: {
      price: number;
      volume_24h: number;
      market_cap: number;
      percent_change_24h: number;
      percent_change_7d: number;
    };
  };
}

const COINPAPRIKA_FETCH_CONCURRENCY = 4;

async function fetchCoinPaprikaTickersById(
  paprikaIds: string[],
): Promise<CoinPaprikaTicker[]> {
  const ids = [...new Set(paprikaIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];

  const results = await allSettledWithConcurrency(ids, COINPAPRIKA_FETCH_CONCURRENCY, async id => {
    const resp = await fetch(`https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(id)}?quotes=USD`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`CoinPaprika ${id} HTTP ${resp.status}`);
    return resp.json() as Promise<CoinPaprikaTicker>;
  });

  const tickers: CoinPaprikaTicker[] = [];
  const failures: unknown[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      tickers.push(result.value);
    } else {
      failures.push(result.reason);
      console.warn(`[CoinPaprika] Skipping ${ids[index] ?? 'unknown'}:`, (result.reason as Error).message || result.reason);
    }
  }

  if (tickers.length === 0 && failures.length > 0) {
    throw new Error(`All ${failures.length} CoinPaprika ticker request(s) failed`);
  }

  return tickers;
}

async function allSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));

  return results;
}

export async function fetchCoinPaprikaMarkets(
  geckoIds: string[],
): Promise<CoinGeckoMarketItem[]> {
  const paprikaIds = geckoIds.map(id => COINPAPRIKA_ID_MAP[id]).filter((id): id is string => Boolean(id));
  if (paprikaIds.length === 0) throw new Error('No CoinPaprika ID mapping for requested coins');

  const matched = await fetchCoinPaprikaTickersById(paprikaIds);
  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));

  return matched.map(t => {
    const q = t.quotes.USD;
    return {
      id: reverseMap.get(t.id) || t.id,
      current_price: q.price,
      price_change_percentage_24h: q.percent_change_24h,
      price_change_percentage_7d_in_currency: q.percent_change_7d,
      market_cap: q.market_cap,
      total_volume: q.volume_24h,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
      image: '',
      sparkline_in_7d: undefined,
    };
  });
}

// ========================================================================
// Unified crypto market fetcher: CoinGecko → CoinPaprika fallback
// ========================================================================

export type CryptoMarketsSource = 'coingecko' | 'coinpaprika';

/**
 * Same ladder as `fetchCryptoMarkets`, but names the leg that answered.
 *
 * The two legs do not have the same reach: CoinGecko resolves any ID it knows,
 * while CoinPaprika can only answer for IDs present in COINPAPRIKA_ID_MAP. So
 * "absent from the result" means "no such coin" on the primary and merely
 * "outside our mapping table" on the fallback. A caller that reports per-ID
 * outcomes has to tell those apart; one that just renders the rows does not,
 * and should keep using `fetchCryptoMarkets`.
 */
export async function fetchCryptoMarketsWithSource(
  ids: string[],
  opts: CoinGeckoMarketsOpts = {},
): Promise<{ items: CoinGeckoMarketItem[]; source: CryptoMarketsSource }> {
  try {
    return { items: await fetchCoinGeckoMarkets(ids, opts), source: 'coingecko' };
  } catch (err) {
    // sentry-coverage-ok: a primary-leg failure is the expected trigger for
    // this ladder, and the CoinPaprika call below owns recovery. If that leg
    // fails too the error propagates to the caller, which is where the
    // both-providers-down condition is worth reporting.
    console.warn(`[CoinGecko] Failed, falling back to CoinPaprika:`, (err as Error).message);
    // No opts pass-through: CoinPaprika's ticker response always carries both
    // the 24h and 7d change, so the projection knobs have nothing to select.
    return { items: await fetchCoinPaprikaMarkets(ids), source: 'coinpaprika' };
  }
}

export async function fetchCryptoMarkets(
  ids: string[],
  opts: CoinGeckoMarketsOpts = {},
): Promise<CoinGeckoMarketItem[]> {
  return (await fetchCryptoMarketsWithSource(ids, opts)).items;
}
