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
// Last reviewed: 2026-10-19 (v10 — GDELT escalation stands in for ACLED in Conflict
// and Unrest while ACLED is dark; v9 — news credits every country a headline names;
// v8 — fix dead UCDP conflict-floor attribution:
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
export const CII_FORMULA_VERSION = 'v10';

/**
 * Conflict event activity log curve used before fatality/civilian/strike boosts.
 * Raw activity is weighted by event type and eventMultiplier, then mapped to
 * this cap with `log1p(raw) / log1p(pivot) * cap`.
 */
export const CII_CONFLICT_ACTIVITY_CAP = 70;
export const CII_CONFLICT_ACTIVITY_PIVOT = 4000;

/**
 * GDELT escalation terms inside Conflict and Unrest, used only while the ACLED
 * API returns no events (WorldMonitor has no ACLED access). Input per country
 * and signal, from gdelt:bulk:country-events:v1: `current`, the last 24h of
 * distinct articles reporting events located there (Conflict: CAMEO 18/19/20
 * material conflict; Unrest: CAMEO 14 protest), and `baselineMedian`, the
 * median day of the 28 complete days before yesterday.
 *
 *   r = (current + K) / (baselineMedian + K)
 *   term = r <= R0 ? 0 : min(CAP, log(r / R0) / log(RSAT / R0) * CAP)
 *
 * Scored against each country's OWN norm because GDELT volume is mostly media
 * volume: the US files ~800 conflict-coded articles on an ordinary weekday and
 * Ukraine ~55, so any shared absolute scale ranks the US above a war. K damps
 * small countries (6 articles against a norm of 1 is noise, not a 6x spike);
 * R0 absorbs the weekday news cycle, which swings large markets ~15% above
 * their median. Calibrated on replayed Sep 10 - Oct 19 2026 exports (all
 * Tier-1 countries, 16 days): the Oct 11-12 Riyadh strikes score 44-49 on
 * Conflict, the week before 0, France's Oct 19 riots 50 on Unrest, and US/GB
 * stay at 0-1 on Conflict and 0-7 on Unrest. The cap keeps a news-coded
 * signal with no fatality field below the verified-event range,
 * and eventMultiplier is not applied (it is reserved for verified events).
 * A war or protest movement at its usual tempo scores 0 here by design; UCDP
 * floors carry chronic wars.
 */
export const CII_GDELT_ESCALATION_CAP = 50;
export const CII_GDELT_ESCALATION_SMOOTHING = 20;
export const CII_GDELT_ESCALATION_DEADBAND = 1.25;
export const CII_GDELT_ESCALATION_SATURATION = 3;
/** Older than this (materializer stopped), the snapshot is ignored. */
export const CII_GDELT_ESCALATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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
