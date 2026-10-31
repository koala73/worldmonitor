/**
 * RPC: getNo2Activity -- serves the global Sentinel-5P NO2 activity dataset
 * that scripts/seed-no2-activity.mjs publishes on Railway, filtered by
 * country, region id and kind. Nothing is fetched from Copernicus here.
 *
 * The dataset crosses the Redis boundary through the shared contract
 * validator, so a reader can only ever serve a record the producer could have
 * published. Coverage is answered from the static region registry before the
 * cache is read: a filter that names nothing is a contract answer, never a
 * fault, and it stays correct while Redis is down.
 */
import type {
  GetNo2ActivityRequest,
  GetNo2ActivityResponse,
  No2ActivityRegion,
  No2ActivityUnavailableReason,
  No2Direction,
  No2RegionExclusion,
  No2RegionKind,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import {
  NO2_ACTIVITY_KEY,
  NO2_ACTIVITY_METHOD,
  NO2_ACTIVITY_METHOD_VERSION,
  NO2_REGIONS,
  validateNo2ActivityDataset,
  type No2ActivityDataset,
  type No2Region,
  type No2RegionResult,
} from '../../../../scripts/shared/no2-activity.mjs';
import { readCachedJson } from '../../../_shared/redis';

/** Must equal api/health.js SEED_META.no2Activity.maxStaleMin; pinned by tests. */
export const NO2_ACTIVITY_MAX_STALE_MINUTES = 4320;

const REASON = {
  served: 'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED',
  invalidRequest: 'NO2_ACTIVITY_UNAVAILABLE_REASON_INVALID_REQUEST',
  notCovered: 'NO2_ACTIVITY_UNAVAILABLE_REASON_NOT_COVERED',
  seedMissing: 'NO2_ACTIVITY_UNAVAILABLE_REASON_SEED_MISSING',
  invalidDataset: 'NO2_ACTIVITY_UNAVAILABLE_REASON_INVALID_DATASET',
  cacheUnavailable: 'NO2_ACTIVITY_UNAVAILABLE_REASON_CACHE_UNAVAILABLE',
} as const satisfies Record<string, No2ActivityUnavailableReason>;

export { REASON as NO2_ACTIVITY_REASON };

const KIND: Record<No2Region['kind'], No2RegionKind> = {
  country: 'NO2_REGION_KIND_COUNTRY',
  cluster: 'NO2_REGION_KIND_CLUSTER',
};

const DIRECTION: Record<NonNullable<No2RegionResult['direction']>, No2Direction> = {
  strengthening: 'NO2_DIRECTION_STRENGTHENING',
  weakening: 'NO2_DIRECTION_WEAKENING',
  unchanged: 'NO2_DIRECTION_UNCHANGED',
};

const EXCLUSION: Record<NonNullable<No2RegionResult['exclusion']>, No2RegionExclusion> = {
  request_failed: 'NO2_REGION_EXCLUSION_REQUEST_FAILED',
  baseline_backfill_pending: 'NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING',
  insufficient_valid_days: 'NO2_REGION_EXCLUSION_INSUFFICIENT_VALID_DAYS',
  insufficient_baseline_years: 'NO2_REGION_EXCLUSION_INSUFFICIENT_BASELINE_YEARS',
};

const KIND_FILTER: Record<No2RegionKind, No2Region['kind'] | null> = {
  NO2_REGION_KIND_UNSPECIFIED: null,
  NO2_REGION_KIND_COUNTRY: 'country',
  NO2_REGION_KIND_CLUSTER: 'cluster',
};

const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;
const REGION_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export interface No2ActivityFilter {
  countryCode: string | null;
  regionId: string | null;
  kind: No2Region['kind'] | null;
}

/**
 * Resolve a request to its filter, or null when a filter is malformed.
 * buf.validate rejects the same inputs at the route with a 400; this is the
 * same rule enforced where the handler is reached directly (sidecar, tests).
 */
export function normalizeNo2ActivityRequest(req: GetNo2ActivityRequest): No2ActivityFilter | null {
  const rawCountry = (req.countryCode ?? '').trim();
  const rawRegion = (req.regionId ?? '').trim();
  if (rawCountry !== '' && !COUNTRY_CODE_PATTERN.test(rawCountry)) return null;
  if (rawRegion !== '' && !REGION_ID_PATTERN.test(rawRegion)) return null;
  const kind = req.kind ?? 'NO2_REGION_KIND_UNSPECIFIED';
  if (!Object.prototype.hasOwnProperty.call(KIND_FILTER, kind)) return null;
  return {
    countryCode: rawCountry === '' ? null : rawCountry.toUpperCase(),
    regionId: rawRegion === '' ? null : rawRegion,
    kind: KIND_FILTER[kind],
  };
}

/** Registered regions the filter selects, in registry order. */
export function selectNo2Regions(filter: No2ActivityFilter): No2Region[] {
  return NO2_REGIONS.filter((region) => (
    (filter.countryCode === null || region.countryCode === filter.countryCode)
    && (filter.regionId === null || region.id === filter.regionId)
    && (filter.kind === null || region.kind === filter.kind)
  ));
}

/**
 * The prior years whose window entered the baseline mean: every calendar year
 * the window touches is backfilled and the window has enough valid days. The
 * seeder keeps every candidate window on the record, so while the backfill is
 * pending the candidates must not read as completed coverage.
 */
export function baselineYearsOf(record: No2RegionResult): number[] {
  const backfilled = new Set(record.series.backfilledYears);
  return record.baseline.years
    .filter((year) => {
      const first = Number(year.windowStart.slice(0, 4));
      const last = Number(year.windowEnd.slice(0, 4));
      for (let y = first; y <= last; y++) if (!backfilled.has(y)) return false;
      return year.validDays >= NO2_ACTIVITY_METHOD.minValidDays;
    })
    .map((year) => year.year);
}

export function projectNo2ActivityRegion(record: No2RegionResult): No2ActivityRegion {
  return {
    id: record.id,
    kind: KIND[record.kind],
    label: record.label,
    countryCode: record.countryCode ?? '',
    bbox: [...record.bbox],
    current: {
      windowStart: record.current.windowStart,
      windowEnd: record.current.windowEnd,
      validDays: record.current.validDays,
      ...(record.current.meanNo2MolM2 === null ? {} : { meanNo2MolM2: record.current.meanNo2MolM2 }),
    },
    baselineYears: baselineYearsOf(record),
    ...(record.baseline.meanNo2MolM2 === null ? {} : { baselineMeanNo2MolM2: record.baseline.meanNo2MolM2 }),
    ...(record.changePercent === null ? {} : { changePercent: record.changePercent }),
    direction: record.direction === null ? 'NO2_DIRECTION_UNSPECIFIED' : DIRECTION[record.direction],
    exclusion: record.exclusion === null ? 'NO2_REGION_EXCLUSION_UNSPECIFIED' : EXCLUSION[record.exclusion],
  };
}

function unavailable(reason: No2ActivityUnavailableReason, upstreamUnavailable: boolean): GetNo2ActivityResponse {
  return {
    regions: [],
    generatedAt: '',
    stale: false,
    methodVersion: NO2_ACTIVITY_METHOD_VERSION,
    attribution: '',
    unavailableReason: reason,
    upstreamUnavailable,
  };
}

function served(dataset: No2ActivityDataset, regions: No2Region[], nowMs: number): GetNo2ActivityResponse {
  return {
    ...unavailable(REASON.served, false),
    regions: regions.map((region) => projectNo2ActivityRegion(dataset.regions[region.id]!)),
    generatedAt: dataset.generatedAt,
    stale: nowMs - Date.parse(dataset.generatedAt) > NO2_ACTIVITY_MAX_STALE_MINUTES * 60_000,
    attribution: dataset.source.attribution,
  };
}

function logReadFailure(error: unknown): void {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    console.error(`[REDIS-TIMEOUT] readCachedJson key=${NO2_ACTIVITY_KEY}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[no2-activity] ${NO2_ACTIVITY_KEY} read failed: ${message}`);
}

export async function getNo2Activity(
  _ctx: ServerContext,
  req: GetNo2ActivityRequest,
): Promise<GetNo2ActivityResponse> {
  const filter = normalizeNo2ActivityRequest(req);
  if (!filter) return unavailable(REASON.invalidRequest, false);
  const regions = selectNo2Regions(filter);
  if (regions.length === 0) return unavailable(REASON.notCovered, false);

  const read = await readCachedJson(NO2_ACTIVITY_KEY, true);
  if (read.status === 'error') {
    logReadFailure(read.error);
    return unavailable(REASON.cacheUnavailable, true);
  }
  if (read.status === 'miss' || read.value === null) return unavailable(REASON.seedMissing, true);
  if (!validateNo2ActivityDataset(read.value)) return unavailable(REASON.invalidDataset, true);
  return served(read.value, regions, Date.now());
}
