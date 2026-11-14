export type SensorCategory =
  | 'open-optical'
  | 'open-radar'
  | 'weather-polar'
  | 'commercial-optical'
  | 'commercial-radar'
  | 'government-optical'
  | 'government-radar'
  | 'open-lidar'
  | 'military'
  | 'crewed-station'
  | 'geostationary';

export type Footprint =
  | { kind: 'nadir-swath'; swathKm: number }
  | { kind: 'side-looking'; side: 'left' | 'right'; incidenceDeg: readonly [number, number] }
  /** Off-nadir look angles the operator can steer to, on either side. `assumed` marks reach WorldMonitor assumes rather than one the operator publishes. */
  | { kind: 'steerable'; lookAngleDeg: readonly [number, number]; assumed?: boolean }
  | { kind: 'horizon'; minElevationDeg: number }
  | { kind: 'full-disk' };

export interface SensorProfile {
  id: string;
  family: string;
  operator: string;
  category: SensorCategory;
  noradIds: readonly number[];
  namePatterns: readonly string[];
  footprint: Footprint;
  /** Best ground sample distance in metres a cited source states; null where none does. */
  resolutionM: number | null;
  /** Whether the sensor needs sunlight to see the ground (passive optical). */
  daylight: boolean;
  /** Public archive collection that holds the sensor's products; null when none is public. */
  archive: string | null;
  /** Where the mission acquires: land and coasts only, or everywhere. */
  coverage: 'land-coast' | 'global';
  /** Hours after a pass before an archive's silence counts as "not in archive". */
  archiveWaitHours?: number;
  dailyMosaic?: boolean;
  sources: readonly string[];
}

export const SENSOR_INVENTORY_VERSION: string;
export const SENSOR_CATEGORIES: readonly SensorCategory[];
export const SENSOR_PROFILES: readonly SensorProfile[];

/** Matches by NORAD catalogue id first, then by object-name pattern. */
export function matchSensorProfile(noradId: number | string, name: string | null | undefined): SensorProfile | null;
