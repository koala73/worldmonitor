// Types for scripts/shared/no2-activity.mjs so readers in server/ stay
// covered by `npm run typecheck:api`.

export declare const NO2_ACTIVITY_KEY: 'economic:no2-activity:v1';
export declare const NO2_ACTIVITY_SERIES_KEY_PREFIX: 'economic:no2-activity:series:v1:';
export declare const NO2_ACTIVITY_SEED_META_KEY: 'seed-meta:economic:no2-activity';
export declare const NO2_ACTIVITY_ACTIVATION_KEY: 'seed-activated:economic:no2-activity';
export declare const NO2_ACTIVITY_METHOD_VERSION: 'no2-activity/v1';
export declare const NO2_ACTIVITY_SOURCE_VERSION: string;
export declare const NO2_ATTRIBUTION_PREFIX: string;
export declare const NO2_ACTIVITY_MAX_REFRESH_AGE_MS: number;

export type No2Direction = 'strengthening' | 'weakening' | 'unchanged';
export declare const NO2_DIRECTIONS: readonly No2Direction[];

export interface No2ActivityMethod {
  readonly windowDays: number;
  readonly windowEndLagDays: number;
  readonly refreshDays: number;
  readonly minValidFraction: number;
  readonly minValidDays: number;
  readonly baselineYears: number;
  readonly minBaselineYears: number;
  readonly deadBandPercent: number;
  readonly timeliness: 'OFFL';
  readonly minQa: number;
  readonly maxPixelsPerRequest: number;
  readonly backfillChunkDaysByWidth: ReadonlyArray<readonly [number, number]>;
  readonly backfillChunksPerRun: number;
  readonly holidayMask: { readonly daysBefore: number; readonly daysAfter: number };
}

export declare const NO2_ACTIVITY_METHOD: No2ActivityMethod;

export type No2HolidayCalendar = 'lunar_new_year';

export interface No2Region {
  readonly id: string;
  readonly kind: 'country' | 'cluster';
  readonly label: string;
  /** ISO 3166-1 alpha-2, or null for a cluster that spans countries. */
  readonly countryCode: string | null;
  /** West, south, east, north in CRS84 degrees. */
  readonly bbox: readonly [number, number, number, number];
  readonly resolutionDegrees: number;
  readonly pixels: number;
  readonly holidayCalendar: No2HolidayCalendar | null;
}

export declare const NO2_REGIONS: readonly No2Region[];
export declare const CHINA_NO2_COMPOSITE: { readonly regionIds: readonly string[]; readonly minRegions: number };
export declare const LUNAR_NEW_YEAR_DATES: Readonly<Record<number, string>>;

export type No2RegionExclusion =
  | 'request_failed'
  | 'baseline_backfill_pending'
  | 'insufficient_valid_days'
  | 'insufficient_baseline_years';
export type No2CompositeExclusion = 'insufficient_regions';

export declare const NO2_REGION_EXCLUSIONS: readonly No2RegionExclusion[];
export declare const NO2_COMPOSITE_EXCLUSIONS: readonly No2CompositeExclusion[];

export interface No2Window {
  /** UTC calendar date, inclusive. */
  windowStart: string;
  /** UTC calendar date, inclusive. */
  windowEnd: string;
  validDays: number;
  maskedDays: number;
  meanNo2MolM2: number | null;
  meanValidFraction: number | null;
}

export interface No2BaselineYear extends No2Window {
  year: number;
}

export interface No2SeriesCoverage {
  /** Last successful source refresh. Retained unchanged when a refresh fails. */
  refreshedAt: string | null;
  days: number;
  firstDate: string | null;
  lastDate: string | null;
  backfilledYears: number[];
}

export interface No2RegionResult {
  id: string;
  kind: 'country' | 'cluster';
  label: string;
  countryCode: string | null;
  bbox: readonly [number, number, number, number];
  resolutionDegrees: number;
  current: No2Window;
  baseline: {
    years: No2BaselineYear[];
    meanNo2MolM2: number | null;
  };
  series: No2SeriesCoverage;
  changePercent: number | null;
  /** `changePercent` outside the dead band, 0 inside it, null when excluded. */
  signalValue: number | null;
  direction: No2Direction | null;
  exclusion: No2RegionExclusion | null;
}

export interface No2ActivitySource {
  publisherId: 'publisher:copernicus-sentinel-5p';
  dataset: 'sentinel-5p-l2';
  band: 'NO2';
  unit: 'mol/m2';
  attribution: string;
  requestCount: number;
  processingUnitsSpent: number;
}

export interface No2ActivityDataset {
  methodVersion: typeof NO2_ACTIVITY_METHOD_VERSION;
  generatedAt: string;
  method: No2ActivityMethod;
  source: No2ActivitySource;
  regions: Record<string, No2RegionResult>;
}

export interface No2Composite {
  changePercent: number | null;
  signalValue: number | null;
  direction: No2Direction | null;
  regionIds: string[];
  exclusion: No2CompositeExclusion | null;
}

export declare function dateMs(isoDate: unknown): number;
export declare function backfillChunkDaysFor(region: No2Region, method?: No2ActivityMethod): number;
export declare function isHolidayMasked(
  isoDate: string,
  holidayCalendar: No2HolidayCalendar | null,
  method?: No2ActivityMethod,
): boolean;
export declare function median(values: readonly number[]): number;
export declare function signalFor(
  changePercent: number,
  method?: No2ActivityMethod,
): { signalValue: number; direction: No2Direction };
export declare function composeRegions(
  dataset: No2ActivityDataset,
  regionIds: readonly string[],
  minRegions: number,
  method?: No2ActivityMethod,
): No2Composite;
export declare function validateNo2ActivityDataset(
  value: unknown,
  method?: No2ActivityMethod,
): value is No2ActivityDataset;
