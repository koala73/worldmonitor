/**
 * RPC: ListMarketQuotes -- seed-first stock/index quotes.
 *
 * The fixed Railway seed snapshot (`market:stocks-bootstrap:v1`, written by
 * scripts/ais-relay.cjs and scripts/seed-market-quotes.mjs) answers the default
 * symbol universe with no upstream call at all. Only symbols the snapshot does
 * not carry — the user's custom watchlist tickers, which the picker resolved
 * through Finnhub search, plus any default the seeder dropped this cycle —
 * reach a provider, through a bounded, Redis-cached gap fetch (#6305). Every
 * requested symbol that produces no quote comes back in `unavailable` with a
 * reason; none is silently dropped.
 *
 * Bounds, all deliberate and all tested:
 *   - MARKET_QUOTES_REQUEST_LIMIT  symbols accepted per request
 *   - MARKET_QUOTES_UPSTREAM_LIMIT provider lookups attempted per request
 *   - UPSTREAM_CONCURRENCY         provider lookups in flight at once
 *   - UPSTREAM_DEADLINE_MS         wall-clock budget for the whole gap fetch
 *   - QUOTE_PROVIDER_TIMEOUT_MS    per-symbol upstream timeout
 *
 * A transient provider failure is never cached; only a definitive "this symbol
 * does not exist" is, and only for QUOTE_NEGATIVE_TTL_SECONDS. A seed read that
 * misses or fails never falls through to the provider — that would turn one
 * degraded snapshot into a per-caller fan-out of every requested symbol.
 *
 * The route carries an explicit fail-closed endpoint rate policy
 * (`server/_shared/rate-limit.ts`) because it is now provider-backed.
 */

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  MarketQuote,
  MarketQuoteUnavailable,
  MarketQuoteUnavailableReason,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray, sanitizeSymbol } from './_shared';
import {
  providerNotConfiguredReason,
  resolveMarketQuoteProvider,
  type ProviderQuote,
} from './_quote-provider';
import { CachedFetchTimeoutError, cachedFetchJson, readCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';

/** Per-symbol gap-fetch cache. Prefixed (app-owned), unlike the seed key. */
const QUOTE_CACHE_KEY_PREFIX = 'market:custom-quote:v1';
/** Matches the 5-minute Railway seed cadence, so custom tickers age like seeded ones. */
const QUOTE_CACHE_TTL_SECONDS = 300;
/** A symbol the provider does not know stays negative-cached this long. */
const QUOTE_NEGATIVE_TTL_SECONDS = 900;

/**
 * Accepted symbols per request. The dashboard sends the 59-symbol default
 * universe plus up to MARKET_WATCHLIST_MAX_ENTRIES (50) custom tickers; the
 * headroom above 109 absorbs config growth without silently truncating. Beyond
 * this, the extra symbols are reported as REQUEST_LIMIT_EXCEEDED — the bound
 * caps Redis and CDN cache-key cardinality for caller-controlled input.
 */
export const MARKET_QUOTES_REQUEST_LIMIT = 120;

/**
 * Provider lookups attempted per request. A watchlist with more misses than
 * this fills over successive refreshes as each cycle caches what it resolved;
 * the remainder is reported as UPSTREAM_BUDGET_EXHAUSTED rather than omitted.
 */
export const MARKET_QUOTES_UPSTREAM_LIMIT = 10;

/** In-flight provider lookups. The provider's own request gate paces the starts. */
const UPSTREAM_CONCURRENCY = 4;

/** Wall-clock budget for the whole gap fetch, enforced across every lookup. */
const UPSTREAM_DEADLINE_MS = 6_000;
let upstreamDeadlineMs = UPSTREAM_DEADLINE_MS;

export function __setUpstreamDeadlineForTests(ms: number): void {
  upstreamDeadlineMs = ms;
}

export function __resetUpstreamDeadlineForTests(): void {
  upstreamDeadlineMs = UPSTREAM_DEADLINE_MS;
}

/**
 * Ceiling for one cached lookup: the provider's own timeout plus slack for the
 * surrounding Redis round-trips, so `cachedFetchJson`'s 30s default can never
 * outlive the request.
 */
export const QUOTE_PROVIDER_CALL_BUDGET_MS = 5_000;

/**
 * Slack that keeps the per-call backstop from expiring on the same tick as the
 * wall-clock deadline. See `gapFetchCallTimeoutMs` for why a tie is not benign.
 */
export const CALL_TIMEOUT_DEADLINE_GRACE_MS = 50;

type Reason = MarketQuoteUnavailableReason;

const REASON = {
  notFound: 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND',
  providerError: 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_ERROR',
  rateLimited: 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_RATE_LIMITED',
  notConfigured: 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_NOT_CONFIGURED',
  requestLimit: 'MARKET_QUOTE_UNAVAILABLE_REASON_REQUEST_LIMIT_EXCEEDED',
  budget: 'MARKET_QUOTE_UNAVAILABLE_REASON_UPSTREAM_BUDGET_EXHAUSTED',
  seedUnavailable: 'MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE',
} satisfies Record<string, Reason>;

/**
 * Normalize, de-duplicate (first occurrence wins), and bound the requested
 * symbols. Returns the accepted list in requested order plus the symbols the
 * cardinality bound dropped, so the caller can report them.
 */
export function normalizeRequestedSymbols(
  raw: string[],
  limit: number = MARKET_QUOTES_REQUEST_LIMIT,
): { accepted: string[]; dropped: string[] } {
  const seen = new Set<string>();
  const accepted: string[] = [];
  const dropped: string[] = [];

  for (const value of raw) {
    const symbol = sanitizeSymbol(value);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    if (accepted.length < limit) accepted.push(symbol);
    else dropped.push(symbol);
  }

  return { accepted, dropped };
}

/**
 * Filter a seed snapshot down to the requested symbols, in REQUESTED order.
 *
 * Seed payloads carry the seeder's own ordering; the client pairs each quote
 * with its watchlist metadata by symbol, so answering in the caller's order
 * keeps the merged response (seed hits plus gap-fetched custom tickers) in one
 * predictable sequence.
 */
export function filterMarketQuotes(
  bootstrap: ListMarketQuotesResponse,
  symbols: string[],
): ListMarketQuotesResponse {
  if (symbols.length === 0) return bootstrap;
  const bySymbol = new Map(bootstrap.quotes.map((quote) => [quote.symbol, quote]));
  return {
    ...bootstrap,
    quotes: symbols
      .map((symbol) => bySymbol.get(symbol))
      .filter((quote): quote is MarketQuote => quote != null),
  };
}

async function forEachWithConcurrency(
  items: string[],
  concurrency: number,
  worker: (item: string) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        await worker(items[next++]!);
      }
    }),
  );
}

