export const CHINA_MACRO_SCHEMA_VERSION: 2;
export const CHINA_MACRO_CACHE_KEY: 'economic:china:macro:v2';
export const CHINA_MACRO_PROVENANCE_FAMILY: 'china_macro_official_numeric_observation';
export const CHINA_MACRO_MAX_TRANSPORT_AGE_MIN: number;
export const CHINA_MACRO_MAX_CONTENT_AGE_MIN: number;
export const CHINA_MACRO_REQUIRED_SERIES: readonly string[];
export const CHINA_MACRO_SERIES_MAX_AGE_DAYS: Readonly<Record<string, number>>;
export const CHINA_MACRO_PUBLISHER_IDS: Readonly<Record<'nbs' | 'pboc' | 'safe' | 'gacc', string>>;
export const CHINA_MACRO_SERIES_CONTRACT: Readonly<Record<string, Readonly<{
  pillar: string;
  unit: string;
  periodKind: string;
  source: string;
  publisherId: string;
  sourceHost: string;
  sourcePathPrefix: string;
}>>>;
export const CHINA_MACRO_SERIES_IDS: readonly string[];

export function chinaMacroObservationDateMs(value: unknown): number | null;
export function isChinaMacroObservationStale(
  seriesId: string,
  observationPeriod: string,
  now?: number,
): boolean;
