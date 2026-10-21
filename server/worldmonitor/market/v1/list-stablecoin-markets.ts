/**
 * RPC: ListStablecoinMarkets -- seed-first stablecoin peg data.
 *
 * Two request shapes, deliberately different in what they are allowed to cost:
 *
 *   Empty `coins` (the dashboard panel's hot path) is served from the Railway
 *   seed snapshot alone and NEVER reaches an upstream provider. That is the
 *   posture #1684 established when it converted this handler to a pure Redis
 *   read, and nothing here weakens it.
 *
 *   Naming coins explicitly opts into a bounded, Redis-cached provider lookup
 *   for exactly the IDs the snapshot does not carry. Seed hits cost nothing;
 *   only the residue reaches CoinGecko, in one batched call. (#6308)
 *
 * The summary is recomputed over exactly the coins returned, so a subset
 * request describes the subset rather than the seeded default set.
 */

import type {
  ServerContext,
  ListStablecoinMarketsRequest,
  ListStablecoinMarketsResponse,
  Stablecoin,
  StablecoinSummary,
  UnresolvedStablecoin,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
// The same row shaping the two Railway seeders apply when writing the seed
// snapshot — a gap coin and a seeded coin sitting in one response must not be
// labelled on different rules. Thresholds default to shared/stablecoins.json
// inside the module. (#6308, #6319)
import { classifyStablecoin } from '../../../../shared/stablecoin-classifier.cjs';
import { cachedFetchJson, readCachedJson, setCachedJson } from '../../../_shared/redis';
import { sha256Hex } from '../../../_shared/hash';
import {
  fetchCryptoMarketsWithSource,
  parseStringArray,
  type CryptoMarketsSource,
} from './_shared';

const SEED_CACHE_KEY = 'market:stablecoins:v1';

// Request-driven gap lookups get their own key space. The seed key stays
// seed-owned: a request that ends in a negative sentinel must never overwrite
// Railway's last-good snapshot (same rule as get-country-stock-index.ts).
const GAP_CACHE_KEY_PREFIX = 'market:stablecoins:rpc:v1:';
const GAP_CACHE_TTL = 600; // 10 min — matches the seeder's cron cadence
const GAP_NEGATIVE_TTL = 300; // 5 min — how long "CoinGecko has no such coin" sticks
// A fallback answer that covered only part of the set is a degraded result
// wearing a healthy cache entry. Short enough that CoinGecko's recovery is
// picked up on the next cycle rather than a full TTL later.
const GAP_DEGRADED_TTL = 60;
// Above _shared's UPSTREAM_TIMEOUT_MS (10s) plus the CoinPaprika fallback leg,
// so the cache layer stays the last-resort bound rather than pre-empting the
// fetcher's own timeouts.
const GAP_FETCH_TIMEOUT_MS = 25_000;

// Bounds the provider lookup, not the request: IDs past the cap are reported
// as OVER_CAP rather than dropped, so a caller can tell a truncated request
// from a coin that does not exist.
const MAX_LOOKUP_COINS = 25;
// A rejected ID is echoed back so the caller can spot the typo. Truncated
// because the value is untrusted and arbitrarily long.
const MAX_ECHOED_ID_LENGTH = 64;

// CoinGecko IDs are lowercase alphanumerics and hyphens. Anchored, with no
// nested quantifier or alternation, so it is linear on any input.
const COINGECKO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Closed vocabularies, exported so tests can pin them against the proto
 * comment that publishes them. `reason` and `dataStatus` are plain strings on
 * the wire, so nothing but these types stops a fifth value appearing.
 */
export const UNRESOLVED_REASONS = Object.freeze([
  'INVALID_ID',
  'OVER_CAP',
  'NOT_FOUND',
  'PROVIDER_ERROR',
] as const);
export const DATA_STATUSES = Object.freeze(['OK', 'PARTIAL', 'UNAVAILABLE'] as const);

type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];
type DataStatus = (typeof DATA_STATUSES)[number];

function unresolvedEntry(id: string, reason: UnresolvedReason): UnresolvedStablecoin {
  return { id, reason };
}

interface SeedSnapshot {
  timestamp?: string;
  stablecoins?: unknown;
}

interface GapPayload {
  coins: Stablecoin[];
  source: CryptoMarketsSource;
  /** When the provider actually answered — NOT when this response was built. */
  fetchedAt: string;
}

/**
 * Redis payloads are untrusted input, not typed values — a cast is a promise
 * TypeScript cannot keep. One `null` row inside `stablecoins` would throw while
 * summarizing and turn the dashboard's own request into a 500, so rows are
 * filtered rather than asserted. `id` is the only field worth gating on: it is
 * the merge key, and a row without one cannot be matched to a request anyway.
 */