interface GapFetchResult {
  quotes: Map<string, ProviderQuote>;
  reasons: Map<string, Reason>;
  rateLimited: boolean;
  providerConfigured: boolean;
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * `cachedFetchJson`'s inflight timeout for one lookup, given the wall-clock
 * window still left before the gap-fetch deadline.
 *
 * That timeout is a *backstop* — it exists only so a fetcher that never settles
 * cannot pin the inflight slot for the isolate's life. Sizing it to exactly
 * `remainingMs` made it expire on the same tick as the deadline, and Node ran
 * whichever timer its queue happened to order first: when the backstop won, the
 * signal had not flipped yet and our own cutoff was billed to the provider as
 * PROVIDER_ERROR (#6468).
 *
 * The invariant that removes that race is that the two never expire together,
 * and which one binds depends on the window:
 *   - `remainingMs <= QUOTE_PROVIDER_CALL_BUDGET_MS` — the deadline binds, so
 *     the backstop sits a grace *later* and the deadline always cuts first.
 *   - `remainingMs >  QUOTE_PROVIDER_CALL_BUDGET_MS` — the call budget binds,
 *     so the backstop fires *earlier*, on its own, well before the deadline.
 * Neither branch can return `remainingMs`, so no window ties. The obvious
 * `Math.min(BUDGET, remainingMs) + GRACE` spelling does not hold this: it ties
 * at exactly `BUDGET + GRACE`, a window a lane reaches whenever it starts a
 * lookup `GRACE`ms into a request.
 *
 * A cutoff in the second regime is still reported as the provider's — see
 * `classifyGapFetchFailure`, which only charges the budget at the deadline.
 */
export function gapFetchCallTimeoutMs(remainingMs: number): number {
  const remaining = Math.max(0, remainingMs);
  return remaining <= QUOTE_PROVIDER_CALL_BUDGET_MS
    ? remaining + CALL_TIMEOUT_DEADLINE_GRACE_MS
    : QUOTE_PROVIDER_CALL_BUDGET_MS;
}

/**
 * Why one lookup produced no quote, decided without reference to which timer
 * callback ran first.
 *
 * `deadlineSignal.aborted` and `Date.now()` disagree at the boundary in *both*
 * directions — the abort timer runs off libuv's monotonic clock, `Date.now()`
 * off the wall clock — so either one alone mis-reads a cutoff that is ours.
 * Reading them together makes a lookup that died at the boundary UPSTREAM_
 * BUDGET_EXHAUSTED however the two clocks happen to be skewed.
 *
 * The deadline test stays *ahead* of `recorded` on purpose: an abort makes the
 * provider adapter's own fetch reject, which it reports as `status: 'error'`.
 * That entry describes our cutoff, not the provider, so it must not win here.
 * Within the window `recorded` is the provider's real verdict and is used as-is;
 * a failure with no verdict at all is still charged to the provider.
 *
 * One consequence, unchanged in kind from the abort-only precedence this
 * replaces: a `rate_limited` verdict landing in the same millisecond as the
 * deadline reads as budget, so it does not raise the response-level
 * `rateLimited` flag. At that instant we are out of budget either way, and the
 * next refresh re-attempts the symbol.
 */
export function classifyGapFetchFailure(input: {
  deadlineAborted: boolean;
  now: number;
  deadline: number;
  recorded: Reason | undefined;
}): Reason {
  const { deadlineAborted, now, deadline, recorded } = input;
  if (deadlineAborted || now >= deadline) return REASON.budget;
  return recorded ?? REASON.providerError;
}

/**
 * Resolve seed misses through the provider, one Redis-cached lookup per symbol.
 *
 * Returns a quote for each symbol it resolved and a reason for each it did not.
 * Symbols the provider cannot serve, symbols beyond the count budget, and
 * symbols reached after the deadline are never fetched — they are reported so
 * the next cycle can retry them.
 */
async function resolveMissingSymbols(missing: string[]): Promise<GapFetchResult> {
  const quotes = new Map<string, ProviderQuote>();
  const reasons = new Map<string, Reason>();

  const provider = resolveMarketQuoteProvider();
  if (!provider) {
    for (const symbol of missing) reasons.set(symbol, REASON.notConfigured);
    return { quotes, reasons, rateLimited: false, providerConfigured: false };
  }

  const serviceable: string[] = [];
  for (const symbol of missing) {
    if (provider.canQuote(symbol)) serviceable.push(symbol);
    else reasons.set(symbol, REASON.notFound);
  }

  const attempted = serviceable.slice(0, MARKET_QUOTES_UPSTREAM_LIMIT);
  for (const symbol of serviceable.slice(MARKET_QUOTES_UPSTREAM_LIMIT)) reasons.set(symbol, REASON.budget);

  const deadline = Date.now() + upstreamDeadlineMs;
  const deadlineSignal = AbortSignal.timeout(upstreamDeadlineMs);
  let rateLimited = false;

  // The fetcher records the live outcome here before returning or throwing:
  // `cachedFetchJson` collapses "not found" to null and "failed" to a throw,
  // and only the fetcher knows which happened. A symbol with no entry after the
  // call was answered from a cached negative — written only for a definitive
  // not-found, never for a transient failure (cacheFetcherErrors: false).
  const liveOutcomes = new Map<string, Reason>();

  /** One entry per cut-off lookup, emitted as a single line after the fan-out. */
  const cutoffs: Array<{ reason: Reason; marginMs: number; err: string }> = [];

  await forEachWithConcurrency(attempted, UPSTREAM_CONCURRENCY, async (symbol) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || deadlineSignal.aborted) {
      reasons.set(symbol, REASON.budget);
      return;
    }

    try {
      const cached = await waitForAbort(cachedFetchJson<ProviderQuote>(
        `${QUOTE_CACHE_KEY_PREFIX}:${symbol}`,
        QUOTE_CACHE_TTL_SECONDS,
        async () => {
          const outcome = await provider.fetchQuote(symbol, deadlineSignal);
          if (outcome.status === 'ok') return outcome.quote;
          if (outcome.status === 'not_found') {
            liveOutcomes.set(symbol, REASON.notFound);
            return null; // definitive — safe to negative-cache
          }
          // Transient. Throwing with cacheFetcherErrors:false keeps it out of
          // Redis, so a provider blip cannot pin a real symbol as unavailable.
          liveOutcomes.set(symbol, outcome.status === 'rate_limited' ? REASON.rateLimited : REASON.providerError);
          throw new Error(outcome.status === 'rate_limited' ? 'provider rate limited' : outcome.message);
        },
        QUOTE_NEGATIVE_TTL_SECONDS,
        { timeoutMs: gapFetchCallTimeoutMs(remainingMs), cacheFetcherErrors: false },
      ), deadlineSignal);

      if (cached) quotes.set(symbol, cached);
      else reasons.set(symbol, liveOutcomes.get(symbol) ?? REASON.notFound);
    } catch (err) {
      const now = Date.now();
      const reason = classifyGapFetchFailure({
        deadlineAborted: deadlineSignal.aborted,
        now,
        deadline,
        recorded: liveOutcomes.get(symbol),
      });
      reasons.set(symbol, reason);
      if (reason === REASON.rateLimited) rateLimited = true;
      // `marginMs` is how much of the window was left when a cutoff fired:
      // <= 0 is the deadline, a large positive is the cache-layer backstop.
      // Ordinary provider failures, rate limits, and unavailable backoffs are
      // outcomes, not cutoffs, and stay out of this operational signal.
      if (reason === REASON.budget || err instanceof CachedFetchTimeoutError) {
        cutoffs.push({ reason, marginMs: deadline - now, err: err instanceof Error ? err.name : typeof err });
      }
    }
  });

