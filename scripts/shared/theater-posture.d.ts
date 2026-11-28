export interface PostureTheaterRule {
  readonly id: string;
  readonly bounds: { north: number; south: number; east: number; west: number };
  readonly thresholds: { elevated: number; critical: number };
  readonly strikeIndicators: { minTankers: number; minAwacs: number; minFighters: number };
}

export interface PublishedTheaterPosture {
  theater: string;
  postureLevel: 'normal' | 'elevated' | 'critical';
  activeFlights: number;
  trackedVessels: number;
  activeOperations: string[];
  assessedAt: number;
}

export interface VesselHistoryEntry {
  at: number;
  theaters: Record<string, { ais: number; usni: number }>;
}

export const POSTURE_THEATERS: ReadonlyArray<PostureTheaterRule>;
export function calculateTheaterPostures(
  flights: ReadonlyArray<{ lat: number; lon: number; aircraftType?: string }>,
  vesselCounts: ReadonlyMap<string, number>,
  assessedAt?: number,
): PublishedTheaterPosture[];
export function normalizeShipName(name: unknown): string;
export function countUsniVesselsInBounds(
  usniVessels: unknown,
  bounds: PostureTheaterRule['bounds'],
  aisNames: Iterable<string> | null | undefined,
): number;
export const VESSEL_HISTORY_KEY: string;
export const VESSEL_HISTORY_MIN_GAP_MS: number;
export const VESSEL_HISTORY_MAX_ENTRIES: number;
export const VESSEL_HISTORY_TTL_SECONDS: number;
export function appendVesselHistory(
  history: unknown,
  entry: VesselHistoryEntry,
  options?: { minGapMs?: number; max?: number },
): VesselHistoryEntry[];
