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
// Last reviewed: 2026-10-21 (v14 drops the cyber boost, whose feeds place attacker
// infrastructure rather than victims, and scores only foreign military flights and
// vessels in Security; v13 adds a bounded fresh arrival surge boost;
// v12 — strike pressure: strikes on a country, from the
// strike feed and GDELT worldwide, decay over days into a floor and a boost on the
// composite, replacing the 72h strikeBoost in Conflict; v11 — real country borders replace bounding boxes for geo
// events, and a sustained GDELT level joins escalation (cap 50 -> 70); v10 — GDELT
// escalation stands in for ACLED in Conflict
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
export const CII_FORMULA_VERSION = 'v14';

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
 * Tier-1 countries, 16 days): the Oct 11-12 Riyadh strikes score 61-68 on
 * Conflict, the week before 0, France's Oct 19 riots 70 on Unrest, and US/GB
 * stay at 0-1 on Conflict and 0-10 on Unrest. eventMultiplier is not applied
 * (it is reserved for verified events). A war or protest movement at its usual
 * tempo scores 0 on escalation by design; the sustained level below reads it.
 *
 * CAP is shared with the level term. v10 used 50; v11 uses 70, the cap of the
 * ACLED activity term (CII_CONFLICT_ACTIVITY_CAP) these terms stand in for.
 * Replayed on Oct 5, 12, 14 and 19, the US, GB, China, Korea, Taiwan, Qatar and
 * the UAE score identically under 70 and 50; the largest difference is +4
 * (France's riots, Yemen), and Germany, Japan, Egypt and Poland move by at most
 * 1 on single days. Under 50, Saudi Arabia never clears its advisory floor of
 * 50, even in the strike week; under 70 it reaches 52 on Oct 12. A capped term
 * moves the combined score by at most 12.6 (Conflict) or 10.5 (Unrest).
 */
export const CII_GDELT_ESCALATION_CAP = 70;
export const CII_GDELT_ESCALATION_SMOOTHING = 20;
export const CII_GDELT_ESCALATION_DEADBAND = 1.25;
export const CII_GDELT_ESCALATION_SATURATION = 3;
/** Older than this (materializer stopped), the snapshot is ignored. */
export const CII_GDELT_ESCALATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Sustained GDELT level, the second half of each GDELT term (v11). A crisis
 * that lasts weeks raises its own 28-day median, so escalation alone reads it
 * as calm: a month of strikes on Saudi Arabia left its v10 Conflict term at 0.
 * Input per country, from the same snapshot: `week`, the distinct articles of
 * the seven complete days through yesterday, and how many of them were
 * conflict-coded (CAMEO 18/19/20) and protest-coded (CAMEO 14). The level
 * reads the SHARE, so media volume cancels out:
 *
 *   share = coded / articles   (0 when articles < MIN_ARTICLES)
 *   level = min(CAP, max(0, (share - FLOOR) / (SATURATION - FLOOR)) * CAP)
 *   term  = max(escalation, level)   (never the sum: one signal, two readings)
 *
 * FLOOR is the noise floor every country carries: GDELT codes US crime and
 * policing as conflict, so the US sits at 11-13.5% every week of the Sep 10 -
 * Oct 19 2026 replay, and protest coding runs ~1% almost everywhere. SATURATION
 * is a country at war (Yemen 28-43%) or a nationwide protest movement (France
 * 7.9% during the October riots). On Oct 19 (seven days through Oct 18):
 * Yemen 39% -> 68, Saudi Arabia 29% -> 41 (14.7% -> 2 in the week before the
 * strikes), Israel 23% -> 25, US/GB/China 0; on Unrest France 70, India 65
 * (7.6%), Brazil 9. MIN_ARTICLES keeps small-coverage countries (Myanmar, 47
 * articles) from scoring a share of a few dozen articles.
 */
export const CII_GDELT_LEVEL_MIN_ARTICLES = 200;
export const CII_GDELT_LEVEL_CONFLICT_FLOOR = 0.14;
export const CII_GDELT_LEVEL_CONFLICT_SATURATION = 0.40;
export const CII_GDELT_LEVEL_PROTEST_FLOOR = 0.02;
export const CII_GDELT_LEVEL_PROTEST_SATURATION = 0.08;

/**
 * Strike pressure (v12). Owner decision, 2026-10-19: a country being struck
 * should rise, keep rising while the attacks continue, and decay once they
 * stop, worldwide. Each country gets a daily strike intensity x_d, and
 *
 *   P = sum over the last WINDOW_DAYS of x_d * 0.5^(age_d / HALF_LIFE_DAYS)
 *
 * with age_d measured from the middle of day d (today's strikes weigh in full).
 * A country hit at a steady rate r converges on P = r / (1 - 0.5^(1/3)) ~ 4.85 r;
 * once the strikes stop P halves every three days and is under 4% of its peak
 * after two weeks.
 *
 * x_d = max(confirmed_d, gdelt_d), never the sum (one strike, two reporters):
 *  - confirmed_d, from the Middle East strike feed (conflict:strike-pressure:v1,
 *    and the 72h conflict:iran-events:v1 window it is built from), is each
 *    incident weighted by severity (SEVERITY_WEIGHTS).
 *  - gdelt_d, worldwide (gdelt:bulk:country-events:v1, only while ACLED is
 *    dark), is CAMEO 194/195 coverage of strikes on the country as a share of
 *    its coverage that day: GDELT_SCALE * max(0, s / (a + GDELT_SMOOTHING) -
 *    GDELT_NOISE_FLOOR). Absolute counts are media-volume biased (Oct 5-18
 *    2026: the US 12.9 strike-coded articles a day, Ukraine 11.1); the share
 *    is not (US 0.03%, Ukraine 1.2%, Saudi Arabia 5.5%). GDELT alone counts
 *    only for a campaign: a day counts when, of the measured days among the
 *    seven ending on it (at least GDELT_MIN_MEASURED_DAYS), the share over the
 *    floor is at least GDELT_SUSTAINED_DAYS in 7. A one-day missile-test spike
 *    (North Korea, Oct 12: 8 of 51 articles) is not a strike on the country,
 *    and a campaign keeps decaying after it ends. GDELT_SCALE
 *    puts both sources on one scale: Saudi Arabia's Oct 16-18 coverage (3.0%
 *    on average) matches its confirmed Oct 16-18 tally (5-10 a day).
 *
 * P enters the composite twice, calibrated on replayed Sep 18 - Oct 19 2026
 * exports and the live feed (docs/methodology/cii-risk-scores.mdx):
 *  - a floor, like the advisory and UCDP floors:
 *      P < FLOOR_MIN_PRESSURE ? 0 : min(FLOOR_CAP, FLOOR_BASE + FLOOR_PER_DOUBLING * log2(P / FLOOR_MIN_PRESSURE))
 *  - a boost on the blended score, so a country already above every floor
 *    (Yemen) still rises when it is hit harder:
 *      min(BOOST_CAP, BOOST_PER_DOUBLING * log2(1 + P / BOOST_PIVOT))
 * It replaces the 72h strikeBoost that sat inside Conflict (v4-v11): the same
 * feed counted there with no memory, and only through Conflict's 18% weight.
 */
export const CII_STRIKE_HALF_LIFE_DAYS = 3;
export const CII_STRIKE_WINDOW_DAYS = 21;
export const CII_STRIKE_SEVERITY_WEIGHTS = { critical: 4, high: 2, elevated: 1, moderate: 0.5 } as const;
/**
 * The confirmed tally's days are dated and decay on every read, so a stale
 * tally can only miss new strikes, never hold old pressure up: a relay outage
 * of a few hours must not drop three weeks of history (that would read unknown
 * as calm). Past this age (a relay dead for days; health alarms after 45
 * minutes) the tally is ignored and GDELT alone carries every country.
 */
export const CII_STRIKE_CONFIRMED_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const CII_STRIKE_GDELT_SMOOTHING = 50;
export const CII_STRIKE_GDELT_NOISE_FLOOR = 0.005;
export const CII_STRIKE_GDELT_SCALE = 300;
export const CII_STRIKE_GDELT_SUSTAINED_DAYS = 4;
export const CII_STRIKE_GDELT_MIN_MEASURED_DAYS = 3;
export const CII_STRIKE_FLOOR_MIN_PRESSURE = 5;
export const CII_STRIKE_FLOOR_BASE = 40;
export const CII_STRIKE_FLOOR_PER_DOUBLING = 8;
export const CII_STRIKE_FLOOR_CAP = 70;
export const CII_STRIKE_BOOST_PIVOT = 5;
export const CII_STRIKE_BOOST_PER_DOUBLING = 2.5;
export const CII_STRIKE_BOOST_CAP = 10;

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
