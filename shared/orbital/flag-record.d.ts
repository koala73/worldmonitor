export declare const FLAG_SCHEMA: 1;
export declare const FLAG_WORDING: 'imagery statistics changed';

export interface ChangeThresholds {
  minBaselineScenes: number;
  maxBaselineScenes: number;
  spreadMultiplier: number;
  absoluteFloorDb: number;
  minSigmaDb: number;
}
export declare const CHANGE_THRESHOLDS: Readonly<ChangeThresholds>;

export type TrackState = 'baseline-building' | 'monitoring' | 'raised' | 'confirmed';
export declare const TRACK_STATES: readonly TrackState[];
export declare const MAX_FLAG_EVENTS: number;

/** The acquisition geometry a baseline is specific to. */
export interface RadarGeometry {
  constellation: string;
  relativeOrbit: number;
  orbitState: 'ascending' | 'descending';
  mode: string;
  polarizations: string[];
}

/** One scene's statistics over the site footprint, in decibels, keyed `<band>_<statistic>`. */
export interface FlagObservation {
  itemId: string;
  datetime: string;
  platform: string | null;
  values: Record<string, number>;
}

export interface FlagScene {
  itemId: string;
  datetime: string;
  platform: string | null;
}

export interface ComponentChange {
  component: string;
  deltaDb: number;
  sigmaDb: number;
}

export interface FlagTrack {
  geometry: RadarGeometry;
  state: TrackState;
  baseline: FlagObservation[];
  /** The changed scene awaiting a second comparable scene. */
  candidate: { observation: FlagObservation; changes: ComponentChange[] } | null;
  /** The scene that confirmed the track's current change, and the scene that raised it. */
  confirmedBy: (FlagScene & { raisedBy: FlagScene }) | null;
  lastDatetime: string | null;
}

export interface FlagEvent {
  kind: 'raised' | 'confirmed' | 'retracted';
  geometryKey: string;
  itemId: string;
  datetime: string;
  platform: string | null;
  changes: ComponentChange[];
}

/** The one canonical change-flag record of a watched land site. */
export interface FlagRecord {
  schema: typeof FLAG_SCHEMA;
  siteId: string;
  wording: typeof FLAG_WORDING;
  footprint: { lat: number; lon: number; halfSizeDeg: number };
  state: TrackState;
  tracks: Record<string, FlagTrack>;
  events: FlagEvent[];
  backfilledAt: number | null;
  updatedAt: number;
}

export interface FlagProjection {
  state: TrackState;
  wording: typeof FLAG_WORDING;
  updatedAt: number;
  confirmed: (FlagScene & { geometryKey: string; raisedBy: FlagScene }) | null;
}

export function geometryKey(geometry: RadarGeometry): string;
export function newTrack(geometry: RadarGeometry): FlagTrack;
export function changesFrom(baseline: FlagObservation[], observation: FlagObservation, thresholds?: ChangeThresholds): ComponentChange[];
export function advanceTrack(track: FlagTrack, observation: FlagObservation, thresholds?: ChangeThresholds): { track: FlagTrack; event: FlagEvent | null };
export function siteFlagState(tracks: Record<string, FlagTrack>): TrackState;
export function projectFlag(flag: FlagRecord | null): FlagProjection | null;