  // #6468 was invisible in aggregate: the reason a lookup failed reaches
  // exactly one consumer — an i18n string in the dashboard — so the whole
  // incident was diagnosable only by a human noticing PROVIDER_ERROR creeping
  // up. One line per gap fetch (never per symbol) makes the split queryable,
  // and a `marginMs` trending toward 0 is the early warning that the deadline
  // and the backstop are converging again. Only cut-off lookups are logged;
  // a not-found ticker is routine and already visible to the caller.
  if (cutoffs.length > 0) {
    console.warn(`[ListMarketQuotes] gap-fetch cutoffs ${JSON.stringify({ attempted: attempted.length, cutoffs })}`);
  }

  return { quotes, reasons, rateLimited, providerConfigured: true };
}

function seedUnavailableResponse(symbols: string[]): ListMarketQuotesResponse {
  return {
    quotes: [],
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
    unavailableSymbols: symbols.map((symbol) => ({ symbol, reason: REASON.seedUnavailable })),
  };
}

export async function listMarketQuotes(
  _ctx: ServerContext,
  req: ListMarketQuotesRequest,
): Promise<ListMarketQuotesResponse> {
  const { accepted, dropped } = normalizeRequestedSymbols(parseStringArray(req.symbols));

  const seed = await readCachedJson(BOOTSTRAP_KEY, true);
  if (seed.status === 'error') {
    // Distinguished from a miss on purpose: a read failure that looks like an
    // empty snapshot is how a dead pipeline stays invisible.
    console.warn('[ListMarketQuotes] seed read failed — skipping the provider gap fetch');
    return seedUnavailableResponse([...accepted, ...dropped]);
  }

  const bootstrap = seed.status === 'hit' ? (seed.value as ListMarketQuotesResponse | null) : null;
  // Array.isArray, not a truthy `.length`: the previous implementation wrapped
  // the whole handler in a try/catch, so a corrupt snapshot degraded to an
  // empty response instead of throwing. Validate the shape to keep that
  // fail-soft behaviour without the catch-all that also hid real bugs.
  if (!Array.isArray(bootstrap?.quotes) || bootstrap.quotes.length === 0) {
    return seedUnavailableResponse([...accepted, ...dropped]);
  }

  // No symbol filter: the caller wants the seed universe as-is.
  if (accepted.length === 0) return { ...bootstrap, unavailableSymbols: bootstrap.unavailableSymbols ?? [] };

  const seeded = filterMarketQuotes(bootstrap, accepted);
  const seededBySymbol = new Map(seeded.quotes.map((quote) => [quote.symbol, quote]));
  const missing = accepted.filter((symbol) => !seededBySymbol.has(symbol));

  const overflow: MarketQuoteUnavailable[] = dropped.map((symbol) => ({
    symbol,
    reason: REASON.requestLimit,
  }));

  // Every requested symbol is seeded — the whole point of the seed-first order.
  if (missing.length === 0) {
    return {
      quotes: seeded.quotes,
      finnhubSkipped: false,
      skipReason: '',
      rateLimited: false,
      unavailableSymbols: overflow,
    };
  }

  const resolved = await resolveMissingSymbols(missing);

  const quotes: MarketQuote[] = [];
  const unavailable: MarketQuoteUnavailable[] = [];
  for (const symbol of accepted) {
    const seedQuote = seededBySymbol.get(symbol);
    if (seedQuote) {
      quotes.push(seedQuote);
      continue;
    }
    const fetched = resolved.quotes.get(symbol);
    if (fetched) {
      // The client re-attaches the watchlist label by symbol; the provider has
      // no friendly name to offer, so the symbol stands in for both.
      quotes.push({
        symbol,
        name: symbol,
        display: symbol,
        price: fetched.price,
        change: fetched.change,
        sparkline: fetched.sparkline,
      });
      continue;
    }
    unavailable.push({ symbol, reason: resolved.reasons.get(symbol) ?? REASON.notFound });
  }

  const skipped = !resolved.providerConfigured;
  return {
    quotes,
    finnhubSkipped: skipped,
    skipReason: skipped ? providerNotConfiguredReason() : '',
    rateLimited: resolved.rateLimited,
    unavailableSymbols: [...unavailable, ...overflow],
  };
}
