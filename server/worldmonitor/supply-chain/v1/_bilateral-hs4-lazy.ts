import {
  HS4_CODES, HS4_BATCHES, PREVIEW_MAX_RECORDS, parseRecords, groupByProduct, comtradeFailureState,
  toCanonicalProduct, toPartnersProduct,
} from '../../../../scripts/shared/comtrade';
/**
 * Lazy-fetch fallback for the bilateral-hs4 store.
 *
 * Two paths share the provider plumbing and nothing else.
 *
 * Full catalogue — `lazyFetchBilateralHs4`. Callers: get-route-impact and
 * get-country-chokepoint-index when `comtrade:bilateral-hs4:{iso2}:v1` is
 * missing, and get-country-products when the payload is missing or older than
 * its freshness window. Requests the same catalogue as
 * `seed-comtrade-bilateral-hs4.mjs`, from the public preview route.
 *
 * Writes:
 *   - Cold success (no previous payload): the canonical key via SET NX with a
 *     40-day TTL, so a scheduled write that lands mid-fetch is never replaced.
 *   - Warm success (a previous payload exists): the sentinel key only, as
 *     {state:'observed', payload} for 24h. The canonical key stays untouched.
 *   - Valid empty, unsupported reporter, 429, capped or regressed refresh: a
 *     24h sentinel.
 *   - Unavailable (HTTP error, timeout) or malformed: a short sentinel, so a
 *     failing provider is not re-requested on every read.
 *   Both writes carry the canonical row shape: leading-5 `topExporters` and no
 *   partner detail. Three scorers sum over every `topExporters` row and two bulk
 *   pipelines read all 197 keys under a 4.5 MB ceiling, so the extra partner
 *   list the shared catalogue now returns is stripped here (KTD1).
 *
 * Single heading — `lazyFetchHeading`. Caller: get-country-products when the
 * stored payload lacks exactly the heading a Pro user asked for. One request,
 * a per-heading sentinel, and the sibling partner shape the brief reads. It
 * never writes the canonical key or the per-country sentinel, so one heading's
 * outcome cannot suppress another's for a day (KTD5).
 *
 * Constraints:
 *   - Concurrency cap: 1 fetch at a time per instance (Comtrade public rate ~1 req/sec)
 *   - Timeout: 5s shared across every batch of one call and the pauses between them
 */

import type { BilateralHs4Payload } from './get-country-products';
import { readCachedJson, setCachedJson, setCachedJsonIfAbsent } from '../../../_shared/redis';
import UN_TO_ISO2 from '../../../../scripts/shared/un-to-iso2.json';
import COMTRADE_REPORTER_OVERRIDES from '../../../../scripts/shared/comtrade-reporter-overrides.json';

import { recentPeriod } from '../../../../scripts/shared/comtrade-period.mjs';

const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
const LAZY_SENTINEL_PREFIX = 'comtrade:bilateral-hs4-lazy-sentinel:';
const LAZY_HEADING_PREFIX = 'comtrade:bilateral-hs4-lazy-heading:';
const SUCCESS_TTL = 3456000; // 40 days
const EMPTY_TTL = 86400; // 24h
const FAILURE_TTL = 600; // 10 min: bounds retries against a failing provider
const FETCH_TIMEOUT_MS = 5000;


// Unlike scripts/seed-comtrade-bilateral-hs4.mjs, this path does NOT fall back
// to (y-3) when (y-2) is empty: it runs inside a live request, and the two
// catalogue batches already share the whole FETCH_TIMEOUT_MS budget. The 24h
// no_records sentinel bounds the staleness from a reporter that has not yet
// filed (y-2) — far tighter than the bulk seeder's 40-day cache, which is why
// that path carries the fallback instead.

// UN M49 mostly matches UN Comtrade reporterCodes, except the shared override
// list. Using M49 codes for those reporters silently yields count:0.
const ISO2_TO_UN: Record<string, string> = Object.fromEntries(
  Object.entries(UN_TO_ISO2 as Record<string, string>).map(([un, iso]) => [iso, un]),
);
for (const [iso2, code] of Object.entries(COMTRADE_REPORTER_OVERRIDES as Record<string, string>)) {
  ISO2_TO_UN[iso2] = code;
}