function isUsableStablecoin(value: unknown): value is Stablecoin {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as Stablecoin).id === 'string'
    && (value as Stablecoin).id.length > 0,
  );
}

/**
 * Every field is checked, `source` included. A payload missing it would read as
 * a CoinGecko answer, and a CoinGecko answer is what makes "absent" credible —
 * so a shape we cannot fully verify must never be allowed to produce NOT_FOUND.
 */
function isGapPayload(value: unknown): value is GapPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as GapPayload;
  return Array.isArray(payload.coins)
    && (payload.source === 'coingecko' || payload.source === 'coinpaprika')
    && typeof payload.fetchedAt === 'string';
}

function unavailableResponse(unresolved: UnresolvedStablecoin[]): ListStablecoinMarketsResponse {
  return {
    timestamp: new Date().toISOString(),
    summary: summarize([]),
    stablecoins: [],
    unresolved,
    dataStatus: 'UNAVAILABLE',
  };
}

/**
 * Aggregates over exactly the coins passed in.
 *
 * `healthStatus` is peg health and says nothing about coverage — a one-coin
 * request for a depegged coin is a truthful CAUTION, not a data problem. The
 * empty case keeps the 'UNAVAILABLE' string the pre-#6308 empty response used,
 * so existing clients see no new value there; `dataStatus` is where coverage
 * is actually reported.
 */
function healthStatusFor(coinCount: number, depeggedCount: number): string {
  if (coinCount === 0) return 'UNAVAILABLE';
  if (depeggedCount === 0) return 'HEALTHY';
  if (depeggedCount === 1) return 'CAUTION';
  return 'WARNING';
}

function summarize(coins: Stablecoin[]): StablecoinSummary {
  let totalMarketCap = 0;
  let totalVolume24h = 0;
  let depeggedCount = 0;

  for (const coin of coins) {
    if (Number.isFinite(coin.marketCap)) totalMarketCap += coin.marketCap;
    if (Number.isFinite(coin.volume24h)) totalVolume24h += coin.volume24h;
    if (coin.pegStatus === 'DEPEGGED') depeggedCount++;
  }

  return {
    totalMarketCap,
    totalVolume24h,
    coinCount: coins.length,
    depeggedCount,
    healthStatus: healthStatusFor(coins.length, depeggedCount),
  };
}

/**
 * Trims, lowercases, and de-duplicates the requested IDs, splitting them into
 * the ones worth looking up and the ones that are already answered.
 *
 * Both wire forms are accepted. `parseStringArray` only splits on commas when
 * it is handed a bare string, but the generated route reads this field with
 * `params.getAll("coins")`, so `?coins=tether,dai` arrives as a ONE-element
 * array holding "tether,dai" — the documented comma form would go unsplit
 * without the inner split here. Splitting is lossless: a CoinGecko ID cannot
 * contain a comma, so a comma-bearing token could only ever be rejected.
 *
 * A duplicate is not a failure — callers concatenating lists should not be
 * punished — so it collapses silently. A malformed or over-cap ID IS reported:
 * dropping it is what made the old handler's behavior undiagnosable.
 */
function normalizeRequestedCoins(raw: unknown): {
  lookupIds: string[];
  unresolved: UnresolvedStablecoin[];
} {
  const seen = new Set<string>();
  const lookupIds: string[] = [];
  const unresolved: UnresolvedStablecoin[] = [];

  for (const value of parseStringArray(raw)) {
    if (typeof value !== 'string') continue;
    for (const part of value.split(',')) {
      const id = part.trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      if (!COINGECKO_ID_PATTERN.test(id)) {
        unresolved.push(unresolvedEntry(id.slice(0, MAX_ECHOED_ID_LENGTH), 'INVALID_ID'));
      } else if (lookupIds.length >= MAX_LOOKUP_COINS) {
        unresolved.push(unresolvedEntry(id, 'OVER_CAP'));
      } else {
        lookupIds.push(id);
      }
    }
  }

  return { lookupIds, unresolved };
}

