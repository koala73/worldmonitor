/**
 * RPC: ListCryptoQuotes -- reads seeded crypto data from the Railway seed
 * cache first, and resolves any requested CoinGecko IDs that are not in the
 * seed via a bounded upstream gap-fetch (CoinGecko -> CoinPaprika, with a
 * Railway relay fallback when configured).
 *
 * The pure-Redis conversion in #1684 removed the upstream miss path without
 * narrowing the proto contract, so arbitrary ids were silently filtered to an
 * empty/partial response (#6306). This handler restores a bounded seed-first
 * path:
 *   - empty `ids` -> the default crypto set, seed-only, no upstream call;
 *   - requested ids are normalized, de-duplicated, validated (max 25) and
 *     split into seed hits (served from Redis, no upstream call) and gap ids
 *     (one bounded provider fetch, Redis-cached per gap set);
 *   - unresolved ids are surfaced explicitly in `unresolved_ids` and
 *     `provider` reports the data source -- callers never see silent holes.
 *
 * Provider errors are never written to the Redis negative cache
 * (cacheFetcherErrors: false), so a transient upstream failure is retried on
 * the next request instead of poisoning the cache.
 */

import type {
  ServerContext,
  ListCryptoQuotesRequest,
  ListCryptoQuotesResponse,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import {
  CRYPTO_META,
  fetchCoinGeckoMarkets,
  fetchCoinPaprikaMarkets,
  parseStringArray,
  UPSTREAM_TIMEOUT_MS,
} from './_shared';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import { markNoCacheResponse, setResponseHeader } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'market:crypto:v1';
const GAP_CACHE_TTL = 600; // 10 min — matches the pre-#1684 REDIS_CACHE_TTL
const MAX_IDS = 25;

// CoinGecko ID per seed quote symbol. Seed snapshots are keyed by symbol, so
// request ids are matched to seed members via this reverse map.
const SYMBOL_TO_ID = new Map(Object.entries(CRYPTO_META).map(([id, m]) => [m.symbol, id]));

interface SeedQuote {
  name: string;
  symbol: string;
  price: number;
  change: number;
  sparkline: number[];
}

/**
 * Fetch quotes for CoinGecko ids that are not in the seed, using the same
 * provider chain the seeders use: CoinGecko markets API first, then per-ID
 * CoinPaprika tickers. Throws when every provider fails (so the caller can
 * fall back to the relay without caching the failure).
 */
function mapMarketItem(item: {
  id: string;
  name?: string;
  symbol?: string;
  current_price?: number | null;
  price_change_percentage_24h?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  sparkline_in_7d?: { price?: number[] };
}): CryptoQuote {
  const prices = item.sparkline_in_7d?.price;
  return {
    name: item.name || item.id,
    symbol: (item.symbol || item.id).toUpperCase(),
    price: item.current_price ?? 0,
    change: item.price_change_percentage_24h ?? 0,
    sparkline: prices && prices.length > 24 ? prices.slice(-48) : (prices || []),
    change7d: item.price_change_percentage_7d_in_currency ?? 0,
  };
}

/**
 * CoinGecko first, then CoinPaprika for any still-missing ids. Unlike
 * fetchCryptoMarkets (paprika only on throw), an empty/partial CoinGecko
 * success still fills gaps via paprika so unknown coins are not NEG-cached
 * without a second opinion.
 */
async function fetchGapQuotes(ids: string[]): Promise<Map<string, CryptoQuote>> {
  const got = new Map<string, CryptoQuote>();
  let geckoFailed = false;
  try {
    const items = await fetchCoinGeckoMarkets(ids);
    for (const item of items) got.set(item.id, mapMarketItem(item));
  } catch (err) {
    // sentry-coverage-ok: CoinGecko failure is expected fallback path into paprika/relay; gap unresolvedIds surfaces the miss.
    geckoFailed = true;
    console.warn('[crypto-quotes] CoinGecko gap fetch failed:', (err as Error).message);
  }

  const missing = ids.filter((id) => !got.has(id));
  if (missing.length === 0) return got;

  try {
    const paprika = await fetchCoinPaprikaMarkets(missing);
    for (const item of paprika) {
      if (!got.has(item.id)) got.set(item.id, mapMarketItem(item));
    }
  } catch (err) {
    // If both providers fail completely, rethrow so cachedFetchJson does not
    // write a positive empty entry (cacheFetcherErrors: false path).
    // sentry-coverage-ok: partial paprika failure degrades to unresolvedIds / relay; total failure rethrows above.
    if (geckoFailed && got.size === 0) throw err;
    console.warn('[crypto-quotes] CoinPaprika gap fill failed:', (err as Error).message);
  }

  if (geckoFailed && got.size === 0) {
    throw new Error('All crypto providers failed for gap ids');
  }
  return got;
}

/**
 * Relay-backed gap fetch: proxies the same per-ID provider work through the
 * Railway `/crypto-quotes` route (separate egress IP). Only ids the primary
 * provider chain could not resolve are sent here.
 */
async function fetchGapQuotesViaRelay(ids: string[]): Promise<Map<string, CryptoQuote>> {
  const relayBase = getRelayBaseUrl();
  if (!relayBase) {
    console.warn('[crypto-quotes] relay gap fetch skipped: WS_RELAY_URL not set');
    return new Map();
  }
  try {
    const url = `${relayBase}/crypto-quotes?ids=${encodeURIComponent(ids.join(','))}`;
    const resp = await fetch(url, {
      headers: getRelayHeaders({ Accept: 'application/json' }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[crypto-quotes] relay HTTP ${resp.status}`);
      return new Map();
    }
    const data = (await resp.json()) as {
      quotes?: Array<{ id?: string; name?: string; symbol?: string; price?: number; change?: number; change7d?: number; sparkline?: number[] }>;
    };
    if (!Array.isArray(data.quotes)) return new Map();
    const got = new Map<string, CryptoQuote>();
    for (const q of data.quotes) {
      if (!q?.id || typeof q.price !== 'number' || !Number.isFinite(q.price) || q.price <= 0) continue;
      got.set(q.id, {
        name: q.name ?? q.id,
        symbol: (q.symbol ?? q.id).toUpperCase(),
        price: q.price,
        change: q.change ?? 0,
        sparkline: Array.isArray(q.sparkline) ? q.sparkline : [],
        change7d: q.change7d ?? 0,
      });
    }
    return got;
  } catch (err) {
    // sentry-coverage-ok: relay failure degrades to explicit unresolvedIds by design; the caller sees the gap, not a silent drop.
    console.warn('[crypto-quotes] relay gap fetch failed:', (err as Error).message);
    return new Map();
  }
}

export async function listCryptoQuotes(
  ctx: ServerContext,
  req: ListCryptoQuotesRequest,
): Promise<ListCryptoQuotesResponse> {
  // Normalize + de-duplicate requested ids (trimmed, first-seen order).
  const requested = parseStringArray(req.ids);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const id = raw.trim().toLowerCase();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  // Never trust Redis reads to break the request.
  let seedQuotes: SeedQuote[] = [];
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { quotes: SeedQuote[] } | null;
    seedQuotes = seedData?.quotes ?? [];
  } catch {
    // sentry-coverage-ok: a seed read failure degrades to seed-only/empty behavior by design; no error to surface.
    seedQuotes = [];
  }

  // Default request: return the seeded default crypto set, never the provider.
  if (ids.length === 0) {
    if (seedQuotes.length === 0) {
      return { quotes: [], unresolvedIds: [], provider: 'degraded' };
    }
    return {
      quotes: seedQuotes.map((q) => ({ ...q, change7d: (q as Partial<CryptoQuote>).change7d ?? 0 })),
      unresolvedIds: [],
      provider: 'seed',
    };
  }

  const accepted = ids.slice(0, MAX_IDS);
  const overflow = ids.slice(MAX_IDS);

  // Map seed members to their CoinGecko ids (reverse of CRYPTO_META symbol,
  // plus the stored name/symbol as fallback keys).
  // Index seed hits only by CoinGecko meta ids. Name/symbol aliases would let
  // non-id tokens (e.g. "btc") short-circuit as seed hits and skip gap fetch.
  const seedById = new Map<string, CryptoQuote>();
  for (const q of seedQuotes) {
    const metaId = SYMBOL_TO_ID.get(q.symbol);
    if (!metaId) continue;
    const quote: CryptoQuote = { ...q, change7d: (q as Partial<CryptoQuote>).change7d ?? 0 };
    seedById.set(metaId, quote);
  }

  const seedHits: string[] = [];
  const gapIds: string[] = [];
  for (const id of accepted) {
    if (seedById.has(id)) seedHits.push(id);
    else gapIds.push(id);
  }

  const resolved = new Map<string, CryptoQuote>();
  for (const id of seedHits) resolved.set(id, seedById.get(id)!);

  let provider: 'seed' | 'upstream' | 'mixed' | 'degraded' =
    gapIds.length === 0 ? 'seed' : (seedHits.length > 0 ? 'mixed' : 'upstream');

  if (gapIds.length > 0) {
    // Bounded upstream fetch, Redis-cached per sorted gap set. cacheFetcherErrors
    // is false so provider failures rethrow and never write a negative cache.
    // An empty provider result is treated as a negative (120s NEG_SENTINEL) via
    // a `null` fetcher return, never as a positive 600s `{}` cache entry.
    const cacheKey = `market:crypto:gap:v1:${[...gapIds].sort().join(',')}`;
    try {
      const cached = await cachedFetchJson<Record<string, CryptoQuote>>(
        cacheKey,
        GAP_CACHE_TTL,
        async () => {
          const got = await fetchGapQuotes(gapIds);
          return got.size > 0 ? Object.fromEntries(got) : null;
        },
        120,
        { timeoutMs: 15_000, cacheFetcherErrors: false },
      );
      if (cached) {
        for (const [id, quote] of Object.entries(cached)) resolved.set(id, quote);
      }
    } catch (err) {
      // sentry-coverage-ok: a provider/upstream failure degrades to explicit unresolvedIds + the 3s local backoff; never a hidden drop or poisoned cache.
      console.warn('[crypto-quotes] upstream gap fetch failed:', (err as Error).message);
    }

    // Any gap id the provider could not resolve gets a relay attempt (separate
    // egress IP). Relay results are applied per-request and not Redis-cached.
    const stillMissing = gapIds.filter((id) => !resolved.has(id));
    if (stillMissing.length > 0) {
      const relayed = await fetchGapQuotesViaRelay(stillMissing);
      for (const [id, quote] of relayed) resolved.set(id, quote);
    }
  }

  const unresolvedIds = [...overflow, ...gapIds.filter((id) => !resolved.has(id))];
  if (unresolvedIds.length > 0) provider = 'degraded';

  const quotes = accepted
    .map((id) => resolved.get(id))
    .filter((quote): quote is CryptoQuote => Boolean(quote));

  if (provider === 'degraded' || unresolvedIds.length > 0) {
    markNoCacheResponse(ctx.request);
  }
  setResponseHeader(ctx.request, 'X-Crypto-Provider', provider);
  return { quotes, unresolvedIds, provider };
}
