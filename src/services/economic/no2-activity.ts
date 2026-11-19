import type {
  GetNo2ActivityRequest,
  GetNo2ActivityResponse,
  No2ActivityRegion,
  No2Direction,
  No2RegionExclusion,
} from '@/generated/client/worldmonitor/economic/v1/service_client';

/**
 * One closed state per region. The route reports a direction and an
 * exclusion separately; the browser decides once, here, what each
 * combination means, so every surface (map fill, legend, tooltip, brief
 * line) branches on this state and nothing else.
 */
export type No2ActivityState = 'strengthening' | 'weakening' | 'unchanged' | 'pending' | 'excluded';

export type No2ActivityExclusion = 'request_failed' | 'baseline_backfill_pending' | 'insufficient_valid_days' | 'insufficient_baseline_years';

export interface No2ActivityRegionView {
  id: string;
  kind: 'country' | 'cluster';
  label: string;
  /** ISO 3166-1 alpha-2; null for a cluster that spans countries. */
  countryCode: string | null;
  /** West, south, east, north in degrees. */
  bbox: [number, number, number, number];
  state: No2ActivityState;
  /** Percent against the baseline mean; null unless the region has a reading. */
  changePercent: number | null;
  windowStart: string;
  windowEnd: string;
  validDays: number;
  baselineYears: number[];
  exclusion: No2ActivityExclusion | null;
}

/** One country's line in the brief, with the dataset facts it must show beside it. */
export interface No2CountryReading {
  region: No2ActivityRegionView | null;
  stale: boolean;
  attribution: string;
}

export interface No2ActivitySnapshot {
  generatedAt: string;
  stale: boolean;
  /** The Copernicus credit the route requires every consumer to show. */
  attribution: string;
  regions: No2ActivityRegionView[];
}

const DIRECTION_STATE: Record<No2Direction, Exclude<No2ActivityState, 'pending' | 'excluded'> | null> = {
  NO2_DIRECTION_UNSPECIFIED: null,
  NO2_DIRECTION_STRENGTHENING: 'strengthening',
  NO2_DIRECTION_WEAKENING: 'weakening',
  NO2_DIRECTION_UNCHANGED: 'unchanged',
};

const EXCLUSIONS: Record<No2RegionExclusion, No2ActivityExclusion | null> = {
  NO2_REGION_EXCLUSION_UNSPECIFIED: null,
  NO2_REGION_EXCLUSION_REQUEST_FAILED: 'request_failed',
  NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING: 'baseline_backfill_pending',
  NO2_REGION_EXCLUSION_INSUFFICIENT_VALID_DAYS: 'insufficient_valid_days',
  NO2_REGION_EXCLUSION_INSUFFICIENT_BASELINE_YEARS: 'insufficient_baseline_years',
};

export function no2ActivityState(direction: No2Direction, exclusion: No2RegionExclusion): No2ActivityState {
  if (exclusion === 'NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING') return 'pending';
  if (exclusion !== 'NO2_REGION_EXCLUSION_UNSPECIFIED') return 'excluded';
  return DIRECTION_STATE[direction] ?? 'excluded';
}

function isBbox(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((edge) => typeof edge === 'number' && Number.isFinite(edge));
}

function projectRegion(region: No2ActivityRegion): No2ActivityRegionView | null {
  const kind = region.kind === 'NO2_REGION_KIND_COUNTRY' ? 'country' : region.kind === 'NO2_REGION_KIND_CLUSTER' ? 'cluster' : null;
  const current = region.current;
  if (!kind || typeof region.id !== 'string' || typeof region.label !== 'string' || !isBbox(region.bbox) || !current) return null;
  if (typeof current.windowStart !== 'string' || typeof current.windowEnd !== 'string' || !Number.isInteger(current.validDays)) return null;
  const own = Object.prototype.hasOwnProperty;
  const direction = own.call(DIRECTION_STATE, region.direction) ? region.direction : 'NO2_DIRECTION_UNSPECIFIED';
  const exclusion = own.call(EXCLUSIONS, region.exclusion) ? region.exclusion : 'NO2_REGION_EXCLUSION_UNSPECIFIED';
  const state = no2ActivityState(direction, exclusion);
  const change = typeof region.changePercent === 'number' && Number.isFinite(region.changePercent) ? region.changePercent : null;
  return {
    id: region.id,
    kind,
    label: region.label,
    countryCode: region.countryCode ? region.countryCode : null,
    bbox: [region.bbox[0], region.bbox[1], region.bbox[2], region.bbox[3]],
    state,
    changePercent: state === 'pending' || state === 'excluded' ? null : change,
    windowStart: current.windowStart,
    windowEnd: current.windowEnd,
    validDays: current.validDays,
    baselineYears: Array.isArray(region.baselineYears) ? region.baselineYears.filter((year) => Number.isInteger(year)) : [],
    exclusion: EXCLUSIONS[exclusion],
  };
}

/** Null on a fault; an empty snapshot when the filters are simply not covered. */
export function projectNo2ActivitySnapshot(response: GetNo2ActivityResponse): No2ActivitySnapshot | null {
  if (response.upstreamUnavailable) return null;
  return {
    generatedAt: typeof response.generatedAt === 'string' ? response.generatedAt : '',
    stale: response.stale === true,
    attribution: typeof response.attribution === 'string' ? response.attribution : '',
    regions: (Array.isArray(response.regions) ? response.regions : [])
      .map(projectRegion)
      .filter((region): region is No2ActivityRegionView => region !== null),
  };
}

export function countryNo2Activity(snapshot: No2ActivitySnapshot, countryCode: string): No2ActivityRegionView | null {
  const code = countryCode.toUpperCase();
  return snapshot.regions.find((region) => region.kind === 'country' && region.countryCode === code) ?? null;
}

export interface No2ActivityClient {
  getNo2Activity(request: GetNo2ActivityRequest): Promise<GetNo2ActivityResponse>;
}

/** Null means the read failed; the caller keeps whatever it last painted. */
export async function fetchNo2Activity(
  request: Partial<GetNo2ActivityRequest>,
  client: No2ActivityClient,
): Promise<No2ActivitySnapshot | null> {
  const full: GetNo2ActivityRequest = {
    countryCode: request.countryCode ?? '',
    regionId: request.regionId ?? '',
    kind: request.kind ?? 'NO2_REGION_KIND_UNSPECIFIED',
  };
  try {
    return projectNo2ActivitySnapshot(await client.getNo2Activity(full));
  } catch {
    return null;
  }
}
