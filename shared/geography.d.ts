// Type declarations for shared/geography.js.
// See shared/regions.types.d.ts for the snapshot model types.

import type { RegionId } from './regions.types.js';

export interface RegionDef {
  id: RegionId;
  label: string;
  forecastLabel: string;
  wbCode: string;
  theaters: string[];
  /**
   * Broad display labels emitted by cross-source feeds that do not substring-
   * match any fine-grained theater ID. Lowercased so the matching helper can
   * compare directly. Example: MENA includes "middle east", SSA includes
   * "sub-saharan africa".
   */
  signalAliases: string[];
  feedRegion: string;
  mapView: string;
  keyCountries: string[];
}

export interface TheaterDef {
  id: string;
  label: string;
  regionId: RegionId;
  corridorIds: string[];
}

export interface CorridorDef {
  id: string;
  label: string;
  theaterId: string;
  /** Maps to existing chokepoint IDs in supply_chain:chokepoints:v4. Null for non-chokepoint corridors (Cape route, English Channel). */
  chokepointId: string | null;
  /** 1 = critical global, 2 = major regional, 3 = secondary/reroute */
  tier: 1 | 2 | 3;
  /** 0-1 normalized weight for maritime_access scoring */
  weight: number;
}

export const REGION_IDS: RegionId[];
export const GEOGRAPHY_VERSION: string;
export const REGIONS: readonly RegionDef[];
export const THEATERS: readonly TheaterDef[];
export const CORRIDORS: readonly CorridorDef[];
export const COUNTRY_CRITICALITY: Record<string, number>;
export const DEFAULT_COUNTRY_CRITICALITY: number;

export function getRegion(regionId: string): RegionDef | null;
export function getRegionCountries(regionId: string): string[];
export function regionForCountry(iso2: string): RegionId | null;
export function getRegionTheaters(regionId: string): TheaterDef[];
export function getTheaterCorridors(theaterId: string): CorridorDef[];
export function getRegionCorridors(regionId: string): CorridorDef[];
export function countryCriticality(iso2: string): number;

/**
 * Returns true when a cross-source signal's raw `theater` label belongs to
 * the given region. Case-insensitive, tolerates kebab-case or spaced labels,
 * and matches against both fine-grained theater IDs and the region's
 * `signalAliases` for broad display labels.
 */
export function isSignalInRegion(
  theater: string | null | undefined,
  regionOrId: string | RegionDef,
): boolean;
