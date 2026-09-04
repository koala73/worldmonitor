/**
 * RPC: getTariffTrends -- reads seeded WTO MFN tariff trends from Railway seed cache.
 *
 * The seed holds one maximum-window key per reporter; this handler slices it to
 * the requested lookback. Before #6316 the lookback was part of the cache key
 * and only ever seeded at 10, so every other supported window built a key
 * nothing had written and came back as `upstreamUnavailable` — a fault report
 * for a request the contract accepted and the data could answer.
 *
 * The seed payload may also include an optional US effective tariff snapshot
 * (FRED customs duties / goods imports).
 */
import type {
  ServerContext,
  GetTariffTrendsRequest,
  GetTariffTrendsResponse,
  TariffDataPoint,
  TariffTrendUnavailableReason,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { readCachedJson } from '../../../_shared/redis';
import { isCallerPremium } from '../../../_shared/premium-check';

/** Must match scripts/seed-supply-chain-trade.mjs; pinned by tests. */
export const SEED_KEY_PREFIX = 'trade:tariffs:v2';
export const COVERAGE_KEY = `${SEED_KEY_PREFIX}:index`;

export const DEFAULT_REPORTING_COUNTRY = '840';
export const DEFAULT_YEARS = 10;
/** Must equal the `years` maximum in get_tariff_trends.proto and the seeded window. */
export const MAX_YEARS = 30;

/**
 * The only product-sector token currently covered. Empty request normalizes to
 * this; the seeder writes All-products under the same id.
 */
export const COVERED_PRODUCT_SECTOR = 'all';

/**
 * Short names for the generated `TariffTrendUnavailableReason` enum members.
 *
 * The vocabulary is a proto enum rather than a bare string so the closed set is
 * machine-discoverable from the OpenAPI spec and gives generated clients
 * compile-time exhaustiveness — matching TradeFlowUnavailableReason and how the
 * repo models every other "why is this not covered" state.
 * The distinction that matters is NOT_COVERED (a contract answer — nothing is
 * broken, a retry cannot help) versus everything else (a fault); collapsing
 * them, which a bare `upstreamUnavailable: true` did, makes a permanent
 * coverage gap look like a transient outage that will fix itself.
 */
const REASON = {
  served: 'TARIFF_TREND_UNAVAILABLE_REASON_UNSPECIFIED',
  invalidRequest: 'TARIFF_TREND_UNAVAILABLE_REASON_INVALID_REQUEST',
  notCovered: 'TARIFF_TREND_UNAVAILABLE_REASON_NOT_COVERED',
  seedMissing: 'TARIFF_TREND_UNAVAILABLE_REASON_SEED_MISSING',
  coverageUnknown: 'TARIFF_TREND_UNAVAILABLE_REASON_COVERAGE_UNKNOWN',
  cacheUnavailable: 'TARIFF_TREND_UNAVAILABLE_REASON_CACHE_UNAVAILABLE',
} as const satisfies Record<string, TariffTrendUnavailableReason>;

export { REASON as TARIFF_TREND_REASON };

interface CoverageManifest {
  reporters: string[];
  startYear?: number;
  endYear?: number;
  fetchedAt?: string;
}

const CODE_PATTERN = /^[0-9]{3}$/;
const SECTOR_PATTERN = /^[a-zA-Z0-9_-]{0,16}$/;
const REPORTER_ID_PATTERN = /^[0-9]{3}$/;

/**
 * Pre-#6316 key shape. Only ever written at years=10 with productSector=all.
 *
 * This handler ships before the 6-hourly Railway seeder has written a single v2
 * key, and `reporting_country=840` with the default window answers from the v1
 * key today. Without this bridge that call would report a fault for up to one
 * cron interval — the exact failure mode this issue exists to remove — so the
 * old key is read while, and only while, the v2 manifest is absent.
 *
 * The v1 keys carry an 8h TTL that nothing refreshes any more after this ships,
 * so the bridge degrades to a no-op rather than to stale data.
 */
export const LEGACY_SEEDED_YEARS = 10;
export const LEGACY_KEY_PREFIX = 'trade:tariffs:v1';

export function tariffTrendSeedKey(reporter: string): string {
  return `${SEED_KEY_PREFIX}:${reporter}`;
}

export function legacyTariffTrendSeedKey(reporter: string): string {
  return `${LEGACY_KEY_PREFIX}:${reporter}:${COVERED_PRODUCT_SECTOR}:${LEGACY_SEEDED_YEARS}`;
}

export function tariffTrendCoverageId(reporter: string): string {
  return reporter;
}

export interface NormalizedTariffTrendRequest {
  reporter: string;
  /** Normalized partner for echo only — never used in the cache key. */
  partner: string;
  /** Normalized sector token: empty → "all"; non-all is outside coverage. */
  productSector: string;
  years: number;
}

/**
 * Resolve a request to the values used for the cache key / coverage check, or
 * null when it is malformed.
 *
 * An ABSENT reporting code takes the documented default. A PRESENT but
 * malformed one is rejected: the previous handler substituted '840' for
 * anything failing its check, so `reporting_country=XX` silently answered about
 * the United States. buf.validate rejects the same inputs at the route with a
 * 400; this is the same rule enforced where the handler is reached directly
 * (sidecar, tests).
 *
 * partner_country is validated when present but never enters the cache key —
 * TP_A_0010 has no partner dimension.
 */
export function normalizeTariffTrendRequest(
  req: GetTariffTrendsRequest,
): NormalizedTariffTrendRequest | null {
  const rawReporter = (req.reportingCountry ?? '').trim();
  const rawPartner = (req.partnerCountry ?? '').trim();
  const rawSector = (req.productSector ?? '').trim();
  if (rawReporter !== '' && !CODE_PATTERN.test(rawReporter)) return null;
  if (rawPartner !== '' && !CODE_PATTERN.test(rawPartner)) return null;
  if (rawSector !== '' && !SECTOR_PATTERN.test(rawSector)) return null;

  const rawYears = req.years;
  if (typeof rawYears !== 'number' || !Number.isInteger(rawYears)) return null;
  if (rawYears < 0 || rawYears > MAX_YEARS) return null;

  const sectorLower = rawSector.toLowerCase();
  return {
    reporter: rawReporter === '' ? DEFAULT_REPORTING_COUNTRY : rawReporter,
    partner: rawPartner,
    productSector: sectorLower === '' || sectorLower === COVERED_PRODUCT_SECTOR
      ? COVERED_PRODUCT_SECTOR
      : sectorLower,
    years: rawYears === 0 ? DEFAULT_YEARS : rawYears,
  };
}

/**
 * Take the most recent `years` lookback from a seeded history.
 *
 * The window is inclusive of both endpoints — `years = 10` returns 11 calendar
 * years — because that is what the seeder's `ps=${end - years}-${end}` range
 * has always meant, and what the pre-#6316 `years=10` key contained.
 */
export function sliceTariffsToWindow(
  datapoints: readonly TariffDataPoint[],
  years: number,
): TariffDataPoint[] {
  if (datapoints.length === 0) return [];
  let endYear = Number.NEGATIVE_INFINITY;
  for (const point of datapoints) {
    if (Number.isFinite(point?.year) && point.year > endYear) endYear = point.year;
  }
  if (!Number.isFinite(endYear)) return [];
  const startYear = endYear - years;
  return datapoints
    .filter((point) => Number.isFinite(point?.year) && point.year >= startYear && point.year <= endYear)
    .sort((a, b) => a.year - b.year);
}

function unavailable(
  reason: TariffTrendUnavailableReason,
  upstreamUnavailable: boolean,
): GetTariffTrendsResponse {
  return {
    datapoints: [],
    // Nothing was fetched, so there is no fetch time to report. Stamping "now"
    // here — as this handler used to — dates an empty answer as if it were a
    // fresh observation.
    fetchedAt: '',
    upstreamUnavailable,
    unavailableReason: reason,
    coverageStartYear: 0,
    coverageEndYear: 0,
  };
}

function logReadFailure(key: string, error: unknown): void {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    console.error(`[REDIS-TIMEOUT] readCachedJson key=${key}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[tariff-trends] ${key} read failed: ${message}`);
}

/**
 * Name a miss. Only reached when the reporter's own key produced nothing, so
 * the extra read never touches the served path.
 */
async function classifyMiss(reporter: string): Promise<GetTariffTrendsResponse> {
  const read = await readCachedJson(COVERAGE_KEY, true);
  if (read.status === 'error') {
    logReadFailure(COVERAGE_KEY, read.error);
    return unavailable(REASON.cacheUnavailable, true);
  }
  const manifest = read.status === 'hit' ? (read.value as CoverageManifest | null) : null;
  // Every member must be well-formed, not just the array itself. `{reporters:[null]}`
  // would otherwise pass, match nothing, and answer `not_covered` — the one
  // verdict the CDN is allowed to hold — for every request, presenting a corrupt
  // manifest as a legitimate coverage answer.
  const reporters = manifest?.reporters;
  if (
    !Array.isArray(reporters)
    || !reporters.every((id) => typeof id === 'string' && REPORTER_ID_PATTERN.test(id))
  ) {
    // The manifest expires on the same TTL as the data keys, so losing both is
    // itself evidence the seeder has stopped — not evidence about this reporter.
    return unavailable(REASON.coverageUnknown, true);
  }
  return reporters.includes(tariffTrendCoverageId(reporter))
    ? unavailable(REASON.seedMissing, true)
    : unavailable(REASON.notCovered, false);
}

async function readLegacySeed(
  reporter: string,
  years: number,
): Promise<GetTariffTrendsResponse | 'error' | null> {
  const legacyKey = legacyTariffTrendSeedKey(reporter);
  const read = await readCachedJson(legacyKey, true);
  if (read.status === 'error') {
    logReadFailure(legacyKey, read.error);
    return 'error';
  }
  const seeded = read.status === 'hit' ? (read.value as GetTariffTrendsResponse | null) : null;
  const datapoints = Array.isArray(seeded?.datapoints)
    ? sliceTariffsToWindow(seeded.datapoints, years)
    : [];
  if (datapoints.length === 0) return null;
  return served(datapoints, seeded?.fetchedAt, seeded?.effectiveTariffRate);
}

function served(
  datapoints: TariffDataPoint[],
  fetchedAt: unknown,
  effectiveTariffRate: GetTariffTrendsResponse['effectiveTariffRate'],
): GetTariffTrendsResponse {
  const first = datapoints[0];
  const last = datapoints[datapoints.length - 1];
  return {
    datapoints,
    fetchedAt: typeof fetchedAt === 'string' ? fetchedAt : '',
    upstreamUnavailable: false,
    unavailableReason: REASON.served,
    coverageStartYear: first?.year ?? 0,
    coverageEndYear: last?.year ?? 0,
    ...(effectiveTariffRate ? { effectiveTariffRate } : {}),
  };
}

export async function getTariffTrends(
  ctx: ServerContext,
  req: GetTariffTrendsRequest,
): Promise<GetTariffTrendsResponse> {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) {
    // Free tier: empty series, no seed touch. Match the prior response shape
    // (upstreamUnavailable true) and leave the reason unspecified — this is an
    // entitlement gate, not a coverage or cache fault.
    return {
      datapoints: [],
      fetchedAt: '',
      upstreamUnavailable: true,
      unavailableReason: REASON.served,
      coverageStartYear: 0,
      coverageEndYear: 0,
    };
  }

  const normalized = normalizeTariffTrendRequest(req);
  if (!normalized) return unavailable(REASON.invalidRequest, false);
  const { reporter, productSector, years } = normalized;

  // Non-all product sectors are outside seeded coverage. Name that before any
  // Redis read so a future sector expansion only has to start writing keys.
  if (productSector !== COVERED_PRODUCT_SECTOR) {
    return unavailable(REASON.notCovered, false);
  }

  const seedKey = tariffTrendSeedKey(reporter);
  const read = await readCachedJson(seedKey, true);
  if (read.status === 'error') {
    logReadFailure(seedKey, read.error);
    return unavailable(REASON.cacheUnavailable, true);
  }

  const seeded = read.status === 'hit' ? (read.value as GetTariffTrendsResponse | null) : null;
  const datapoints = Array.isArray(seeded?.datapoints)
    ? sliceTariffsToWindow(seeded.datapoints, years)
    : [];
  if (datapoints.length > 0) {
    return served(datapoints, seeded?.fetchedAt, seeded?.effectiveTariffRate);
  }

  const miss = await classifyMiss(reporter);
  if (miss.unavailableReason !== REASON.coverageUnknown) return miss;

  // Transitional bridge: serve the pre-#6316 v1 key while the v2 fleet has not
  // been published yet. See LEGACY_KEY_PREFIX.
  const legacy = await readLegacySeed(reporter, years);
  if (legacy === 'error') return unavailable(REASON.cacheUnavailable, true);
  if (legacy) return legacy;
  return miss;
}