/**
 * Resolves IDs the snapshot does not carry, in ONE batched provider call.
 *
 * Keyed on the exact ID SET, so reuse is per request shape, not per coin:
 * `[frax]` and `[frax, paxos-standard]` are different keys and each fetches
 * frax. Deliberate for now — nothing sends a non-empty `coins` yet (the panel
 * sends `[]`), so per-coin keys would optimise a traffic pattern that does not
 * exist, and the per-ID negative-caching they need has to keep the
 * PROVIDER_ERROR/NOT_FOUND split intact. Revisit when a real caller with
 * overlapping ID sets appears; the 25-ID cap and the endpoint rate policy are
 * what bound the cost until then.
 * `cacheFetcherErrors: false` is load-bearing: it keeps a provider outage
 * (rethrown, reported PROVIDER_ERROR, retried after a short backoff) distinct
 * from a definitive "no such coin" (cached negative, reported NOT_FOUND).
 * Caching the outage would answer the next caller with the wrong reason for
 * five minutes.
 *
 * `providerFailed` is the "we cannot claim absence" flag, and a successful
 * CoinPaprika answer sets it too: that leg only covers IDs in its mapping
 * table, so an ID missing from a fell-back result was never actually looked
 * up. It is cached alongside the coins so a cache hit keeps the distinction.
 */
async function resolveGapCoins(ids: string[]): Promise<{
  resolved: Map<string, Stablecoin>;
  providerFailed: boolean;
  fetchedAt: string | null;
}> {
  const resolved = new Map<string, Stablecoin>();
  if (ids.length === 0) return { resolved, providerFailed: false, fetchedAt: null };

  // sha256 rather than the raw ID list: the key is derived from caller-supplied
  // input, and the list is unbounded in length.
  const cacheKey = `${GAP_CACHE_KEY_PREFIX}${await sha256Hex([...ids].sort().join(','))}`;

  try {
    let incompleteFallback = false;
    const payload = await cachedFetchJson<GapPayload>(
      cacheKey,
      GAP_CACHE_TTL,
      async () => {
        // The last check before spending. cachedFetchJson does its own read and
        // treats a READ ERROR as a miss, running the fetcher regardless — so
        // checking the key only before calling it leaves the fan-out open to a
        // Redis fault that lands in between. This runs once per key rather than
        // once per caller, because cachedFetchJson coalesces. A residual window
        // remains between this read and the fetch below; closing that too would
        // mean reimplementing the coalescing, which is not worth it.
        const recheck = await readCachedJson(cacheKey);
        if (recheck.status === 'error') {
          throw new Error('gap cache unreadable — refusing to reach the provider');
        }
        if (recheck.status === 'hit' && isGapPayload(recheck.value)) return recheck.value;

        const { items, source } = await fetchCryptoMarketsWithSource(ids, {
          sparkline: false,
          priceChangePercentage: '24h,7d',
        });
        const requested = new Set(ids);
        const usable = items.filter(
          item => isUsableStablecoin(item) && requested.has(item.id),
        );
        // Rows present but none usable is malformed provider output, not an
        // answer. Returning null here would negative-cache it and report the
        // requested coins as NOT_FOUND — asserting they do not exist on the
        // strength of a response we could not parse. Throwing routes it to
        // PROVIDER_ERROR, and cacheFetcherErrors:false keeps it out of Redis.
        if (usable.length === 0) {
          if (items.length > 0) throw new Error(`provider returned ${items.length} unusable row(s)`);
          return null;
        }
        incompleteFallback = source === 'coinpaprika' && usable.length < ids.length;
        return { coins: usable.map((item) => classifyStablecoin(item)), source, fetchedAt: new Date().toISOString() };
      },
      GAP_NEGATIVE_TTL,
      { timeoutMs: GAP_FETCH_TIMEOUT_MS, cacheFetcherErrors: false },
    );

    // null is cachedFetchJson's negative sentinel: the provider answered and
    // had nothing. Anything else that fails the shape check is a cache entry we
    // cannot read, which is not evidence of absence.
    if (payload === null) return { resolved, providerFailed: false, fetchedAt: null };
    if (!isGapPayload(payload)) return { resolved, providerFailed: true, fetchedAt: null };

    for (const coin of payload.coins) {
      if (isUsableStablecoin(coin)) resolved.set(coin.id, coin);
    }

    // An incomplete fallback answer must not stay authoritative for the full
    // TTL. CoinPaprika can only map part of the set, so the IDs it could not
    // reach keep reporting PROVIDER_ERROR — for ten minutes after CoinGecko
    // recovers, on a cache entry that looks perfectly healthy.
    if (incompleteFallback) await setCachedJson(cacheKey, payload, GAP_DEGRADED_TTL);

    return {
      resolved,
      providerFailed: payload.source === 'coinpaprika',
      fetchedAt: payload.fetchedAt,
    };
  } catch (err) {
    // sentry-coverage-ok: this failure is reported IN BAND rather than silently
    // — every affected ID comes back to the caller as PROVIDER_ERROR and the
    // response as PARTIAL/UNAVAILABLE, which is the whole point of #6308's
    // attribution fields. Swallowing here is what converts the throw into that
    // contract; rethrowing would 500 a request the seed could still partly
    // answer.
    console.warn('[Stablecoin] gap lookup failed:', (err as Error).message);
    return { resolved, providerFailed: true, fetchedAt: null };
  }
}

