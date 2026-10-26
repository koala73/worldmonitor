// Types for scripts/shared/china-no2-activity.mjs so the nowcast reader in
// server/ stays covered by `npm run typecheck:api`.

export declare const CHINA_NO2_ACTIVITY_KEY: 'economic:china:no2-activity:v1';
export declare const CHINA_NO2_ACTIVITY_SEED_META_KEY: 'seed-meta:economic:china-no2-activity';
export declare const CHINA_NO2_ACTIVITY_ACTIVATION_KEY: 'seed-activated:economic:china-no2-activity';
export declare const CHINA_NO2_ACTIVITY_METHOD_VERSION: 'china-no2-activity/v1';
export declare const CHINA_NO2_ACTIVITY_SOURCE_VERSION: string;
export declare const CHINA_NO2_ATTRIBUTION_PREFIX: string;

export interface ChinaNo2ActivityMethod {
  readonly windowDays: number;
  readonly windowEndLagDays: number;
  readonly minValidFraction: number;
  readonly minValidDays: number;
  readonly baselineYears: number;
  readonly minBaselineYears: number;
  readonly minRegions: number;
  readonly deadBandPercent: number;
  readonly timeliness: 'OFFL';
  readonly minQa: number;
  readonly resolutionDegrees: number;
  readonly holidayMask: { readonly daysBefore: number; readonly daysAfter: number };
}

export declare const CHINA_NO2_ACTIVITY_METHOD: ChinaNo2ActivityMethod;

export interface ChinaNo2Region {
  readonly id: string;
  readonly label: string;
  /** West, south, east, north in CRS84 degrees. */
  readonly bbox: readonly [number, number, number, number];
}

export declare const CHINA_NO2_REGIONS: readonly ChinaNo2Region[];
export declare const LUNAR_NEW_YEAR_DATES: Readonly<Record<number, string>>;

export type ChinaNo2RegionExclusion =
  | 'request_failed'
  | 'insufficient_valid_days'
  | 'insufficient_baseline_years';
export type ChinaNo2CompositeExclusion = 'insufficient_regions';

export declare const CHINA_NO2_REGION_EXCLUSIONS: readonly ChinaNo2RegionExclusion[];
export declare const CHINA_NO2_COMPOSITE_EXCLUSIONS: readonly ChinaNo2CompositeExclusion[];

export interface ChinaNo2Window {
  /** UTC calendar date, inclusive. */
  windowStart: string;
  /** UTC calendar date, inclusive. */
  windowEnd: string;
  validDays: number;
  maskedDays: number;
  meanNo2MolM2: number | null;
  meanValidFraction: number | null;
}

export interface ChinaNo2BaselineYear extends ChinaNo2Window {
  year: number;
}

export interface ChinaNo2RegionResult {
  id: string;
  label: string;
  bbox: readonly [number, number, number, number];
  current: ChinaNo2Window;
  baseline: {
    years: ChinaNo2BaselineYear[];
    meanNo2MolM2: number | null;
  };
  changePercent: number | null;
  exclusion: ChinaNo2RegionExclusion | null;
}

export interface ChinaNo2Composite {
  changePercent: number | null;
  /** `changePercent` outside the dead band, 0 inside it, null when excluded. */
  signalValue: number | null;
  regionIds: string[];
  exclusion: ChinaNo2CompositeExclusion | null;
}

export interface ChinaNo2ActivitySource {
  publisherId: 'publisher:copernicus-sentinel-5p';
  dataset: 'sentinel-5p-l2';
  band: 'NO2';
  unit: 'mol/m2';
  attribution: string;
  requestCount: number;
  processingUnitsSpent: number;
}

export interface ChinaNo2ActivityPayload {
  methodVersion: typeof CHINA_NO2_ACTIVITY_METHOD_VERSION;
  generatedAt: string;
  method: ChinaNo2ActivityMethod;
  source: ChinaNo2ActivitySource;
  regions: ChinaNo2RegionResult[];
  composite: ChinaNo2Composite;
}

export declare function isLunarNewYearHoliday(
  isoDate: string,
  method?: ChinaNo2ActivityMethod,
): boolean;

export declare function validateChinaNo2ActivityPayload(
  value: unknown,
  method?: ChinaNo2ActivityMethod,
): value is ChinaNo2ActivityPayload;