let fetchInFlight = false;

interface ProductExporter {
  partnerCode: number;
  partnerIso2: string;
  value: number;
  share: number;
}

/** A ranked origin with the volume evidence only the sibling key carries. */
export interface PartnerRow extends ProductExporter {
  netWeightKg: number | null;
  netWeightEstimated: boolean;
  quantity: number | null;
  quantityUnitCode: number | null;
}

interface CountryProduct {
  hs4: string;
  description: string;
  totalValue: number;
  topExporters: ProductExporter[];
  year: number;
  denominatorBasis?: string;
}

/**
 * One heading in the shape of `comtrade:bilateral-hs4-partners:{iso2}:v1`, so a
 * recovered heading and a seeded one merge through the same reader branch.
 */
export interface PartnersProduct {
  hs4: string;
  year: number;
  denominatorBasis?: string;
  totalValue: number;
  worldNetWeightKg: number | null;
  partners: PartnerRow[];
  omittedCount: number;
  omittedShare: number;
}

/** What `groupByProduct` returns: the canonical row plus the partner detail. */
type CatalogueProduct = CountryProduct & { partners: PartnerRow[]; worldNetWeightKg: number | null };

interface ComtradeResult {
  products: CatalogueProduct[];
  rateLimited: boolean;
  failed: boolean;
}

export type LazyAttemptState =
  | 'observed' | 'no_records' | 'unsupported_reporter' | 'legacy_no_records' | 'rate_limited'
  | 'unavailable' | 'malformed' | 'incomplete' | 'regression_rejected'
  | 'cache_unavailable' | 'cache_write_failed';

// Read back as the same permanent `empty` source the first response returned.
const PERMANENT_EMPTY_STATES = new Set<string>(['no_records', 'unsupported_reporter']);

/** Gap the public preview route needs between two requests (about 1 per second). */
export const UPSTREAM_GAP_MS = 1100;

/** When one call's provider requests may start and must finish. */
export interface FetchWindow {
  /** Epoch ms before which no request may start: the caller's previous request plus UPSTREAM_GAP_MS. */
  notBefore?: number;
  /** Epoch ms deadline shared with the caller's other requests; capped at FETCH_TIMEOUT_MS from the start. */
  deadlineAt?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch one or more batches of headings for a reporter. The default is the
 * whole catalogue; a single-heading recovery passes `[[hs4]]`, which makes one
 * request and skips the inter-batch pause entirely.
 */
export async function fetchComtradeBilateral(reporterCode: string, batches: string[][] = HS4_BATCHES, timing: FetchWindow = {}): Promise<ComtradeResult> {
  const records = [];
  const wait = (timing.notBefore ?? 0) - Date.now();
  if (wait > 0) await sleep(wait);
  // Every batch shares one request deadline. No partial result is published.
  const signal = AbortSignal.timeout(Math.max(1, Math.min(FETCH_TIMEOUT_MS, (timing.deadlineAt ?? Infinity) - Date.now())));
  for (const [index, codes] of batches.entries()) {
    if (index > 0) await sleep(UPSTREAM_GAP_MS);
    const url = new URL(COMTRADE_BASE);
    url.searchParams.set('reporterCode', reporterCode);
    url.searchParams.set('cmdCode', codes.join(','));
    url.searchParams.set('flowCode', 'M');
    url.searchParams.set('period', recentPeriod());
    // Aggregate-only rows, matching the scheduled seeder. Without these
    // Comtrade returns one row per partner x second partner x transport mode x
    // customs procedure — about 9x — and a large importer fills the preview
    // route's 500-row cap, so every attempt ends `incomplete` no matter how few
    // headings it asked for. groupByProduct already kept the aggregate row per
    // partner, so only the row count changes.
    url.searchParams.set('partner2Code', '0');
    url.searchParams.set('motCode', '0');
    url.searchParams.set('customsCode', 'C00');
    url.searchParams.set('maxRecords', String(PREVIEW_MAX_RECORDS));
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' }, signal,
    });
    if (resp.status === 429) return { products: [], rateLimited: true, failed: false };
    // Any other non-OK status is a provider failure, never a valid empty result.
    if (!resp.ok) return { products: [], rateLimited: false, failed: true };
    records.push(...parseRecords(await resp.json(), PREVIEW_MAX_RECORDS));
  }
  return { products: groupByProduct(records), rateLimited: false, failed: false };
}

