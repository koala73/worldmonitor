// Types for scripts/shared/wildfire-fires-summary.mjs so server/*.ts consumers
// stay covered by `npm run typecheck:api` (tsconfig.api.json includes server/).

export declare const WILDFIRE_FIRES_SUMMARY_KEY: 'wildfire:fires-summary:v1';
export declare const WILDFIRE_FIRES_SUMMARY_META_KEY: 'seed-meta:wildfire:fires-summary';
export declare const WILDFIRE_FIRES_SUMMARY_ACTIVATION_KEY: 'seed-activated:wildfire:fires-summary';
export declare const WILDFIRE_FIRES_SUMMARY_SCHEMA_VERSION: 1;

/** The two fields the CII scorer thresholds; zero when the detection did not report one. */
export interface WildfireFireIntensity {
  brightness: number;
  frp: number;
}

export interface WildfireFirmsClock {
  /** `_firmsState` from the canonical merge ('ok', 'failed', ...), or null when absent. */
  state: string | null;
  /** `_firmsPartial === true`: known regions are dark. */
  partial: boolean;
  /** `_firmsCount`, the producer's declared FIRMS row count, or null when absent. */
  count: number | null;
  /** FIRMS rows actually present in the detections array. */
  rows: number;
  newestDetectedAt: number | null;
  oldestDetectedAt: number | null;
}

export interface WildfireFiresSummary {
  schemaVersion: number;
  /** Pre-cap detection count (`pagination.totalCount` when larger than the rows). */
  totalCount: number;
  firms: WildfireFirmsClock;
  /** Detections inside each Tier-1 country, attributed with the CII border file. */
  byCountry: Record<string, WildfireFireIntensity[]>;
}

export declare function summarizeWildfireDetections(
  payload: unknown,
  options?: { nowMs?: number },
): WildfireFiresSummary | null;

export declare function parseWildfireFiresSummary(value: unknown): WildfireFiresSummary | null;