export async function listStablecoinMarkets(
  _ctx: ServerContext,
  req: ListStablecoinMarketsRequest,
): Promise<ListStablecoinMarketsResponse> {
  const { lookupIds, unresolved } = normalizeRequestedCoins(req?.coins);

  // readCachedJson, not getCachedJson: the latter collapses "the snapshot is
  // absent" and "Redis is unreachable" into one null, and those must diverge
  // here. A Redis outage makes every requested ID look like a gap, which would
  // turn one bad minute for Upstash into a full-rate, uncached CoinGecko
  // fan-out from the edge — with the gap cache and the rate limiter, which
  // both live in that same Redis, unable to stop it. So a read ERROR suppresses
  // provider work entirely; only a genuine miss lets a lookup proceed.
  const seedRead = await readCachedJson(SEED_CACHE_KEY, true);
  const seedUnreachable = seedRead.status === 'error';
  const seed = seedRead.status === 'hit' ? seedRead.value as SeedSnapshot : null;
  const rawSeedCoins = seed?.stablecoins;
  const seedRows = Array.isArray(rawSeedCoins) ? rawSeedCoins : [];
  const seedCoins = seedRows.filter(isUsableStablecoin);
  // A snapshot that parsed but yielded no usable row is CORRUPT, not empty, and
  // the difference decides whether we spend money. Treated as empty, every
  // named default becomes a gap and goes to CoinGecko — the same amplification
  // the unreachable branch above exists to prevent, reached through a readable
  // Redis instead of a broken one.
  const seedCorrupt = seedRows.length > 0 && seedCoins.length === 0;
  const seedUnusable = seedUnreachable || seedCorrupt;

  // Default request: the seeded snapshot verbatim, no upstream work, ever.
  if (lookupIds.length === 0 && unresolved.length === 0) {
    if (seedCoins.length === 0) return unavailableResponse([]);
    return {
      timestamp: seed?.timestamp || new Date().toISOString(),
      summary: summarize(seedCoins),
      stablecoins: seedCoins,
      unresolved: [],
      dataStatus: 'OK',
    };
  }

  const seedById = new Map(seedCoins.map(coin => [coin.id, coin]));
  const gapIds = seedUnusable ? [] : lookupIds.filter(id => !seedById.has(id));
  const { resolved, providerFailed: lookupFailed, fetchedAt: gapFetchedAt } =
    await resolveGapCoins(gapIds);
  // An ID we declined to look up is unknown, not absent — same reason a failed
  // lookup reports. Reporting NOT_FOUND here would assert the coin does not
  // exist on the strength of a Redis outage or a corrupt snapshot.
  const providerFailed = lookupFailed || seedUnusable;

  const stablecoins: Stablecoin[] = [];
  for (const id of lookupIds) {
    const coin = seedById.get(id) ?? resolved.get(id);
    if (coin) {
      stablecoins.push(coin);
    } else {
      unresolved.push(unresolvedEntry(id, providerFailed ? 'PROVIDER_ERROR' : 'NOT_FOUND'));
    }
  }

  if (stablecoins.length === 0) return unavailableResponse(unresolved);

  // The timestamp must describe the OLDEST row present, since that is what a
  // consumer checks for staleness. Each contributing source reports its own
  // age: the snapshot its seed time, the gap lookup the moment the provider
  // actually answered — which is NOT now when the result came from the gap
  // cache, and stamping now there would hide up to a full TTL of age.
  const ages: string[] = [];
  if (stablecoins.some(coin => seedById.has(coin.id)) && seed?.timestamp) {
    ages.push(seed.timestamp);
  }
  if (stablecoins.some(coin => !seedById.has(coin.id)) && gapFetchedAt) {
    ages.push(gapFetchedAt);
  }
  const dataStatus: DataStatus = unresolved.length === 0 ? 'OK' : 'PARTIAL';

  return {
    // ISO-8601 UTC sorts lexicographically, so the first is the oldest.
    timestamp: ages.sort()[0] ?? new Date().toISOString(),
    summary: summarize(stablecoins),
    stablecoins,
    unresolved,
    dataStatus,
  };
}
