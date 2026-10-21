/**
 * Sprint 1 / U5 — pure cooldown decision module.
 *
 * Computes a "would-have-suppressed" decision for a given (user, slot,
 * cluster, channel, rule) candidate against the U4 delivered-log's
 * `lastDelivered*` state. Sprint 1 ships this in SHADOW MODE — the
 * decision is logged but never gates a send. Sprint 2 (post-replay
 * validation) flips the connection to enforcement.
 *
 * Pure function: no I/O, no side effects. Caller resolves the
 * `lastDeliveredAt` / `lastDeliveredSourceCount` / `lastDeliveredTier`
 * inputs from a single Upstash GET on the U4 key
 *   `digest:sent:v1:{userId}:{channel}:{ruleId}:{clusterId}`
 * (value JSON shape `{sentAt, sourceCount, severity}` per
 * `scripts/lib/digest-delivered-log.mjs:148-170`).
 *
 * ── Cooldown table (initial; tunable post-replay in U6) ──────────────
 *
 *   | Type                              | Floor | Re-allow trigger                       |
 *   |-----------------------------------|-------|----------------------------------------|
 *   | CRITICAL · developing kinetic     | 4h    | +5 sources OR new fact OR severity     |
 *   | CRITICAL · sustained narrative    | 24h ✱ | new fact only                          |
 *   | HIGH · event                      | 18h   | +5 sources OR new fact                 |
 *   | HIGH · earnings/single-corporate  | 48h ✱ | real follow-up event (escalation)      |
 *   | Analysis (doctrine, research)     | 7d ✱  | never within window (hard floor)       |
 *   | MED                               | 36h   | any update                             |
 *
 *   ✱ = "hard" floor (no source-count evolution bypass; only listed
 *       trigger). The non-hard floors honour the +5-sources / new-fact
 *       evolution bypasses on top of the floor check.
 *
 * Severity-tier change is a universal allow trigger across all classes
 * EXCEPT the hard-floor ones (Analysis 7d, single-corp 48h) — a follow-up
 * regulatory event on a corporate-earnings cluster is the encoded "real
 * follow-up event" trigger, captured by the caller setting `currentTier`
 * on the corp-earnings re-air to a higher tier than `lastDeliveredTier`.
 *
 * ── Type classifier (Sprint 1 stub; Sprint 3 ships final taxonomy) ───
 *
 *   1. Source domain `usni.org|csis.org|brookings.edu|*.edu|nature.com|
 *      sciencemag.org` → 'analysis'
 *   2. Source domain `*.gov` AND headline matches
 *      `/LICENSE NO\.|Final Rule|Notice of/` → 'sanctions-regulatory'
 *   3. Headline matches `/(beat|miss|tops|exceeds) (forecast|estimate|
 *      profit)/i` → 'high-single-corporate'
 *   4. Severity from existing scoring → 'critical-developing' (when
 *      severity='critical' AND we have no sustained marker), else
 *      'critical-sustained' for repeat critical airings (3+ priors),
 *      'high-event' for severity='high', 'med' for severity='medium'.
 *   5. Missing classification → fallback 'high-event' (18h floor) +
 *      `classificationMissing: true` flag for telemetry.
 *
 * ── Decision input / output shapes ───────────────────────────────────
 *
 * Input fields used by this module:
 *   userId, slot, clusterId, channel, ruleId   — opaque pass-through;
 *                                                 only used in logs.
 *   type            — pre-classified label OR null to invoke classifier
 *   severity        — current-airing severity tier ('critical' | 'high' |
 *                     'medium' | 'low')
 *   currentSourceCount, currentTier   — current-airing observables
 *   lastDeliveredAt — epoch ms; null/undefined means "no prior delivery"
 *   lastDeliveredSourceCount, lastDeliveredTier  — read from U4 row
 *   classifierInputs (optional) — { sourceDomain, headline } when caller
 *                                  wants the stub classifier to run.
 *   nowMs (optional) — epoch ms for tests; defaults to Date.now().
 *
 * Output:
 *   { decision: 'allow' | 'suppress',
 *     reason: string,            — see REASON_* constants
 *     cooldownHours: number,     — applicable floor for this type
 *     evolutionDelta: object,    — { sourceCountDelta, tierChanged } when relevant
 *     classifiedType: string,    — final type used for the decision
 *     classificationMissing: boolean, — true when stub fell back to
 *                                       'high-event' default
 *   }
 *
 * Output reasons (string consts; downstream observers may switch on
 * these). Stable contract — adding a reason is fine; renaming requires
 * a coordinated change in `scripts/lib/digest-cooldown-shadow-log.mjs`
 * + the U6 replay harness.
 */

