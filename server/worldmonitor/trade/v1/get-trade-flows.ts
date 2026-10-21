/**
 * RPC: getTradeFlows -- reads seeded WTO trade flow data from Railway seed cache.
 * All external WTO API calls happen in seed-supply-chain-trade.mjs on Railway.
 *
 * The seed holds one maximum-window key per reporter/partner pair; this handler
 * slices it to the requested lookback. Before #6309 the lookback was part of the
 * cache key and only ever seeded at 10, so every other supported window built a
 * key nothing had written and came back as `upstreamUnavailable` — a fault
 * report for a request the contract accepted and the data could answer.
 */
import type {
  ServerContext,
  GetTradeFlowsRequest,
  GetTradeFlowsResponse,
  TradeFlowRecord,
  TradeFlowUnavailableReason,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { readCachedJson } from '../../../_shared/redis';

/** Must match scripts/seed-supply-chain-trade.mjs; pinned by tests. */
export const SEED_KEY_PREFIX = 'trade:flows:v2';
export const COVERAGE_KEY = `${SEED_KEY_PREFIX}:index`;

export const DEFAULT_REPORTING_COUNTRY = '840';
export const WORLD_PARTNER_CODE = '000';
export const DEFAULT_YEARS = 10;
/** Must equal the `years` maximum in get_trade_flows.proto and the seeded window. */
export const MAX_YEARS = 30;

/**
 * Short names for the generated `TradeFlowUnavailableReason` enum members.
 *
 * The vocabulary is a proto enum rather than a bare string so the closed set is
 * machine-discoverable from the OpenAPI spec and gives generated clients
 * compile-time exhaustiveness — matching how the repo models every other
 * "why is this not covered" state (DependencyFlag, CompanyCoverageState).
 * The distinction that matters is NOT_COVERED (a contract answer — nothing is
 * broken, a retry cannot help) versus everything else (a fault); collapsing
 * them, which a bare `upstreamUnavailable: true` did, makes a permanent
 * coverage gap look like a transient outage that will fix itself.
 */
const REASON = {
  served: 'TRADE_FLOW_UNAVAILABLE_REASON_UNSPECIFIED',
  invalidRequest: 'TRADE_FLOW_UNAVAILABLE_REASON_INVALID_REQUEST',
  notCovered: 'TRADE_FLOW_UNAVAILABLE_REASON_NOT_COVERED',
  seedMissing: 'TRADE_FLOW_UNAVAILABLE_REASON_SEED_MISSING',
  coverageUnknown: 'TRADE_FLOW_UNAVAILABLE_REASON_COVERAGE_UNKNOWN',
  cacheUnavailable: 'TRADE_FLOW_UNAVAILABLE_REASON_CACHE_UNAVAILABLE',
} as const satisfies Record<string, TradeFlowUnavailableReason>;

export { REASON as TRADE_FLOW_REASON };

interface CoverageManifest {
  pairs: string[];
  startYear?: number;
  endYear?: number;
  fetchedAt?: string;
}

const CODE_PATTERN = /^[0-9]{3}$/;
const PAIR_ID_PATTERN = /^[0-9]{3}:[0-9]{3}$/;

export function tradeFlowSeedKey(reporter: string, partner: string): string {
  return `${SEED_KEY_PREFIX}:${reporter}:${partner}`;
}

export function tradeFlowCoverageId(reporter: string, partner: string): string {
  return `${reporter}:${partner}`;
}

export interface NormalizedTradeFlowRequest {
  reporter: string;
  partner: string;
  years: number;
}

/**
 * Resolve a request to the triple used for the cache key, or null when it is
 * malformed.
 *
 * An ABSENT code takes the documented default. A PRESENT but malformed one is
 * rejected: the previous handler substituted '840'/'000' for anything failing
 * its check, so `reporting_country=XX` silently answered about the United
 * States. buf.validate rejects the same inputs at the route with a 400; this is
 * the same rule enforced where the handler is reached directly (sidecar, tests).
 */
export function normalizeTradeFlowRequest(
  req: GetTradeFlowsRequest,
): NormalizedTradeFlowRequest | null {
  const rawReporter = (req.reportingCountry ?? '').trim();
  const rawPartner = (req.partnerCountry ?? '').trim();
  if (rawReporter !== '' && !CODE_PATTERN.test(rawReporter)) return null;
  if (rawPartner !== '' && !CODE_PATTERN.test(rawPartner)) return null;

  const rawYears = req.years;
  if (typeof rawYears !== 'number' || !Number.isInteger(rawYears)) return null;
  if (rawYears < 0 || rawYears > MAX_YEARS) return null;

  return {
    reporter: rawReporter === '' ? DEFAULT_REPORTING_COUNTRY : rawReporter,
    partner: rawPartner === '' ? WORLD_PARTNER_CODE : rawPartner,
    years: rawYears === 0 ? DEFAULT_YEARS : rawYears,
  };
}

/**
 * Take the most recent `years` lookback from a seeded history.
 *
 * The window is inclusive of both endpoints — `years = 10` returns 11 calendar
 * years — because that is what the seeder's `ps=${end - years}-${end}` range
 * has always meant, and what the pre-#6309 `years=10` key contained.
 */
export function sliceFlowsToWindow(
  flows: readonly TradeFlowRecord[],
  years: number,
): TradeFlowRecord[] {
  if (flows.length === 0) return [];
  let endYear = Number.NEGATIVE_INFINITY;
  for (const flow of flows) {
    if (Number.isFinite(flow?.year) && flow.year > endYear) endYear = flow.year;
  }
  if (!Number.isFinite(endYear)) return [];
  const startYear = endYear - years;
  return flows
    .filter((flow) => Number.isFinite(flow?.year) && flow.year >= startYear && flow.year <= endYear)
    .sort((a, b) => a.year - b.year);
}

function unavailable(
  reason: TradeFlowUnavailableReason,
  upstreamUnavailable: boolean,
): GetTradeFlowsResponse {
  return {
    flows: [],
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
  // Mirrors the fleet-standard structured tag emitted by getCachedJson's
  // module-private logCacheReadError, which this handler no longer routes
  // through: without it a Redis timeout loses its Sentry signal.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    console.error(`[REDIS-TIMEOUT] readCachedJson key=${key}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[trade-flows] ${key} read failed: ${message}`);
}

/**
 * Name a miss. Only reached when the pair's own key produced nothing, so the
 * extra read never touches the served path.
 */
async function classifyMiss(reporter: string, partner: string): Promise<GetTradeFlowsResponse> {
  const read = await readCachedJson(COVERAGE_KEY, true);
  if (read.status === 'error') {
    logReadFailure(COVERAGE_KEY, read.error);
    return unavailable(REASON.cacheUnavailable, true);
  }
  const manifest = read.status === 'hit' ? (read.value as CoverageManifest | null) : null;
  // Every member must be well-formed, not just the array itself. `{pairs:[null]}`
  // would otherwise pass, match nothing, and answer `not_covered` — the one
  // verdict the CDN is allowed to hold — for every request, presenting a corrupt
  // manifest as a legitimate coverage answer.
  const pairs = manifest?.pairs;
  if (!Array.isArray(pairs) || !pairs.every((id) => typeof id === 'string' && PAIR_ID_PATTERN.test(id))) {
    // The manifest expires on the same TTL as the data keys, so losing both is
    // itself evidence the seeder has stopped — not evidence about this pair.
    return unavailable(REASON.coverageUnknown, true);
  }
  return pairs.includes(tradeFlowCoverageId(reporter, partner))
    ? unavailable(REASON.seedMissing, true)
    : unavailable(REASON.notCovered, false);
}

export async function getTradeFlows(
  _ctx: ServerContext,
  req: GetTradeFlowsRequest,
): Promise<GetTradeFlowsResponse> {
  const normalized = normalizeTradeFlowRequest(req);
  if (!normalized) return unavailable(REASON.invalidRequest, false);
  const { reporter, partner, years } = normalized;

  const seedKey = tradeFlowSeedKey(reporter, partner);
  const read = await readCachedJson(seedKey, true);
  if (read.status === 'error') {
    logReadFailure(seedKey, read.error);
    return unavailable(REASON.cacheUnavailable, true);
  }

  const seeded = read.status === 'hit' ? (read.value as GetTradeFlowsResponse | null) : null;
  const flows = Array.isArray(seeded?.flows) ? sliceFlowsToWindow(seeded.flows, years) : [];
  if (flows.length === 0) return classifyMiss(reporter, partner);

  return served(flows, seeded?.fetchedAt);
}

function served(flows: TradeFlowRecord[], fetchedAt: unknown): GetTradeFlowsResponse {
  // Bound the endpoints before use: tsconfig.api.json runs with
  // noUncheckedIndexedAccess, and both callers already guarantee a non-empty
  // slice, so this narrows without adding a runtime branch that could lie.
  const first = flows[0];
  const last = flows[flows.length - 1];
  return {
    flows,
    fetchedAt: typeof fetchedAt === 'string' ? fetchedAt : '',
    upstreamUnavailable: false,
    unavailableReason: REASON.served,
    coverageStartYear: first?.year ?? 0,
    coverageEndYear: last?.year ?? 0,
  };
}