export interface LazyFetchResult {
  products: CountryProduct[];
  comtradeSource: 'bilateral-hs4' | 'lazy' | 'empty';
  rateLimited?: boolean;
  state?: LazyAttemptState;
  attemptedAt?: string;
  payload?: BilateralHs4Payload;
  /** Epoch ms at which this call's provider request settled; absent when a sentinel answered without one. */
  upstreamSettledAt?: number;
}

/**
 * Attempt a lazy fetch for a destination country's bilateral HS4 data.
 * Returns null only while another fetch is in flight on this instance.
 * A sentinel short-circuits the fetch: an `observed` sentinel returns its
 * recovered payload unless it is older than `previous` or drops a heading or
 * year that `previous` holds; any other sentinel returns its recorded state,
 * with no_records and unsupported_reporter reported as the permanent `empty`
 * source so callers can tell them from transient failures.
 */
export async function lazyFetchBilateralHs4(iso2: string, previous?: BilateralHs4Payload): Promise<LazyFetchResult | null> {
  const sentinelKey = `${LAZY_SENTINEL_PREFIX}${iso2}:v1`;
  const cached = await readCachedJson(sentinelKey, true);
  if (cached.status === 'error') return { products: [], comtradeSource: 'lazy', state: 'cache_unavailable' };
  const sentinel = (cached.status === 'hit' ? cached.value : null) as { empty?: boolean; rateLimited?: boolean; state?: string; attemptedAt?: string; payload?: BilateralHs4Payload } | null;
  if (sentinel?.state === 'observed') {
    const recovered = sentinel.payload;
    if (recovered?.iso2 === iso2 && Array.isArray(recovered.products)
      && (!previous || Date.parse(recovered.fetchedAt ?? '') >= Date.parse(previous.fetchedAt ?? '')
        && previous.products.every(old => recovered.products.some(p => p.hs4 === old.hs4 && p.year >= old.year)))) {
      return { products: recovered.products, comtradeSource: 'bilateral-hs4', state: 'observed', attemptedAt: sentinel.attemptedAt, payload: recovered };
    }
  } else if (sentinel) {
    if (sentinel.state) {
      return {
        products: [],
        comtradeSource: PERMANENT_EMPTY_STATES.has(sentinel.state) ? 'empty' : 'lazy',
        state: sentinel.state as LazyAttemptState,
        attemptedAt: sentinel.attemptedAt,
      };
    }
    if (sentinel.rateLimited) {
      return { products: [], comtradeSource: 'lazy', rateLimited: true, state: 'rate_limited', attemptedAt: sentinel.attemptedAt };
    }
    return { products: [], comtradeSource: 'empty', state: 'legacy_no_records' };
  }

  if (fetchInFlight) return null;
  fetchInFlight = true;

  const unCode = ISO2_TO_UN[iso2];
  if (!unCode) {
    fetchInFlight = false;
    await setCachedJson(sentinelKey, { state: 'unsupported_reporter' }, EMPTY_TTL, true);
    return { products: [], comtradeSource: 'empty', state: 'unsupported_reporter' };
  }

  const attemptedAt = new Date().toISOString();
  // When the provider request settled, so the caller's next request on the same
  // rate-limited route can wait out the gap after it.
  let upstreamSettledAt: number | undefined;
  const settled = (result: LazyFetchResult): LazyFetchResult => ({ ...result, upstreamSettledAt });
  try {
    const result = await fetchComtradeBilateral(unCode).finally(() => { upstreamSettledAt = Date.now(); });

    if (result.rateLimited) {
      await setCachedJson(sentinelKey, { rateLimited: true, attemptedAt }, EMPTY_TTL, true);
      return settled({ products: [], comtradeSource: 'empty', rateLimited: true, state: 'rate_limited', attemptedAt });
    }

    // Provider failure: a short sentinel stops every read from re-requesting a
    // failing provider, without suppressing recovery for a day.
    if (result.failed) {
      await setCachedJson(sentinelKey, { state: 'unavailable', attemptedAt }, FAILURE_TTL, true);
      return settled({ products: [], comtradeSource: 'lazy', state: 'unavailable', attemptedAt });
    }

    if (result.products.length === 0) {
      await setCachedJson(sentinelKey, { state: 'no_records', attemptedAt }, EMPTY_TTL, true);
      return settled({ products: [], comtradeSource: 'empty', state: 'no_records', attemptedAt });
    }

    const cacheKey = `${KEY_PREFIX}${iso2}:v1`;
    // A refresh that drops a held heading or regresses its year is rejected;
    // the previous payload stays authoritative.
    if (previous?.products.some(old => !result.products.some(p => p.hs4 === old.hs4 && p.year >= old.year))) {
      await setCachedJson(sentinelKey, { state: 'regression_rejected', attemptedAt }, EMPTY_TTL, true);
      return settled({ products: [], comtradeSource: 'lazy', state: 'regression_rejected', attemptedAt });
    }
    // Canonical rows only: leading five origins, no partner detail (KTD1).
    const products = result.products.map(toCanonicalProduct);
    const payload = { iso2, products, fetchedAt: attemptedAt, source: 'UN Comtrade public preview', requestedHs4s: HS4_CODES };
    // A scheduled write may have advanced the canonical key during this fetch.
    // Keep warm recovery separate; cold publication uses NX instead of replacing it.
    const written = previous
      ? await setCachedJson(sentinelKey, { state: 'observed', attemptedAt, payload }, EMPTY_TTL, true)
      : await setCachedJsonIfAbsent(cacheKey, payload, SUCCESS_TTL, true);
    if (!written) return settled({ products, comtradeSource: 'lazy', state: 'cache_write_failed', attemptedAt });
    return settled({ products, comtradeSource: 'bilateral-hs4', state: 'observed', attemptedAt, payload });
  } catch (error) {
    const state = comtradeFailureState(error);
    // Capped or World-inconsistent data will not change within the day; a
    // malformed body, timeout or network failure may, so it is only briefly suppressed.
    await setCachedJson(sentinelKey, { state, attemptedAt }, state === 'incomplete' ? EMPTY_TTL : FAILURE_TTL, true);
    return settled({ products: [], comtradeSource: 'lazy', state, attemptedAt });
  } finally {
    fetchInFlight = false;
  }
}