// ── Cooldown floors (hours) ──────────────────────────────────────────

/**
 * @typedef {'critical-developing' | 'critical-sustained' | 'high-event' |
 *           'high-single-corporate' | 'analysis' | 'sanctions-regulatory' |
 *           'med'} CooldownType
 */

/**
 * @type {Record<CooldownType, { hours: number, hard: boolean,
 *   allowSourceCountEvolution: boolean, allowNewFact: boolean,
 *   allowTierChange: boolean }>}
 */
const COOLDOWN_TABLE = Object.freeze({
  'critical-developing':       { hours: 4,        hard: false, allowSourceCountEvolution: true,  allowNewFact: true, allowTierChange: true },
  'critical-sustained':        { hours: 24,       hard: true,  allowSourceCountEvolution: false, allowNewFact: true, allowTierChange: false },
  'high-event':                { hours: 18,       hard: false, allowSourceCountEvolution: true,  allowNewFact: true, allowTierChange: true },
  // Codex PR #3617 P2 — `tierChangeMode: 'escalation-only'` is the
  // load-bearing signal. The table comment above ("real follow-up event
  // = tier escalation") was the documented contract, but the pre-fix
  // `allowTierChange: true` permitted ANY tier change including
  // de-escalations, so a HIGH→MEDIUM earnings repeat inside 48h
  // returned allow / severity_tier_change. Downgrade is editorial noise,
  // not a follow-up signal.
  'high-single-corporate':     { hours: 48,       hard: true,  allowSourceCountEvolution: false, allowNewFact: false, allowTierChange: true, tierChangeMode: 'escalation-only' },
  // Sanctions/regulatory are treated like high-event by default — they
  // get a floor + evolution bypasses. Sprint 3's classifier may split
  // this further (e.g., immediate-effect vs scheduled).
  'sanctions-regulatory':      { hours: 18,       hard: false, allowSourceCountEvolution: true,  allowNewFact: true, allowTierChange: true },
  'analysis':                  { hours: 7 * 24,   hard: true,  allowSourceCountEvolution: false, allowNewFact: false, allowTierChange: false },
  'med':                       { hours: 36,       hard: false, allowSourceCountEvolution: true,  allowNewFact: true, allowTierChange: true },
});

const SOURCE_COUNT_EVOLUTION_DELTA = 5;

// Severity tier ordering for "tier change" detection. Higher number =
// higher severity. When `currentTier > lastTier` the cluster has
// escalated — usually allow. When `currentTier < lastTier` it has
// de-escalated — also allow under the spirit of "tier changed", because
// the user may want to know a previously-critical event has cooled.
const SEVERITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
});

// ── Reason constants (stable wire contract) ──────────────────────────

export const REASON = Object.freeze({
  NO_PRIOR_DELIVERY: 'no_prior_delivery',
  COOLDOWN_FLOOR: 'cooldown_floor',
  COOLDOWN_DISABLED: 'cooldown_disabled',
  EVOLUTION_SOURCE_COUNT: 'evolution_source_count',
  EVOLUTION_NEW_FACT: 'evolution_new_fact',
  SEVERITY_TIER_CHANGE: 'severity_tier_change',
  ANALYSIS_7D_HARD: 'analysis_7d_hard',
  SINGLE_CORP_48H_HARD: 'single_corp_48h_hard',
  CLASSIFICATION_MISSING_DEFAULT_HIGH: 'classification_missing_default_high',
});

