// T1.5 Phase 1 of the country-resilience reference-grade upgrade plan
// (docs/internal/country-resilience-upgrade-plan.md).
//
// Foundation-only slice: the staleness classifier. This module defines
// the cadence taxonomy (Realtime, Daily, Weekly, Monthly, Annual), the
// three-level staleness output (fresh, aging, stale), and a pure
// classifier function that maps a `lastObservedAt` timestamp and a
// source cadence to a staleness level.
//
// What is deliberately NOT in this module:
//
// - No changes to the 13 dimension scorers. Propagating `lastObservedAt`
//   through each scorer and aggregating max age per dimension is the
//   next slice of T1.5 and will depend on this classifier. Keeping the
//   classifier in its own module means that slice becomes a simple
//   consumer wiring pass with no test surface for the classifier itself.
// - No schema changes (proto, OpenAPI, ResilienceDimension response
//   type). The schema field `freshness: { lastObservedAt, staleness }`
//   lands alongside the widget rendering in T1.6 and consumes this
//   classifier.
// - No widget rendering. T1.6 owns the per-dimension freshness badge
//   UI and will call `classifyStaleness` from the widget path at render
//   time given the already-exposed `lastObservedAt` field.
//
// The multiplier thresholds below come from a simple rule: a source is
// fresh if its age is less than 1.5 times its cadence, aging if less
// than 3 times, stale otherwise. This scales gracefully across the 5
// cadences the methodology document lists without per-cadence ad-hoc
// numbers.

export type ResilienceCadence = 'realtime' | 'daily' | 'weekly' | 'monthly' | 'annual';

export type StalenessLevel = 'fresh' | 'aging' | 'stale';

// Canonical cadence duration in milliseconds. A "unit" of each cadence.
// Realtime sources are expected to refresh within an hour; daily within
// a day; annual within a year. A simple, defensible base.
const CADENCE_UNIT_MS: Record<ResilienceCadence, number> = {
  realtime: 60 * 60 * 1000,                     // 1 hour
  daily: 24 * 60 * 60 * 1000,                   // 1 day
  weekly: 7 * 24 * 60 * 60 * 1000,              // 7 days
  monthly: 30 * 24 * 60 * 60 * 1000,            // 30 days
  annual: 365 * 24 * 60 * 60 * 1000,            // 365 days
};

// Multiplier thresholds applied to the cadence unit. A source is fresh
// when its age is less than `FRESH_MULTIPLIER * cadenceUnit`, aging when
// less than `AGING_MULTIPLIER * cadenceUnit`, stale otherwise.
export const FRESH_MULTIPLIER = 1.5;
export const AGING_MULTIPLIER = 3;

export function cadenceUnitMs(cadence: ResilienceCadence): number {
  return CADENCE_UNIT_MS[cadence];
}

export interface ClassifyStalenessArgs {
  /** Unix milliseconds when the signal was last observed. */
  lastObservedAtMs: number | null | undefined;
  /** Cadence of the source publishing the signal. */
  cadence: ResilienceCadence;
  /** Override the current time for deterministic testing. Defaults to Date.now(). */
  nowMs?: number;
}

export interface StalenessResult {
  staleness: StalenessLevel;
  ageMs: number;
  /** The age expressed as a multiple of the cadence unit. Handy for debugging. */
  ageInCadenceUnits: number;
}

/**
 * Classify how fresh a signal is relative to its cadence.
 *
 * Returns `'stale'` when `lastObservedAtMs` is null, undefined, NaN, or
 * in the future. Returns `'fresh'` when age is strictly less than
 * `FRESH_MULTIPLIER * cadenceUnit`. Returns `'aging'` when age is
 * strictly less than `AGING_MULTIPLIER * cadenceUnit`. Returns `'stale'`
 * otherwise.
 *
 * The function is pure: same inputs, same outputs, no side effects.
 * `nowMs` is accepted for deterministic unit tests.
 */
export function classifyStaleness(args: ClassifyStalenessArgs): StalenessResult {
  const { lastObservedAtMs, cadence } = args;
  const nowMs = args.nowMs ?? Date.now();
  const unit = cadenceUnitMs(cadence);

  if (
    lastObservedAtMs == null ||
    !Number.isFinite(lastObservedAtMs) ||
    lastObservedAtMs > nowMs
  ) {
    return { staleness: 'stale', ageMs: Number.POSITIVE_INFINITY, ageInCadenceUnits: Number.POSITIVE_INFINITY };
  }

  const ageMs = Math.max(0, nowMs - lastObservedAtMs);
  const ageInCadenceUnits = ageMs / unit;

  let staleness: StalenessLevel;
  if (ageInCadenceUnits < FRESH_MULTIPLIER) {
    staleness = 'fresh';
  } else if (ageInCadenceUnits < AGING_MULTIPLIER) {
    staleness = 'aging';
  } else {
    staleness = 'stale';
  }

  return { staleness, ageMs, ageInCadenceUnits };
}