export interface LazyHeadingResult {
  state: LazyAttemptState;
  attemptedAt?: string;
  /** Present only in state 'observed'. */
  product?: PartnersProduct;
  /** When this heading alone was fetched, which is not the payload's fetch time. */
  fetchedAt?: string;
}

/**
 * Recover ONE heading a stored payload lacks, for any reporter Comtrade serves.
 *
 * The whole catalogue cannot be recovered for a large importer: even with the
 * aggregate filters a 20-heading batch fills the preview route's 500-row cap
 * for Germany, China and the US, so that path always ends `incomplete` for the
 * countries users ask about most. One heading returns every partner in ~55 rows.
 *
 * State lives in `comtrade:bilateral-hs4-lazy-heading:{iso2}:{hs4}:v1`, per
 * heading rather than per country, so a heading that returns nothing does not
 * suppress a different heading for the same country for 24h. Neither the
 * canonical key nor the per-country sentinel is ever written here: a
 * single-heading result is not a catalogue and must never become one.
 *
 * `storedYear`, when given, is the observation year the caller already holds;
 * an older recovery is rejected rather than served as a refresh.
 *
 * `timing` places the request after the caller's previous one on this
 * rate-limited route and inside the caller's shared deadline. With `cacheOnly`
 * the sentinel is read and no request is made.
 *
 * Returns null while another fetch is in flight on this instance, and when a
 * cache-only read finds no sentinel.
 */