// Stub classifier domains. Each registered domain matches three host shapes:
//   1. exact: `usni.org`
//   2. www-prefixed: `www.usni.org`  (strip leading `www.` before exact match)
//   3. subdomain: `editorial.usni.org`, `media.nature.com`  (suffix match)
// Codex PR #3617 P2 — pre-fix only handled exact matches, so common
// real-world hosts like `www.usni.org` and `www.nature.com` fell through
// to the severity-derived fallback (high-event 18h floor) instead of
// the analysis 7d hard floor. That broke shadow telemetry for the
// dominant publication-host shape.
const ANALYSIS_DOMAINS = Object.freeze([
  'usni.org', 'csis.org', 'brookings.edu', 'nature.com', 'sciencemag.org',
]);
const ANALYSIS_DOMAIN_SUFFIXES = Object.freeze(['.edu']);
const GOV_DOMAIN_SUFFIXES = Object.freeze(['.gov', '.gov.uk', '.gov.us']);

/**
 * Normalise a host for the analysis-domain checks: lowercase + strip a
 * single leading `www.`. Other subdomain prefixes (editorial.usni.org,
 * www2.csis.org) are caught by the suffix-match branch in classifyStub.
 *
 * @param {string} sourceDomain
 * @returns {string}
 */
function stripWwwPrefix(sourceDomain) {
  return sourceDomain.startsWith('www.') ? sourceDomain.slice(4) : sourceDomain;
}
const REGULATORY_HEADLINE_REGEX = /LICENSE NO\.|Final Rule|Notice of/;
// Single-corporate earnings: deliberately restrictive — matches the
// editorial-slot pattern (verb + forecast/estimate/profit). Avoids
// false positives like "company beat its own internal goal" via the
// noun-anchor.
const SINGLE_CORP_HEADLINE_REGEX = /\b(beat|miss|tops|exceeds)\s+(forecast|estimate|profit)/i;

// ── Stub classifier ──────────────────────────────────────────────────

/**
 * Stub type classifier (Sprint 1).
 *
 * Returns `{ type, classificationMissing }`. `classificationMissing` is
 * only true when no rule matched and the caller is forced to the
 * conservative 'high-event' fallback. Telemetry surface for U6 replay.
 *
 * @param {object} args
 * @param {string} [args.sourceDomain] — host of the canonical source URL
 * @param {string} [args.headline]
 * @param {string} [args.severity]
 * @returns {{ type: CooldownType, classificationMissing: boolean }}
 */
export function classifyStub(args = {}) {
  const sourceDomain = typeof args.sourceDomain === 'string' ? args.sourceDomain.toLowerCase() : '';
  const headline = typeof args.headline === 'string' ? args.headline : '';
  const severity = typeof args.severity === 'string' ? args.severity.toLowerCase() : '';

  // Rule 1 — Analysis domains (highest priority; a `.edu` domain
  // publishing a "beat forecast" headline is still an analysis essay,
  // not a corporate earnings update).
  //
  // Codex PR #3617 P2 — match three host shapes:
  //   1. exact: `usni.org` → analysis
  //   2. www-prefixed: `www.usni.org` → strip + exact match → analysis
  //   3. subdomain: `editorial.usni.org`, `media.nature.com` → analysis
  // The suffix match is `.${domain}` so `notmyusni.org` stays a miss.
  if (sourceDomain) {
    const stripped = stripWwwPrefix(sourceDomain);
    const matchesAnalysisDomain = ANALYSIS_DOMAINS.some((d) => stripped === d || sourceDomain.endsWith(`.${d}`));
    const matchesAnalysisSuffix = ANALYSIS_DOMAIN_SUFFIXES.some((suffix) => sourceDomain.endsWith(suffix));
    if (matchesAnalysisDomain || matchesAnalysisSuffix) {
      return { type: 'analysis', classificationMissing: false };
    }
  }

  // Rule 2 — Government regulatory event (must be `.gov` AND headline
  // looks like a regulatory notice).
  if (sourceDomain && GOV_DOMAIN_SUFFIXES.some((suffix) => sourceDomain.endsWith(suffix))
      && REGULATORY_HEADLINE_REGEX.test(headline)) {
    return { type: 'sanctions-regulatory', classificationMissing: false };
  }

  // Rule 3 — Single-corporate earnings (regardless of domain — earnings
  // headlines run on Reuters/Bloomberg/etc., not just IR pages).
  if (SINGLE_CORP_HEADLINE_REGEX.test(headline)) {
    return { type: 'high-single-corporate', classificationMissing: false };
  }

  // Rule 4 — Severity-derived fallback, tier-by-tier. We don't have a
  // "developing vs sustained" signal in the BriefStory schema, so every
  // critical airing is treated as 'critical-developing' (the more
  // permissive 4h floor). Sprint 3's classifier will split this on a
  // per-cluster repeat-airing count.
  if (severity === 'critical') {
    return { type: 'critical-developing', classificationMissing: false };
  }
  if (severity === 'high') {
    return { type: 'high-event', classificationMissing: false };
  }
  if (severity === 'medium') {
    return { type: 'med', classificationMissing: false };
  }

  // Rule 5 — fall back to the conservative 'high-event' default and
  // surface the gap so U6 replay catches it. We pick 'high-event' (not
  // 'med') because mis-suppressing a high-severity item is worse than
  // mis-suppressing a medium one.
  return { type: 'high-event', classificationMissing: true };
}

