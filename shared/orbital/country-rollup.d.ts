import type { FlagProjection, FlagScene } from './flag-record.js';

export declare const SITES_SCHEMA: 1;
export declare const ROLLUP_MAX_AGE_MS: number;

export interface CountryRollupSite {
  siteId: string;
  name: string;
  lat: number;
  lon: number;
  surface: string;
  originLists: string[];
  revision: string;
  evaluatedAt: number;
  lastObservation: { itemId: string; profileId: string; datetime: string } | null;
  nextWindow: { profileId: string; time: string } | null;
  operators: string[];
  flag: FlagProjection | null;
}

export interface CountryRollup {
  schema: typeof SITES_SCHEMA;
  countryCode: string;
  asOf: number;
  revision: string;
  sites: CountryRollupSite[];
}

export type CountryRollupRead =
  | { status: 'current'; rollup: CountryRollup }
  | { status: 'missing' | 'malformed' | 'superseded' | 'stale' };

export interface ConfirmedSiteFlag {
  siteId: string;
  name: string;
  geometryKey: string;
  raised: FlagScene | null;
  confirmed: FlagScene;
}

export function readCountryRollup(raw: unknown, index: unknown, countryCode: string, nowMs: number, maxAgeMs?: number): CountryRollupRead;
export function scoredSiteCount(rollup: CountryRollup): number;
export function confirmedSiteFlags(rollup: CountryRollup): ConfirmedSiteFlag[];
export function confirmedFlagsTag(flags: readonly ConfirmedSiteFlag[]): string;