export async function lazyFetchHeading(
  iso2: string, hs4: string, storedYear?: number, timing: FetchWindow & { cacheOnly?: boolean } = {},
): Promise<LazyHeadingResult | null> {
  const sentinelKey = `${LAZY_HEADING_PREFIX}${iso2}:${hs4}:v1`;
  const cached = await readCachedJson(sentinelKey, true);
  if (cached.status === 'error') return { state: 'cache_unavailable' };
  const sentinel = (cached.status === 'hit' ? cached.value : null) as LazyHeadingResult | null;
  if (sentinel?.state === 'observed') {
    // An observed sentinel whose product is missing, or is for another heading,
    // is unusable. Refetch rather than report an observation with nothing to
    // serve behind it.
    if (sentinel.product?.hs4 === hs4 && Array.isArray(sentinel.product.partners)) {
      return { state: 'observed', attemptedAt: sentinel.attemptedAt, product: sentinel.product, fetchedAt: sentinel.fetchedAt };
    }
  } else if (sentinel?.state) {
    return { state: sentinel.state, attemptedAt: sentinel.attemptedAt };
  }
  if (timing.cacheOnly) return null;

  if (fetchInFlight) return null;
  fetchInFlight = true;

  const unCode = ISO2_TO_UN[iso2];
  if (!unCode) {
    fetchInFlight = false;
    await setCachedJson(sentinelKey, { state: 'unsupported_reporter' }, EMPTY_TTL, true);
    return { state: 'unsupported_reporter' };
  }

  const attemptedAt = new Date().toISOString();
  try {
    const result = await fetchComtradeBilateral(unCode, [[hs4]], timing);

    // The public route rate-limits at roughly one request per second and
    // recovers within seconds, so a 429 is suppressed as briefly as any other
    // transient provider failure rather than for the full day.
    if (result.rateLimited) {
      await setCachedJson(sentinelKey, { state: 'rate_limited', attemptedAt }, FAILURE_TTL, true);
      return { state: 'rate_limited', attemptedAt };
    }
    if (result.failed) {
      await setCachedJson(sentinelKey, { state: 'unavailable', attemptedAt }, FAILURE_TTL, true);
      return { state: 'unavailable', attemptedAt };
    }

    const found = result.products.find(p => p.hs4 === hs4);
    if (!found) {
      await setCachedJson(sentinelKey, { state: 'no_records', attemptedAt }, EMPTY_TTL, true);
      return { state: 'no_records', attemptedAt };
    }

    const product = toPartnersProduct(found);
    if (storedYear != null && product.year < storedYear) {
      await setCachedJson(sentinelKey, { state: 'regression_rejected', attemptedAt }, EMPTY_TTL, true);
      return { state: 'regression_rejected', attemptedAt };
    }

    // A failed sentinel write costs the next reader a repeat request; it does
    // not make the rows we just read less true, so they are still served.
    await setCachedJson(sentinelKey, { state: 'observed', attemptedAt, product, fetchedAt: attemptedAt }, EMPTY_TTL, true);
    return { state: 'observed', attemptedAt, product, fetchedAt: attemptedAt };
  } catch (error) {
    const state = comtradeFailureState(error);
    // Same split as the catalogue path: a capped or World-inconsistent heading
    // will not change within the day; a timeout or malformed body may.
    await setCachedJson(sentinelKey, { state, attemptedAt }, state === 'incomplete' ? EMPTY_TTL : FAILURE_TTL, true);
    return { state, attemptedAt };
  } finally {
    fetchInFlight = false;
  }
}