// ── Decision function ────────────────────────────────────────────────

/**
 * Pure decision: returns `null` if cooldown is disabled (mode === 'off')
 * — the caller treats `null` as "no decision artifact, send through".
 * Otherwise returns a `{decision, reason, ...}` object.
 *
 * Returning `null` (not an "allow with reason=cooldown_disabled" object)
 * is the load-bearing contract per
 * `feedback_gate_on_ground_truth_not_configured_state`: downstream
 * observers gate on `cooldownDecision !== null`, NOT on the configured
 * env. This way a future "shadow per-user" subset can short-circuit by
 * returning null for users not in the subset, and the parity log line
 * naturally omits the `cooldown_decision` field for them.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.slot
 * @param {string} input.clusterId
 * @param {string} input.channel
 * @param {string} input.ruleId
 * @param {CooldownType | null} [input.type] — pre-classified, OR null to
 *   invoke the stub classifier on `classifierInputs`.
 * @param {string} input.severity — current-airing severity
 *   ('critical' | 'high' | 'medium' | 'low')
 * @param {number} input.currentSourceCount
 * @param {string} input.currentTier — same vocabulary as severity; for
 *   most callers `currentTier === severity`. Decoupled in case future
 *   classifiers want to express "severity downgraded but type
 *   unchanged".
 * @param {number | null | undefined} input.lastDeliveredAt — epoch ms
 * @param {number | null | undefined} input.lastDeliveredSourceCount
 * @param {string | null | undefined} input.lastDeliveredTier
 * @param {string | null | undefined} input.lastDeliveredHeadline
 *   Greptile PR #3617 P2 — last-delivered headline (read from the U4
 *   row's optional `headline` field). When present, drives the
 *   EVOLUTION_NEW_FACT bypass via string-equality compare against the
 *   current-airing headline. Sprint 1 stub; Sprint 3's full classifier
 *   replaces with LLM-driven fact-diff.
 * @param {{ sourceDomain?: string, headline?: string }} [input.classifierInputs]
 * @param {{ mode?: 'shadow' | 'off', nowMs?: number }} [input.options]
 * @returns {(null | {
 *   decision: 'allow' | 'suppress',
 *   reason: string,
 *   cooldownHours: number,
 *   evolutionDelta: { sourceCountDelta: number, tierChanged: boolean,
 *                     hoursSinceLastDelivery: number | null },
 *   classifiedType: CooldownType,
 *   classificationMissing: boolean,
 * })}
 */
