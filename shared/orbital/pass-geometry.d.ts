import type { SatRec } from 'satellite.js';
import type { SensorCategory, SensorProfile } from './sensor-profiles.js';

/** Published OMM mean elements in CelesTrak's JSON form. */
export interface OmmRecord {
  OBJECT_NAME: string;
  NORAD_CAT_ID: number | string;
  EPOCH: string;
  MEAN_MOTION: number | string;
  [field: string]: unknown;
}

export interface OrbitElements {
  noradId: number;
  name: string;
  epochMs: number;
  meanMotionRevPerDay: number;
  satrec: SatRec;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface TimeWindow {
  start: Date | number;
  end: Date | number;
}

/** One closest approach of a satellite to the point. */
export interface Pass {
  noradId: number;
  name: string;
  profileId: string;
  category: SensorCategory;
  time: string;
  timeMs: number;
  /** A future pass is a chance to image, never an image. */
  opportunity: boolean;
  groundDistanceKm: number;
  /** Which side of the ground track the point lies on, facing the direction of travel. */
  side: 'left' | 'right';
  elevationDeg: number;
  azimuthDeg: number;
  incidenceDeg: number;
  sunElevationDeg: number;
  altitudeKm: number;
  subSatellite: GeoPoint;
  inFootprint: boolean;
  /** Within a few kilometres of the footprint edge, so whether it was imaged is uncertain. */
  edgeOfSwath: boolean;
  /** The mission acquires over this point at all (land and coasts for the open missions). */
  coverage: boolean;
}

export interface GeostationaryVisibility {
  visible: boolean;
  elevationDeg: number;
  subSatelliteLon: number | null;
}

export type PassSearchResult =
  | { status: 'ok'; ageDays: number; passes: Pass[] }
  | { status: 'too-old'; ageDays: number; passes: [] }
  | { status: 'geostationary'; ageDays: number; passes: []; visibility: GeostationaryVisibility };

export interface GroundTrackPoint {
  time: string;
  lat: number;
  lon: number;
}

export const ORBIT_ELEMENTS_MAX_AGE_DAYS: number;
export const PASS_MIN_ELEVATION_DEG: number;
export const EDGE_OF_SWATH_KM: number;

export function parseOrbitElements(omm: OmmRecord): OrbitElements;

export function findPasses(input: {
  elements: OrbitElements;
  profile: SensorProfile;
  point: GeoPoint;
  window: TimeWindow;
  now: Date | number;
}): PassSearchResult;

/** The sub-satellite track, split wherever it crosses the antimeridian. */
export function groundTrack(elements: OrbitElements, window: TimeWindow, stepSeconds?: number): GroundTrackPoint[][];
