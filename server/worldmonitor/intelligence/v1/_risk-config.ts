// ============================================================================
// CII / Strategic Risk — editorial coefficients
// ============================================================================
//
// These constants drive the published Composite Instability Index (CII) and
// Strategic Risk roll-up scores. They are EDITORIAL WEIGHTS authored by the
// WorldMonitor intelligence team — NOT derived from a published academic
// index, peer-reviewed paper, or external risk product. Treat them as
// opinionated, not empirical.
//
// Change protocol:
//   1. Bump CII_FORMULA_VERSION below.
//   2. Update docs/methodology/cii-risk-scores.mdx (the public methodology
//      note) in the same commit. Tests assert the doc lists every coefficient
//      and every CURATED_COUNTRIES code.
//   3. Note the change in docs/changelog.mdx and CHANGELOG.md under the
//      public-facing section so downstream users of the proto API see why score
//      values or movement semantics may shift between deploys.
//
// Last reviewed: 2026-06-06 (v8 — fix dead UCDP conflict-floor attribution:
// the scorer read non-existent `intensity_level`/`type_of_violence` fields, so
// UCDP never applied a war/minor floor and never counted toward health coverage.
// Now classifies via the cached feed's real `violenceType`/`deathsBest`/`dateStart`
// fields using the frontend `deriveUcdpClassifications` heuristic).
// ============================================================================

/**
 * Formula version emitted on every CiiScore as `methodology_version`.
 * Bump on coefficient or scoring-contract changes so API clients can detect
 * score or movement-semantics drift.
 */
export const CII_FORMULA_VERSION = 'v8';

/**
 * Conflict event activity log curve used before fatality/civilian/strike boosts.
 * Raw activity is weighted by event type and eventMultiplier, then mapped to
 * this cap with `log1p(raw) / log1p(pivot) * cap`.
 */
export const CII_CONFLICT_ACTIVITY_CAP = 70;
export const CII_CONFLICT_ACTIVITY_PIVOT = 4000;

/**
 * Strategic-risk top-N positional decay step. Weight for position `i` (0-based)
 * is `1 - i * STRATEGIC_RISK_POSITIONAL_DECAY`. With the current value of 0.15
 * and a top-5 window, weights are [1.00, 0.85, 0.70, 0.55, 0.40].
 *
 * Rationale: gives the most-affected country full weight, lets the next four
 * contribute decreasing influence, and keeps the roll-up focused on the
 * published top-5 window. The next 1-based position 6 (0-based index 5) would
 * still carry weight 0.25, so the window cap, not a zero-weight cutoff, bounds
 * the slice.
 */
export const STRATEGIC_RISK_POSITIONAL_DECAY = 0.15;

/**
 * Minimum strategic-risk score floor. The weighted top-5 average is rescaled
 * via `weightedAvg * STRATEGIC_RISK_SCALE_FACTOR + STRATEGIC_RISK_SCALE_FLOOR`,
 * which clamps the output to the band `[15, 85]` before the final `min(100)`.
 *
 * Rationale: the global picture is never "all clear" — a baseline of 15 keeps
 * the dial visually meaningful when every Tier-1 country is calm.
 */
export const STRATEGIC_RISK_SCALE_FLOOR = 15;

/**
 * Strategic-risk scale-compression factor. Together with the floor, this maps
 * a weighted top-5 average of `[0, 100]` into `[15, 85]` before the `min(100)`
 * clamp. Prevents a single very-high country from saturating the global score.
 */
export const STRATEGIC_RISK_SCALE_FACTOR = 0.7;

/**
 * Size of the top-N window used for the strategic-risk roll-up.
 * Tied to STRATEGIC_RISK_POSITIONAL_DECAY: with decay=0.15, the next 1-based
 * position 6 (0-based index 5) still has weight=0.25; we cap at 5 so the
 * roll-up reflects the "very top" of the dashboard rather than a long tail.
 */
export const STRATEGIC_RISK_TOP_N = 5;