export function evaluateCooldown(input) {
  const opts = input?.options ?? {};
  const mode = opts.mode ?? 'shadow';
  // `mode === 'off'` is the explicit "do not produce an artifact" path.
  // The downstream observer reads `cooldownDecision === null` as
  // "cooldown was not consulted for this candidate" — see header.
  if (mode === 'off') return null;

  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  // Resolve classification: caller-supplied beats stub.
  let classifiedType;
  let classificationMissing = false;
  if (input?.type && COOLDOWN_TABLE[input.type]) {
    classifiedType = input.type;
  } else {
    const stub = classifyStub({
      sourceDomain: input?.classifierInputs?.sourceDomain,
      headline: input?.classifierInputs?.headline,
      severity: input?.severity,
    });
    classifiedType = stub.type;
    classificationMissing = stub.classificationMissing;
  }

  const cell = COOLDOWN_TABLE[classifiedType];
  // Defensive: if a future caller passes an invalid pre-classified type
  // we fall back to the same default the stub uses (high-event), so the
  // decision pipeline never throws mid-cron. Telemetry flag fires.
  const tableEntry = cell ?? COOLDOWN_TABLE['high-event'];
  if (!cell) classificationMissing = true;

  const cooldownHours = tableEntry.hours;
  const lastDeliveredAt = Number.isFinite(input?.lastDeliveredAt) ? input.lastDeliveredAt : null;

  // No prior delivery → always allow. This is the "first-send" path —
  // the U4 writer hasn't recorded a row for this (channel, rule,
  // cluster) tuple yet.
  if (lastDeliveredAt === null) {
    return {
      decision: 'allow',
      reason: classificationMissing
        ? REASON.CLASSIFICATION_MISSING_DEFAULT_HIGH
        : REASON.NO_PRIOR_DELIVERY,
      cooldownHours,
      evolutionDelta: {
        sourceCountDelta: 0,
        tierChanged: false,
        hoursSinceLastDelivery: null,
      },
      classifiedType,
      classificationMissing,
    };
  }

  const elapsedMs = nowMs - lastDeliveredAt;
  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  const floorMs = cooldownHours * 60 * 60 * 1000;
  const withinFloor = elapsedMs < floorMs;

  const lastSourceCount = Number.isFinite(input?.lastDeliveredSourceCount)
    ? input.lastDeliveredSourceCount
    : 0;
  const currentSourceCount = Number.isFinite(input?.currentSourceCount)
    ? input.currentSourceCount
    : 0;
  const sourceCountDelta = currentSourceCount - lastSourceCount;

  const lastTierRank = SEVERITY_RANK[String(input?.lastDeliveredTier ?? '').toLowerCase()] ?? 0;
  const currentTierRank = SEVERITY_RANK[String(input?.currentTier ?? '').toLowerCase()] ?? 0;
  const tierChanged = lastTierRank !== currentTierRank && lastTierRank > 0 && currentTierRank > 0;

  const evolutionDelta = {
    sourceCountDelta,
    tierChanged,
    hoursSinceLastDelivery: Number(elapsedHours.toFixed(3)),
  };

  // Beyond the floor → always allow. Cooldown is satisfied.
  if (!withinFloor) {
    return {
      decision: 'allow',
      reason: REASON.COOLDOWN_FLOOR,
      cooldownHours,
      evolutionDelta,
      classifiedType,
      classificationMissing,
    };
  }

  // Within the floor — check evolution bypasses (if the type permits).
  // Order of precedence: tier change → source count → suppress.
  // Tier-change has highest precedence because it's the strongest
  // editorial signal: a critical-→-high de-escalation deserves a fresh
  // edition even if no new sources came in. Single-corp's
  // allowTierChange is on (real follow-up event = tier escalation),
  // analysis's is off (the 7d hard floor really is the contract).
  //
  // Codex PR #3617 P2 — `tierChangeMode: 'escalation-only'` opts a
  // class out of the de-escalation bypass. high-single-corporate uses
  // it: a HIGH→MEDIUM earnings repeat inside 48h is editorial noise
  // (the original release was already shipped; the downgrade isn't a
  // new event), not a "real follow-up". Other classes still honour
  // the symmetric tier-change rule (a critical→high de-escalation IS
  // editorial signal: "the situation cooled" is news).
  const tierChangeMode = tableEntry.tierChangeMode ?? 'any';
  const tierChangeAllowed = tableEntry.allowTierChange && tierChanged && (
    tierChangeMode === 'any' || (tierChangeMode === 'escalation-only' && currentTierRank > lastTierRank)
  );
  if (tierChangeAllowed) {
    return {
      decision: 'allow',
      reason: REASON.SEVERITY_TIER_CHANGE,
      cooldownHours,
      evolutionDelta,
      classifiedType,
      classificationMissing,
    };
  }

  // Greptile PR #3617 P2 — EVOLUTION_NEW_FACT bypass.
  //
  // The reason constant + per-class allowNewFact flag have been part
  // of the wire contract since U5 shipped, but no code path produced
  // the reason — exporting an unused contract surface is worse than
  // not exporting it (downstream consumers couldn't rely on the
  // reason ever firing). Sprint 1 stub: detect via string-equality
  // compare on the canonical headline. The U4 writer now persists
  // `headline` alongside {sentAt, sourceCount, severity} so the
  // evaluator can read the prior airing's headline.
  //
  // Why string-equality (not LLM-diff): Sprint 3's full classifier
  // ships an LLM-driven fact-diff that replaces this. For Sprint 1
  // string-equality is the conservative stub — it only fires the
  // bypass when the upstream feed produced a genuinely different
  // headline (rephrased news, not just a wire-rewording duplicate).
  // False negatives (rewordings that should fire) keep the
  // suppression conservative — preferable to false positives
  // (typo-edits firing the bypass and over-shipping).
  //
  // Compare semantic: case-insensitive, whitespace-trimmed equality.
  // Both sides must be non-empty for the bypass to fire — when
  // lastDeliveredHeadline is null (older v4 row without the field, or
  // first send) we skip cleanly, leaving the source-count bypass and
  // the suppress branch as the only paths.
  if (tableEntry.allowNewFact && typeof input?.lastDeliveredHeadline === 'string'
    && input.lastDeliveredHeadline.length > 0
    && typeof input?.classifierInputs?.headline === 'string'
    && input.classifierInputs.headline.length > 0) {
    const currentHeadlineNorm = input.classifierInputs.headline.trim().toLowerCase();
    const lastHeadlineNorm = input.lastDeliveredHeadline.trim().toLowerCase();
    if (currentHeadlineNorm !== lastHeadlineNorm) {
      return {
        decision: 'allow',
        reason: REASON.EVOLUTION_NEW_FACT,
        cooldownHours,
        evolutionDelta,
        classifiedType,
        classificationMissing,
      };
    }
  }

  if (tableEntry.allowSourceCountEvolution && sourceCountDelta >= SOURCE_COUNT_EVOLUTION_DELTA) {
    return {
      decision: 'allow',
      reason: REASON.EVOLUTION_SOURCE_COUNT,
      cooldownHours,
      evolutionDelta,
      classifiedType,
      classificationMissing,
    };
  }

  // No bypass triggered — within-floor suppression. Return the
  // type-specific "hard" reason for the two hard-floor classes so the
  // shadow log is greppable per-class without a separate filter.
  let reason = REASON.COOLDOWN_FLOOR;
  if (classifiedType === 'analysis') reason = REASON.ANALYSIS_7D_HARD;
  if (classifiedType === 'high-single-corporate') reason = REASON.SINGLE_CORP_48H_HARD;

  return {
    decision: 'suppress',
    reason,
    cooldownHours,
    evolutionDelta,
    classifiedType,
    classificationMissing,
  };
}

// Re-export the table for tests that want to assert specific cells
// without re-encoding the contract. Keep the export read-only to
// prevent a test from mutating it and corrupting other tests.
export const __COOLDOWN_TABLE = COOLDOWN_TABLE;
export const __SOURCE_COUNT_EVOLUTION_DELTA = SOURCE_COUNT_EVOLUTION_DELTA;
