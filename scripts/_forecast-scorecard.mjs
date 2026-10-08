// Pure scorecard math for forecast resolutions (#5007 Bet 2).
//
// Input is the Redis working ledger (object or array). Output is a compact,
// JSON-serializable scorecard. No wall-clock reads: nowMs is injected.

export const DEFAULT_ROLLING_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPSILON = 1e-6;

// Reports published up to 18h after a judged deadline are admissible, and an
// entry is not judged before they can exist (#8990). Of the 23 post-deadline
// citations in the scored judged rows, 11 were 2-14h late; the next was 30h
// late and reported a later development.
export const JUDGED_EVIDENCE_GRACE_MS = 18 * 60 * 60 * 1000;

// Service level for the judged lane (#7068): how long after it becomes
// judgeable (deadline plus the reporting grace) a judged entry may take to
// reach a terminal state and still count as on time. The clock starts at the
// first instant the lane may judge, so the grace never eats the retry room:
// two days is two daily runs, a first attempt and one retry, at any deadline.
export const DEFAULT_JUDGED_SLA_MS = 2 * DAY_MS;

// The VOID-share KPI counts only windows opened from the start of the day the
// owner re-based it (#4930, 2026-10-08). Every #8990 audit fix (#8995, #8999,
// #9006) was in production by then, so these windows resolve only under the
// fixed pipeline. Earlier windows hold the voids the audit relabelled
// (resolver_envelope_bug, judged_old_selection, resolver_could_not_read_feed),
// which describe the old pipeline's faults and would hold the share above
// target until they leave the rolling window.
export const GO_FORWARD_SINCE = '2026-10-08';
export const GO_FORWARD_SINCE_MS = Date.parse(`${GO_FORWARD_SINCE}T00:00:00Z`);
export const GO_FORWARD_VOID_SHARE_TARGET = 0.15;
// Below this many resolved windows the share is stated but not compared with
// the target. It matches the 30-family skill gate and the 30-hit market-alert
// floor; at 30, 5 voids (16.7%) still carry a Wilson interval of 7.3% to 33.6%.
export const GO_FORWARD_MIN_RESOLVED = 30;

// Origins whose scored entries are held OUT of the headline skill Brier:
// `state_derived` = synthetic count-padding backfill (not a real prediction);
// `bet_engine`    = shadow bets scored for evidence but not yet promoted;
// `unknown`       = rows written before origin tagging (#5240). They mix
//                   detector-shaped and state_derived-shaped titles, so they
//                   cannot be attributed to a generator.
// The all-origins `overall` block still counts them for continuity.
export const SYNTHETIC_GENERATION_ORIGINS = ['state_derived'];
export const SHADOW_GENERATION_ORIGINS = ['bet_engine'];
export const UNATTRIBUTED_GENERATION_ORIGINS = ['unknown'];
export const DEFAULT_SKILL_EXCLUDED_ORIGINS = Object.freeze([
  ...SYNTHETIC_GENERATION_ORIGINS,
  ...SHADOW_GENERATION_ORIGINS,
  ...UNATTRIBUTED_GENERATION_ORIGINS,
]);

export function generationOriginOf(entry) {
  return entry?.generationOrigin || 'unknown';
}

// The published-origin population: the headline skill set with bet_engine
// held out regardless of the promotion flag. Calibration fits and evaluates
// only this population (#7070).
// Shadow origins the promotion flag has moved into publication. Promotion
// (#5525 U14) is the only path; it moves bet_engine and nothing else.
function promotedShadowOrigins(options) {
  return options.promoteBetEngine === true ? ['bet_engine'] : [];
}

// An entry users were shown: shadow bets are scored for evidence but never
// published until promoted. Synthetic and unattributed rows were published.
function isPublishedEntry(entry, options) {
  const origin = generationOriginOf(entry);
  return !SHADOW_GENERATION_ORIGINS.includes(origin) || promotedShadowOrigins(options).includes(origin);
}

export function isPublishedOriginEntry(entry) {
  return !DEFAULT_SKILL_EXCLUDED_ORIGINS.includes(generationOriginOf(entry));
}

// State-derived market buckets withdrawn from publication until they have a
// checkable question (#5234). The rows stay in the ledger; no published figure
// counts them. Rows written before stateBucketId existed are matched on the
// title buildStateDerivedForecastTitle gave each bucket, including rows that
// predate origin tagging.
export const WITHHELD_STATE_BUCKETS = Object.freeze(['sovereign_risk', 'rates_inflation', 'fx_stress']);
const WITHHELD_STATE_DERIVED_TITLE = /^(Sovereign risk repricing|Inflation and rates pressure|FX stress) from /;

export function isWithheldEntry(entry) {
  if (typeof entry?.stateBucketId === 'string') return WITHHELD_STATE_BUCKETS.includes(entry.stateBucketId);
  return ['state_derived', 'unknown'].includes(generationOriginOf(entry))
    && entry?.domain === 'market'
    && WITHHELD_STATE_DERIVED_TITLE.test(entry?.title || '');
}

// A window the resolver reopened from an emission another window had already
// absorbed (#8990). It is VOID and kept for audit; it was never a question.
export function isDuplicateWindow(entry) {
  return typeof entry?.duplicateOf === 'string';
}

export function computeScorecard(ledger, nowMs, options = {}) {
  const rollingWindowDays = options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;
  const minResolvedAt = nowMs - rollingWindowDays * DAY_MS;
  const allEntries = normalizeLedger(ledger).filter((entry) => !isWithheldEntry(entry) && !isDuplicateWindow(entry));
  const inWindow = (entry) => {
    if (entry?.status !== 'resolved') return true;
    const resolvedAt = Number(entry.resolvedAt);
    return !Number.isFinite(resolvedAt) || resolvedAt >= minResolvedAt;
  };
  const entries = allEntries.filter((entry) => !isHorizonEntry(entry) && inWindow(entry));
  const horizonEntries = allEntries.filter((entry) => isHorizonEntry(entry) && inWindow(entry));

  const resolved = entries.filter((entry) => entry?.status === 'resolved');
  const scored = resolved.filter(isScoredEntry);
  const voided = resolved.filter((entry) => entry?.outcome === 'VOID');
  const pending = entries.filter((entry) => entry?.status === 'pending');
  const pendingJudge = entries.filter((entry) => entry?.status === 'pending-judge');

  const goForward = summarizeGoForward(entries, minResolvedAt, rollingWindowDays, options);

  const scorecard = {
    // 2: carries publishedByDomain (#5092).
    schemaVersion: 2,
    generatedAt: nowMs,
    rollingWindowDays,
    methodology: `Brier/log score over resolved YES/NO published forecast windows; VOID and pending entries are counted for coverage but excluded from accuracy math. Each window is one question, and it is scored on the probability published when the window opened; a later re-emission of the same question does not change it. While an outcome-fitted calibration gate passes, that probability is calibrated, and the API does not mark which ones are; after a switch between raw and calibrated publication, the rolling window mixes forecasts published under both.${envelopeBugNote(voided)}${nowMs >= GO_FORWARD_SINCE_MS ? goForwardNote(goForward) : ''}`,
    totals: {
      entries: entries.length,
      resolved: resolved.length,
      pending: pending.length,
      pendingJudge: pendingJudge.length,
      scored: scored.length,
      void: voided.length,
      voidRate: resolved.length ? round(voided.length / resolved.length) : 0,
      publicationCoverage: entries.length ? round(scored.length / entries.length) : 0,
    },
    judgedLane: summarizeJudgedLane(entries, resolved, pendingJudge, nowMs, options),
    goForward,
    specOrigins: summarizeSpecOrigins(entries, options),
    byDomain: summarizeGroups(scored, resolved, 'domain', 'domain'),
    byGenerationOrigin: summarizeGroups(scored, resolved, 'generationOrigin', 'generationOrigin'),
    calibration: calibrationBuckets(scored),
    funnel: summarizeFunnel(entries, nowMs),
    projections: summarizeProjectionHorizons(horizonEntries, nowMs),
  };

  const overall = summarizeScored(scored);
  if (overall) scorecard.overall = overall;
  // Promotion flag (#5525 U14): bet_engine stays OUT of the skill headline
  // until Gate 2 passes. Flipping `promoteBetEngine` (the resolutions seeder
  // wires it from FORECAST_PROMOTE_BET_ENGINE=1) is the ONLY promotion path —
  // it removes bet_engine from the exclusion set while state_derived stays
  // excluded.
  const promoted = promotedShadowOrigins(options);
  const defaultExcluded = DEFAULT_SKILL_EXCLUDED_ORIGINS.filter((origin) => !promoted.includes(origin));
  const excludeOrigins = new Set(options.skillExcludeOrigins ?? defaultExcluded);
  const skill = summarizeSkill(scored, excludeOrigins);
  if (skill) scorecard.skill = skill;
  scorecard.publishedByDomain = summarizePublishedByDomain(scored);
  scorecard.uncertainty = {
    method: `family-level percentile bootstrap (each resample draws whole forecast families), ${CALIBRATION_BOOTSTRAP_RESAMPLES} resamples, seed ${SCORECARD_BOOTSTRAP_SEED}`,
    overallBrier: brierInterval(scored, 'overall'),
    skillBrier: brierInterval(scored.filter((entry) => !excludeOrigins.has(generationOriginOf(entry))), 'skill'),
  };
  const marketSkill = summarizeMarketSkill(scored);
  if (marketSkill) scorecard.vsMarketSkill = marketSkill;

  // Per-origin Gate-2 measurement (#5525 U14): the pooled calibration and
  // vsMarketSkill above mix legacy + shadow origins, so Gate 2 reads these
  // bet_engine-scoped slices instead — calibration curve, market comparison,
  // ensemble-vs-base-rate baseline delta, and outcome-conditioned deviation
  // skill (KTD3: on bets where the ensemble deviates from the market, does the
  // deviation's direction predict outcomes better than the market alone?).
  const betEngineScored = scored.filter((entry) => generationOriginOf(entry) === 'bet_engine');
  if (betEngineScored.length) {
    const slice = {
      count: betEngineScored.length,
      calibration: calibrationBuckets(betEngineScored),
    };
    const sliceOverall = summarizeScored(betEngineScored);
    if (sliceOverall) {
      slice.brier = sliceOverall.brier;
      slice.logScore = sliceOverall.logScore;
    }
    // The skill comparisons measure the ensemble, so they read only windows
    // that opened on an ensemble probability. A window that opened on the
    // base-rate placeholder is still scored above, but it would compare the
    // base rate with itself (#8990).
    const ensembleScored = betEngineScored.filter(isEnsembleScored);
    slice.ensembleCount = ensembleScored.length;
    const sliceMarket = summarizeMarketSkill(ensembleScored);
    if (sliceMarket) slice.vsMarketSkill = sliceMarket;
    const baseline = summarizeBaselineSkill(ensembleScored);
    if (baseline) slice.vsBaseRate = baseline;
    const deviation = summarizeDeviationSkill(ensembleScored);
    if (deviation) slice.deviationSkill = deviation;
    scorecard.betEngine = slice;
  }
  return scorecard;
}

function isEnsembleScored(entry) {
  return typeof entry?.probabilitySource === 'string' && entry.probabilitySource.startsWith('ensemble');
}

// Ensemble-vs-recorded-base-rate Brier comparison (#5525 KTD5). Only entries
// carrying baselineProbability participate; absent fields exclude the entry
// (never NaN).
function summarizeBaselineSkill(scored) {
  const anchored = scored
    .map((entry) => {
      const baseline = clampProbability(Number(entry?.baselineProbability));
      return Number.isFinite(baseline) ? { entry, baseline } : null;
    })
    .filter(Boolean);
  if (!anchored.length) return null;
  const forecastBrier = mean(anchored.map(({ entry }) => brier(entry)));
  const baselineBrier = mean(anchored.map(({ entry, baseline }) => brier(entry, baseline)));
  return {
    count: anchored.length,
    forecastBrier: round(forecastBrier),
    baselineBrier: round(baselineBrier),
    brierDelta: round(baselineBrier - forecastBrier),
  };
}

// Outcome-conditioned deviation skill (#5525 KTD3): restricted to entries where
// the graded probability deviates from the market price by more than the band,
// correlate the deviation's SIGN with the outcome-minus-market residual. A
// market-copying forecaster (deviation = noise) scores ~0; genuinely derived
// deviation scores > 0. Positive skill is a hard Gate-2 criterion.
const DEVIATION_BAND = 0.05;
function summarizeDeviationSkill(scored) {
  const deviating = scored
    .map((entry) => {
      const market = marketProbability(entry);
      if (!Number.isFinite(market)) return null;
      const p = probability(entry);
      const deviation = p - market;
      if (Math.abs(deviation) <= DEVIATION_BAND) return null;
      const residual = outcomeNumber(entry) - market;
      return { sign: Math.sign(deviation), residual };
    })
    .filter(Boolean);
  if (!deviating.length) return null;
  // Mean of sign(deviation) * residual: positive when deviations point toward
  // realized outcomes, ~0 for noise, negative when they point away.
  const skill = mean(deviating.map(({ sign, residual }) => sign * residual));
  return { count: deviating.length, skill: round(skill) };
}

function normalizeLedger(ledger) {
  if (!ledger) return [];
  if (Array.isArray(ledger)) return ledger.filter(Boolean);
  if (Array.isArray(ledger.entries)) return ledger.entries.filter(Boolean);
  if (ledger.data) return normalizeLedger(ledger.data);
  if (typeof ledger === 'object') return Object.values(ledger).filter(Boolean);
  return [];
}

export function isScoredEntry(entry) {
  return entry?.status === 'resolved'
    && (entry.outcome === 'YES' || entry.outcome === 'NO')
    && Number.isFinite(Number(entry.probability));
}

// Projection horizon windows (#7075) share the ledger with forecast windows
// under `<parentKey>@<horizon>` keys. Every forecast-window reader partitions
// on this so a projection never enters a forecast metric, fit, or cohort.
// The #5233 correction travels with the numbers it changed: a frozen capture
// taken before the resolver voided those rows carries no note.
function envelopeBugNote(voided) {
  const count = voided.filter((entry) => entry?.evidence?.reason === 'resolver_envelope_bug').length;
  if (!count) return '';
  return count === 1
    ? ' 1 forecast scored against a data feed we could not read correctly is voided and left out of every score (issue #5233).'
    : ` ${count} forecasts scored against a data feed we could not read correctly are voided and left out of every score (issue #5233).`;
}

// A window opens when it is first seen in a published snapshot; generatedAt
// stands in for rows that lack the sighting time.
function windowOpenedAt(entry) {
  const firstSeenAt = Number(entry?.firstSeenAt);
  if (Number.isFinite(firstSeenAt) && firstSeenAt > 0) return firstSeenAt;
  const generatedAt = Number(entry?.generatedAt);
  return Number.isFinite(generatedAt) && generatedAt > 0 ? generatedAt : NaN;
}

// The go-forward VOID-share KPI (#4930), over published forecasts only. It
// starts from the `totals` population, so a row withheld, duplicated or outside
// the rolling window counts in neither, and then drops unpromoted shadow bets,
// which are never published and settle on market data that does not void.
// Once GO_FORWARD_SINCE is older than the window, rows resolved before the
// window start drop out and `windowTruncated` says so.
function summarizeGoForward(entries, minResolvedAt, rollingWindowDays, options) {
  const cohort = entries.filter((entry) => isPublishedEntry(entry, options) && windowOpenedAt(entry) >= GO_FORWARD_SINCE_MS);
  const resolved = cohort.filter((entry) => entry?.status === 'resolved');
  const voided = resolved.filter((entry) => entry?.outcome === 'VOID');
  const voidByReason = {};
  for (const entry of voided) {
    const reason = entry?.evidence?.reason || 'unknown';
    voidByReason[reason] = (voidByReason[reason] || 0) + 1;
  }
  return {
    since: GO_FORWARD_SINCE,
    target: GO_FORWARD_VOID_SHARE_TARGET,
    minResolved: GO_FORWARD_MIN_RESOLVED,
    windowTruncated: minResolvedAt > GO_FORWARD_SINCE_MS,
    rollingWindowDays,
    entries: cohort.length,
    resolved: resolved.length,
    void: voided.length,
    voidShare: resolved.length ? round(voided.length / resolved.length) : null,
    voidShareCi95: wilsonInterval(voided.length, resolved.length),
    voidByReason,
  };
}

const LONG_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const COUNT = new Intl.NumberFormat('en-US');
const percent = (value) => `${(value * 100).toFixed(1)}%`;

// Published in the methodology, which /accuracy/ prints under the ledger
// totals. The public OpenAPI document has no room for a structured field, and
// the note travels with the capture it describes, like envelopeBugNote.
function goForwardNote(goForward) {
  const sinceDate = LONG_DATE.format(new Date(GO_FORWARD_SINCE_MS));
  const lead = goForward.windowTruncated ? `In the last ${goForward.rollingWindowDays} days` : `Since ${sinceDate}`;
  const target = `under ${percent(goForward.target).replace('.0%', '%')}`;
  const scope = ` This counts published forecasts first issued on or after ${goForward.windowTruncated ? sinceDate : 'that date'}, so it leaves out unpublished shadow bets and the voids relabelled in the issue #8990 audit.`;
  if (!goForward.resolved) {
    return ` ${lead}, no published forecast has resolved${goForward.windowTruncated ? '' : ' yet'}, so there is no void share to compare with the target of ${target}.${scope}`;
  }
  const [low, high] = goForward.voidShareCi95;
  const noun = goForward.resolved === 1 ? 'resolved published forecast' : 'resolved published forecasts';
  const verb = goForward.void === 1 || goForward.resolved === 1 ? 'was' : 'were';
  const share = `${lead}, ${COUNT.format(goForward.void)} of ${COUNT.format(goForward.resolved)} ${noun} ${verb} void (${percent(goForward.voidShare)}, 95% interval ${percent(low)} to ${percent(high)})`;
  if (goForward.resolved < goForward.minResolved) {
    return ` ${share}. That is too few to compare with the target of ${target}, which needs at least ${goForward.minResolved} resolved. Judged forecasts resolve days after hard ones and have voided more often, so early readings run low.${scope}`;
  }
  return ` ${share}; the target is ${target}.${scope}`;
}

export function isHorizonEntry(entry) {
  return typeof entry?.spec?.horizon === 'string';
}

function outcomeNumber(entry) {
  return entry.outcome === 'YES' ? 1 : 0;
}

function probability(entry) {
  return clampProbability(Number(entry.probability));
}

function clampProbability(value) {
  if (!Number.isFinite(value)) return NaN;
  return Math.max(0, Math.min(1, value));
}

function brier(entry, p = probability(entry)) {
  const y = outcomeNumber(entry);
  return (p - y) ** 2;
}

function logScore(entry, p = probability(entry)) {
  const y = outcomeNumber(entry);
  const bounded = Math.max(EPSILON, Math.min(1 - EPSILON, p));
  return -(y * Math.log(bounded) + (1 - y) * Math.log(1 - bounded));
}

function summarizeScored(entries) {
  if (!entries.length) return null;
  return {
    count: entries.length,
    brier: round(mean(entries.map((entry) => brier(entry)))),
    logScore: round(mean(entries.map((entry) => logScore(entry)))),
  };
}

// Per-domain accuracy over the published-origin population only, with each
// domain's yesCount so a reader can derive its base-rate Brier. byDomain pools
// every origin, so it cannot back a per-domain reliability claim (#5092).
// isPublishedOriginEntry excludes bet_engine even when promoteBetEngine
// (FORECAST_PROMOTE_BET_ENGINE, off in production) adds it to the headline
// skill cohort, so the card badges and /accuracy/ domain table stay on
// published forecasts until promotion is decided for them too (#8952).
function summarizePublishedByDomain(scored) {
  const byDomain = new Map();
  for (const entry of scored.filter(isPublishedOriginEntry)) {
    const domain = entry?.domain || 'unknown';
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(entry);
  }
  return [...byDomain.keys()].sort().map((domain) => {
    const entries = byDomain.get(domain);
    const { bss, bssCi95, ...sample } = summarizeBaseRateSkill(entries, `domain:${domain}`);
    return {
      domain,
      count: entries.length,
      brier: round(mean(entries.map((entry) => brier(entry)))),
      yesCount: entries.filter((entry) => entry.outcome === 'YES').length,
      ...sample,
      // A domain's skill is published only where it is measurable (#8990).
      ...(sample.measurable && { bss, bssCi95 }),
    };
  });
}

// Headline "real skill" summary: Brier/log score over scored entries whose
// generationOrigin is NOT in the exclude set. Present whenever anything is
// scored — a fully synthetic funnel surfaces as count 0 with excludedScored>0,
// which is the honest signal that the headline is unmeasurable.
function summarizeSkill(scored, excludeSet) {
  if (!scored.length) return null;
  const real = scored.filter((entry) => !excludeSet.has(generationOriginOf(entry)));
  const excludedEntries = scored.filter((entry) => excludeSet.has(generationOriginOf(entry)));
  const excludedOrigins = [...new Set(excludedEntries.map(generationOriginOf))].sort();
  const summary = summarizeScored(real);
  return pruneUndefined({
    ...(real.length ? summarizeBaseRateSkill(real, 'skill') : {}),
    count: real.length,
    // yesCount / count is the cohort's base rate, the null /accuracy/ compares
    // the headline Brier against (#8873). The pooled calibration buckets carry
    // the all-scored equivalent, but nothing else carries this cohort's.
    yesCount: real.filter((entry) => entry.outcome === 'YES').length,
    excludedScored: excludedEntries.length,
    // Always an array (proto `repeated string` is non-optional): a typed client
    // reads skill.excludedOrigins.length on the healthy path, where it is [].
    excludedOrigins,
    // Headline rows published after a blend toward a pre-#7071 anchor stay
    // scored on what was published; this count keeps them visible (#9010).
    // Internal: the public contract selects skill members by name.
    preLineageAnchorCount: real.filter(hasPreLineageAnchor).length,
    brier: summary?.brier,
    logScore: summary?.logScore,
  });
}

/**
 * Judged-lane health (#7068). Reports the acceptance metrics the judge lane is
 * measured on — first-attempt seal rate, scored-within-SLA rate, judged VOID by
 * reason, attempts per resolved entry — plus the attempt-class aggregate rolled
 * up from the per-attempt lifecycle records the seeder persists.
 *
 * Every rate here is built so that it cannot be improved by failing faster or
 * by having nothing to measure: `scoredWithinSlaRate` counts only scored
 * resolutions while keeping VOIDs in its denominator, `voidWithinSla` publishes
 * the compensating failure-state term beside it, and the attempt metrics name
 * their own denominator (`instrumentedResolved`) so 0 reads as "not yet
 * measurable" rather than as a perfect score.
 */
function summarizeJudgedLane(entries, resolved, pendingJudge, nowMs, options = {}) {
  const slaMs = Number.isFinite(options.judgedSlaMs) ? Math.max(0, options.judgedSlaMs) : DEFAULT_JUDGED_SLA_MS;
  const judgedResolved = resolved.filter(isJudgedEntry);
  const byClass = {};
  const byStage = {};
  let attemptRecords = 0;
  for (const entry of entries) {
    const log = Array.isArray(entry?.judgeAttemptLog) ? entry.judgeAttemptLog : [];
    for (const row of log) {
      attemptRecords += 1;
      if (row?.stage) byStage[row.stage] = (byStage[row.stage] || 0) + 1;
      // Per-judgment citation rejections ride alongside the attempt's own
      // class; counting only `class` would hide what actually drives the
      // agreement-stage VOIDs. Counted once per ATTEMPT, so two judgments
      // rejecting the same way do not read as two failures.
      const names = new Set([row?.class, ...(row?.normalizeClasses || [])].filter(Boolean));
      for (const name of names) byClass[name] = (byClass[name] || 0) + 1;
      if (row?.normalizeClasses?.length) byStage.normalize = (byStage.normalize || 0) + 1;
    }
  }

  const voidByReason = {};
  for (const entry of judgedResolved) {
    if (entry?.outcome !== 'VOID') continue;
    const reason = entry?.evidence?.reason || 'unknown';
    voidByReason[reason] = (voidByReason[reason] || 0) + 1;
  }

  // NO entries sealed before #8904 carry no basis; they count as `unrecorded`
  // rather than being folded into `event`.
  const noByBasis = {};
  for (const entry of judgedResolved) {
    if (entry?.outcome !== 'NO') continue;
    const basis = entry?.evidence?.basis || 'unrecorded';
    noByBasis[basis] = (noByBasis[basis] || 0) + 1;
  }

  // The acceptance metric is SCORED-within-SLA, not resolved-within-SLA: a lane
  // that seals everything as VOID on day one resolves 100% within SLA while
  // resolving nothing. VOIDs stay in the denominator so they depress the rate,
  // and `voidWithinSla` sits beside it so the compensating failure-state
  // increase the acceptance criteria warn about is visible rather than hidden.
  const withinSla = (entry) => {
    const deadline = entryDeadline(entry);
    const resolvedAt = Number(entry?.resolvedAt);
    if (!Number.isFinite(deadline) || !Number.isFinite(resolvedAt)) return false;
    return resolvedAt - (deadline + JUDGED_EVIDENCE_GRACE_MS) <= slaMs;
  };
  const scoredWithinSla = judgedResolved.filter((entry) => isScoredEntry(entry) && withinSla(entry)).length;
  const voidWithinSla = judgedResolved.filter((entry) => entry?.outcome === 'VOID' && withinSla(entry)).length;

  // Attempt metrics are derived only from entries carrying an attempt log.
  // Before this instrumentation `judgeAttempts` counted failed attempts only —
  // the sealing attempt was never recorded — so a legacy entry that failed once
  // and then sealed reads as a first-attempt seal. Mixing the two accounting
  // regimes inside one 180-day window would silently flatter both numbers.
  const instrumented = judgedResolved.filter((entry) => Array.isArray(entry?.judgeAttemptLog) && entry.judgeAttemptLog.length);
  const sealedFirstAttempt = instrumented.filter((entry) => attemptCount(entry) === 1).length;
  const totalAttempts = instrumented.reduce((sum, entry) => sum + attemptCount(entry), 0);

  const pendingPastDeadline = pendingJudge.filter((entry) => {
    const deadline = entryDeadline(entry);
    return Number.isFinite(deadline) && nowMs >= deadline + JUDGED_EVIDENCE_GRACE_MS;
  }).length;

  return {
    slaMs,
    pendingJudge: pendingJudge.length,
    pendingJudgePastDeadline: pendingPastDeadline,
    resolved: judgedResolved.length,
    scored: judgedResolved.filter(isScoredEntry).length,
    void: judgedResolved.filter((entry) => entry?.outcome === 'VOID').length,
    voidByReason,
    noByBasis,
    scoredWithinSla,
    voidWithinSla,
    scoredWithinSlaRate: judgedResolved.length ? round(scoredWithinSla / judgedResolved.length) : 0,
    // Denominator for the two attempt metrics below — 0 means they are not yet
    // measurable, not that the lane seals on the first attempt.
    instrumentedResolved: instrumented.length,
    firstAttemptSealRate: instrumented.length ? round(sealedFirstAttempt / instrumented.length) : 0,
    attemptsPerResolvedEntry: instrumented.length ? round(totalAttempts / instrumented.length) : 0,
    attemptRecords,
    attemptClasses: byClass,
    attemptStages: byStage,
  };
}

// Retired by #5334 before #7067 was filed: the gate cannot change its VOIDs,
// so it stays out of the go-forward comparison.
export const INFRASTRUCTURE_BASELINE_FEED = 'infra:outages:v1';
const FEED_NAMESPACE_FAMILY = { intelligence: 'gps', prediction: 'prediction_market', infra: 'infrastructure' };

// A row's hard family, from the feed its spec read, or for a downgraded row
// the feed it would have read; so a downgraded row and a hard row of the same
// family share a key. Native judged rows are keyed by domain.
export function specFamilyOf(entry) {
  const spec = entry?.spec || {};
  const feed = spec.originalSourceFeed || spec.sourceFeed;
  if (typeof feed === 'string' && feed.length > 0) {
    const namespace = feed.split(':')[0];
    return FEED_NAMESPACE_FAMILY[namespace] || namespace;
  }
  return spec.kind === 'judged' ? `judged:${entry?.domain || 'unknown'}` : 'unknown';
}

/**
 * Follow-through for the extraction gate (#7067): outcomes per spec origin and
 * family. Rows emitted before the gate enforces carry no specOrigin and file
 * as `legacy`. Every row is held to the judged-lane bar (resolved by deadline
 * plus the reporting grace plus the SLA), so a downgraded row and the hard
 * path of its family are compared on one clock; a downgrade succeeds only if
 * it raises scored-within-SLA yield. Internal: not on the public endpoint.
 */
function summarizeSpecOrigins(entries, options = {}) {
  const slaMs = Number.isFinite(options.judgedSlaMs) ? Math.max(0, options.judgedSlaMs) : DEFAULT_JUDGED_SLA_MS;
  const byOrigin = {};
  const latencies = new Map();
  let excludedInfrastructureBaseline = 0;
  for (const entry of entries) {
    if (entry?.spec?.sourceFeed === INFRASTRUCTURE_BASELINE_FEED) {
      excludedInfrastructureBaseline += 1;
      continue;
    }
    const origin = typeof entry?.specOrigin === 'string' ? entry.specOrigin : 'legacy';
    const family = specFamilyOf(entry);
    const row = ((byOrigin[origin] ??= {})[family] ??= {
      entries: 0, resolved: 0, scored: 0, void: 0, pending: 0, pendingJudge: 0, scoredWithinSla: 0,
    });
    row.entries += 1;
    if (entry?.status === 'pending') row.pending += 1;
    if (entry?.status === 'pending-judge') row.pendingJudge += 1;
    if (entry?.status !== 'resolved') continue;
    row.resolved += 1;
    if (entry?.outcome === 'VOID') row.void += 1;
    const deadline = entryDeadline(entry);
    const resolvedAt = Number(entry?.resolvedAt);
    const timed = Number.isFinite(deadline) && Number.isFinite(resolvedAt);
    if (isScoredEntry(entry)) {
      row.scored += 1;
      if (timed && resolvedAt - (deadline + JUDGED_EVIDENCE_GRACE_MS) <= slaMs) row.scoredWithinSla += 1;
    }
    if (timed) {
      if (!latencies.has(row)) latencies.set(row, []);
      latencies.get(row).push(Math.max(0, resolvedAt - deadline));
    }
  }
  for (const families of Object.values(byOrigin)) {
    for (const row of Object.values(families)) {
      row.scoredWithinSlaRate = row.resolved ? round(row.scoredWithinSla / row.resolved) : null;
      const values = (latencies.get(row) || []).sort((a, b) => a - b);
      row.medianLatencyHours = values.length ? round(medianOfSorted(values) / (60 * 60 * 1000)) : null;
    }
  }
  return { slaMs, excludedInfrastructureBaseline, byOrigin };
}

function medianOfSorted(values) {
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function isJudgedEntry(entry) {
  const kind = entry?.spec?.kind ?? entry?.resolution?.kind;
  return kind === 'judged' || entry?.evidence?.kind === 'judged';
}

function attemptCount(entry) {
  const attempts = Number(entry?.judgeAttempts);
  if (Number.isFinite(attempts) && attempts > 0) return Math.floor(attempts);
  // Only reached for an instrumented entry, which always logged the attempt
  // that sealed it.
  return entry.judgeAttemptLog.length;
}

// `totals.publicationCoverage` divides scored by every ledger entry, immature
// ones included. These denominators count only windows that are due: past
// their deadline, or already resolved (an early resolution is decided, so it
// cannot sit in a numerator above its own denominator). An unresolved entry
// with no deadline is counted apart rather than guessed into either side.
// A null deadline is unknown, not epoch 0: Number(null) would read as long past.
function entryDeadline(entry) {
  const raw = entry?.deadline ?? entry?.spec?.deadline;
  return raw == null ? NaN : Number(raw);
}

function summarizeFunnel(entries, nowMs) {
  let matured = 0;
  let immature = 0;
  let maturityUnknown = 0;
  let pendingHardMatured = 0;
  let pendingJudgeMatured = 0;
  let resolved = 0;
  let scored = 0;
  for (const entry of entries) {
    if (entry?.status === 'resolved') {
      matured += 1;
      resolved += 1;
      if (isScoredEntry(entry)) scored += 1;
      continue;
    }
    const deadline = entryDeadline(entry);
    if (!Number.isFinite(deadline)) {
      maturityUnknown += 1;
    } else if (deadline > nowMs) {
      immature += 1;
    } else {
      matured += 1;
      if (entry?.status === 'pending') pendingHardMatured += 1;
      if (entry?.status === 'pending-judge') pendingJudgeMatured += 1;
    }
  }
  return {
    matured,
    immature,
    maturityUnknown,
    resolved,
    scored,
    pendingHardMatured,
    pendingJudgeMatured,
    resolvedOfMatured: proportion(resolved, matured),
    scoredOfMatured: proportion(scored, matured),
  };
}

function proportion(successes, count) {
  if (!count) return null;
  return { count, successes, rate: round(successes / count), ci95: wilsonInterval(successes, count) };
}

function brierInterval(entries, scope) {
  if (!entries.length) return null;
  const families = familyTotals(entries);
  return {
    count: entries.length,
    mean: round(mean(entries.map((entry) => brier(entry)))),
    ci95: familyBootstrap(families, (sum) => sum.brier / sum.rows, scope),
    // The one flag the public contract has room for (#8990): /accuracy/ and
    // the card strip read it as the headline's measurable gate.
    insufficientSample: !meetsFamilyMinimums(families),
  };
}

function meetsFamilyMinimums(families) {
  return families.length >= SKILL_MIN_FAMILIES
    && families.filter((family) => family.yes > 0).length >= SKILL_MIN_OUTCOME_FAMILIES
    && families.filter((family) => family.yes < family.rows).length >= SKILL_MIN_OUTCOME_FAMILIES;
}

// A family is one forecast id (#8990): its windows ask the same question of
// the same detector, so they are resampled together and counted once. The
// scorecard's intervals and minimums, the calibration fit and the activation
// gate (#9034) all use this.
export function familyKey(entry) {
  return typeof entry?.id === 'string' && entry.id ? entry.id : '';
}

function familyTotals(entries) {
  const byFamily = new Map();
  for (const entry of entries) {
    const key = familyKey(entry);
    const total = byFamily.get(key) ?? { rows: 0, yes: 0, brier: 0 };
    total.rows += 1;
    total.yes += outcomeNumber(entry);
    total.brier += brier(entry);
    byFamily.set(key, total);
  }
  return [...byFamily.values()];
}

// One cluster-bootstrap resample: as many families as the cohort holds, drawn
// with replacement.
function drawFamilies(families, random) {
  const drawn = new Array(families.length);
  for (let i = 0; i < families.length; i += 1) drawn[i] = families[Math.floor(random() * families.length)];
  return drawn;
}

// Percentile bootstrap over whole families: each resample draws families with
// replacement and pools their rows. A statistic that is undefined on a draw
// (a resample whose outcomes all went one way has no base rate to beat) is
// skipped; past 5% skipped the interval itself is not published.
function familyBootstrap(families, statistic, scope) {
  const random = mulberry32(seedFor(scope, SCORECARD_BOOTSTRAP_SEED));
  const draws = [];
  for (let r = 0; r < CALIBRATION_BOOTSTRAP_RESAMPLES; r += 1) {
    const sum = { rows: 0, yes: 0, brier: 0 };
    for (const family of drawFamilies(families, random)) {
      sum.rows += family.rows;
      sum.yes += family.yes;
      sum.brier += family.brier;
    }
    const value = statistic(sum);
    if (Number.isFinite(value)) draws.push(value);
  }
  if (draws.length < 0.95 * CALIBRATION_BOOTSTRAP_RESAMPLES) return null;
  draws.sort((a, b) => a - b);
  return [round(percentile(draws, 0.025)), round(percentile(draws, 0.975))];
}

// Brier skill score against the cohort's own base rate, BSS = 1 - B / p(1-p),
// with p the YES share of the same rows. 0 is no better than always
// forecasting that rate, 1 is perfect, below 0 is worse. Undefined (null)
// when every outcome went one way, because then the rate is never wrong.
function skillScore({ rows, yes, brier: brierSum }) {
  const rate = yes / rows;
  const reference = rate * (1 - rate);
  return reference > 0 ? 1 - brierSum / rows / reference : NaN;
}

/**
 * The skill block of one cohort (#8990): rows, families and Kish's effective
 * n side by side, the reference Brier of always forecasting the cohort's base
 * rate, the skill score against it with a family-bootstrap interval, and
 * whether the cohort meets the family minimums for a verdict.
 */
function summarizeBaseRateSkill(entries, scope) {
  const families = familyTotals(entries);
  const total = families.reduce((sum, family) => ({
    rows: sum.rows + family.rows, yes: sum.yes + family.yes, brier: sum.brier + family.brier,
  }), { rows: 0, yes: 0, brier: 0 });
  const rate = total.yes / total.rows;
  const yesFamilies = families.filter((family) => family.yes > 0).length;
  const noFamilies = families.filter((family) => family.yes < family.rows).length;
  const bss = skillScore(total);
  return {
    families: families.length,
    // Kish: (sum of family sizes)^2 / sum of squared sizes.
    nEff: round(total.rows ** 2 / families.reduce((sum, family) => sum + family.rows ** 2, 0)),
    yesFamilies,
    noFamilies,
    referenceBrier: round(rate * (1 - rate)),
    bss: Number.isFinite(bss) ? round(bss) : null,
    // Omitted, not null, when it cannot be computed: the contract field is a repeated double.
    bssCi95: (Number.isFinite(bss) ? familyBootstrap(families, skillScore, `bss:${scope}`) : null) ?? undefined,
    measurable: meetsFamilyMinimums(families),
  };
}

function summarizeGroups(scored, resolved, key, label) {
  const keys = new Set([
    ...scored.map((entry) => entry?.[key] || 'unknown'),
    ...resolved.map((entry) => entry?.[key] || 'unknown'),
  ]);
  return [...keys].sort().map((value) => {
    const groupScored = scored.filter((entry) => (entry?.[key] || 'unknown') === value);
    const groupResolved = resolved.filter((entry) => (entry?.[key] || 'unknown') === value);
    const groupVoid = groupResolved.filter((entry) => entry?.outcome === 'VOID');
    const summary = summarizeScored(groupScored) || { count: 0 };
    return pruneUndefined({
      [label]: value,
      resolved: groupResolved.length,
      scored: groupScored.length,
      void: groupVoid.length,
      voidRate: groupResolved.length ? round(groupVoid.length / groupResolved.length) : 0,
      brier: summary.brier,
      logScore: summary.logScore,
    });
  });
}

function calibrationBuckets(scored) {
  const buckets = Array.from({ length: 10 }, (_, index) => ({
    bucket: `${index * 10}-${(index + 1) * 10}`,
    minProbability: round(index / 10),
    maxProbability: round((index + 1) / 10),
    rows: [],
  }));
  for (const entry of scored) {
    const p = probability(entry);
    const index = Math.min(9, Math.max(0, Math.floor(p * 10)));
    buckets[index].rows.push(entry);
  }
  return buckets.map((bucket) => {
    const rows = bucket.rows;
    const result = {
      bucket: bucket.bucket,
      minProbability: bucket.minProbability,
      maxProbability: bucket.maxProbability,
      count: rows.length,
    };
    if (rows.length) {
      result.predictedMean = round(mean(rows.map(probability)));
      result.realizedRate = round(mean(rows.map(outcomeNumber)));
      result.brier = round(mean(rows.map((entry) => brier(entry))));
    }
    return result;
  });
}

function summarizeMarketSkill(scored) {
  const anchored = scored
    .map((entry) => {
      const market = marketProbability(entry);
      return Number.isFinite(market) ? { entry, market } : null;
    })
    .filter(Boolean);
  if (!anchored.length) return null;
  const forecastBrier = mean(anchored.map(({ entry }) => brier(entry)));
  const marketBrier = mean(anchored.map(({ entry, market }) => brier(entry, market)));
  return {
    count: anchored.length,
    forecastBrier: round(forecastBrier),
    marketBrier: round(marketBrier),
    brierDelta: round(marketBrier - forecastBrier),
  };
}

// The feed a market bet settles on: its anchor is the question's own market.
export const MARKET_SETTLEMENT_FEED = 'prediction:markets-resolution:v1';

// An anchor without lineage was chosen by the pre-#7071 matcher, which paired
// forecasts with unrelated markets ("Cyber threat concentration: Taiwan" with
// "Will China invade Taiwan by 2027?"). Its price belongs to another question,
// so no market comparison may read it. A market bet carries no lineage because
// its market is the question.
export function hasPreLineageAnchor(entry) {
  const calibration = entry?.calibration;
  if (!Number.isFinite(Number(calibration?.marketPrice))) return false;
  if (entry?.spec?.sourceFeed === MARKET_SETTLEMENT_FEED) return false;
  return !Number.isFinite(calibration.marketBlendedProbability);
}

function marketProbability(entry) {
  if (hasPreLineageAnchor(entry)) return NaN;
  const raw = entry?.calibration?.marketPrice;
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return clampProbability(n > 1 ? n / 100 : n);
}

// Pinned to PROJECTION_HORIZONS (_forecast-resolution.mjs) by the scorecard test.
const PROJECTION_HORIZON_ORDER = ['h24', 'd7', 'd30'];

// Per-horizon projection lane (#7075). Reported beside the forecast scorecard,
// never pooled into it: a Brier appears for a horizon only once that horizon
// alone reaches the interval sample floor, so an early read cannot be mistaken
// for measured skill. The same rows are sliced by domain and by the
// projection-curve version stamped at emission, so a curve change is read
// apart from the windows the old curves produced.
function summarizeProjectionHorizons(entries, nowMs) {
  return {
    semantics: 'point_in_time',
    minSample: SKILL_MIN_FAMILIES,
    methodology: `Brier over resolved YES/NO point-in-time projection windows, reported per horizon only once its scored windows come from at least ${SKILL_MIN_FAMILIES} forecast families with ${SKILL_MIN_OUTCOME_FAMILIES} YES and ${SKILL_MIN_OUTCOME_FAMILIES} NO families, and never pooled into the forecast headline; UNOBSERVED (no sample inside the stored tolerance) is counted apart from NO and VOID. The realized rate is the YES share of scored windows with a 95% Wilson interval; that interval treats each window as independent, so read it beside the family count. Slices by domain and by projection-curve version (null: the window was registered from a history emission that carries no version stamp) repeat the same per-horizon rows.`,
    byHorizon: summarizeHorizonRows(entries, nowMs, 'projection'),
    byDomain: sliceHorizonRows(entries, (entry) => entry?.domain || 'unknown').map(([domain, group]) => ({
      domain,
      byHorizon: summarizeHorizonRows(group, nowMs, `projection:domain:${domain}`),
    })),
    byCurvesVersion: sliceHorizonRows(entries, projectionCurvesVersionOf).map(([curvesVersion, group]) => ({
      curvesVersion,
      byHorizon: summarizeHorizonRows(group, nowMs, `projection:curves:${curvesVersion}`),
    })),
  };
}

function projectionCurvesVersionOf(entry) {
  return Number.isInteger(entry?.projectionCurvesVersion) ? entry.projectionCurvesVersion : null;
}

// Sorted with null first, then ascending.
function sliceHorizonRows(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return a < b ? -1 : 1;
  });
}

function summarizeHorizonRows(entries, nowMs, scope) {
  return PROJECTION_HORIZON_ORDER.map((horizon) => {
    const group = entries.filter((entry) => entry?.spec?.horizon === horizon);
    const resolved = group.filter((entry) => entry?.status === 'resolved');
    const scored = resolved.filter(isScoredEntry);
    const families = familyTotals(scored);
    const yes = scored.filter((entry) => entry.outcome === 'YES').length;
    const maturedPending = group.filter((entry) => {
      if (entry?.status === 'resolved') return false;
      const deadline = entryDeadline(entry);
      return Number.isFinite(deadline) && deadline <= nowMs;
    });
    return {
      horizon,
      registered: group.length,
      matured: resolved.length + maturedPending.length,
      resolved: resolved.length,
      scored: scored.length,
      families: families.length,
      yes,
      no: scored.filter((entry) => entry.outcome === 'NO').length,
      unobserved: resolved.filter((entry) => entry?.outcome === 'UNOBSERVED').length,
      void: resolved.filter((entry) => entry?.outcome === 'VOID').length,
      realizedRate: proportion(yes, scored.length),
      brier: meetsFamilyMinimums(families) ? brierInterval(scored, `${scope}:${horizon}`) : null,
      insufficientSample: !meetsFamilyMinimums(families),
    };
  });
}

// ---------------------------------------------------------------------------
// Calibration shadow metrics and activation gate (#7070).
//
// Input rows are forward-cohort pairs { domain, family, y, raw, calibrated }:
// one resolved YES/NO published-origin entry, its family key, its stored
// probability, and what the calibration map would have published instead.
// Building those rows (and refusing in-sample entries) belongs to
// _forecast-calibration.mjs; this is the measurement half and holds no opinion
// on how the map was fitted.
// ---------------------------------------------------------------------------

export const CALIBRATION_BOOTSTRAP_RESAMPLES = 2000;
export const CALIBRATION_BOOTSTRAP_SEED = 7070;
// Forward minimums count families, not rows (#9034, amended preregistration on
// #7070, 2026-10-08): a recurring question resolves window after window, so a
// row count let three families pass on 70 rows.
export const ACTIVATION_MIN_FORWARD_FAMILIES = 60;
export const ACTIVATION_MIN_FORWARD_DOMAIN_FAMILIES = 30;
// Upper bound of the paired 95% interval on (calibrated − raw) Brier must sit
// at or below this margin. Preregistered here so the gate cannot be tuned
// after the forward cohort is seen.
export const ACTIVATION_NON_INFERIORITY_MARGIN = 0.005;
// Scorecard intervals (#7072) use their own seed so a change to the #7070
// shadow gate's draws cannot move a published interval, and vice versa.
export const SCORECARD_BOOTSTRAP_SEED = 7072;
// A cohort is measurable from this many forecast families (#8990). A family is
// one forecast id, and its windows share a question, a detector and an
// outcome process, so its rows are not independent: on 2026-10-07 the 243
// headline rows came from 42 families. Every interval here resamples whole
// families, and a cluster bootstrap over fewer than about 30 clusters
// understates its own width, so 30 families is the floor for a published
// verdict. Below it an interval is still published, flagged as a small sample.
export const SKILL_MIN_FAMILIES = 30;
// ...and from this many families with a YES outcome and this many with a NO.
// The reference Brier p(1-p) rests on the minority outcome: with one or two
// YES families, one flip moves it by a third or more and the skill score with
// it. Five of each is the np >= 5 and n(1-p) >= 5 rule behind the normal
// approximation to a binomial rate, counted in families for the same reason.
export const SKILL_MIN_OUTCOME_FAMILIES = 5;
const RELIABILITY_BINS = 10;
const WILSON_Z95 = 1.959963984540054;

export function wilsonInterval(successes, n, z = WILSON_Z95) {
  if (!Number.isInteger(n) || n <= 0) return null;
  const phat = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denominator;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

function bucketIndex(p) {
  return Math.min(RELIABILITY_BINS - 1, Math.max(0, Math.floor(p * RELIABILITY_BINS)));
}

function expectedCalibrationError(rows, field) {
  if (!rows.length) return NaN;
  const sums = Array.from({ length: RELIABILITY_BINS }, () => ({ n: 0, p: 0, y: 0 }));
  for (const row of rows) {
    const bin = sums[bucketIndex(row[field])];
    bin.n += 1;
    bin.p += row[field];
    bin.y += row.y;
  }
  let ece = 0;
  for (const bin of sums) {
    if (bin.n) ece += (bin.n / rows.length) * Math.abs(bin.p / bin.n - bin.y / bin.n);
  }
  return ece;
}

export function reliabilityBuckets(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const index = bucketIndex(row[field]);
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(row);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((index) => {
    const group = groups.get(index);
    const positives = group.reduce((sum, row) => sum + row.y, 0);
    return {
      bucket: `${index * 10}-${(index + 1) * 10}`,
      count: group.length,
      predictedMean: round(mean(group.map((row) => row[field]))),
      realizedRate: round(positives / group.length),
      realizedWilson95: wilsonInterval(positives, group.length),
    };
  });
}

function rowBrier(row, field) {
  return (row[field] - row.y) ** 2;
}

// Deterministic PRNG so a rerun over the same ledger reproduces every interval.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(scope, baseSeed) {
  let hash = baseSeed >>> 0;
  for (const char of scope) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

/**
 * Family-cluster paired bootstrap (#9034): each resample draws whole families
 * with replacement and pools their rows, and a row carries its raw and
 * calibrated values together, so every statistic sees the same pairs. Windows
 * of one family share an outcome history; resampling them one by one read a
 * repeated question as independent evidence and narrowed the interval.
 * Families keep first-seen order, so with one row per family the draws are
 * those of a row bootstrap.
 */
export function pairedBootstrap(rows, statistics, options = {}) {
  const resamples = options.resamples ?? CALIBRATION_BOOTSTRAP_RESAMPLES;
  const random = mulberry32(seedFor(options.scope ?? 'overall', options.seed ?? CALIBRATION_BOOTSTRAP_SEED));
  const names = Object.keys(statistics);
  const draws = Object.fromEntries(names.map((name) => [name, []]));
  const families = rowsByFamily(rows);
  const sample = [];
  for (let r = 0; r < resamples; r += 1) {
    sample.length = 0;
    for (const family of drawFamilies(families, random)) for (const row of family) sample.push(row);
    for (const name of names) draws[name].push(statistics[name](sample));
  }
  return Object.fromEntries(names.map((name) => {
    const sorted = draws[name].sort((a, b) => a - b);
    return [name, [round(percentile(sorted, 0.025)), round(percentile(sorted, 0.975))]];
  }));
}

function rowsByFamily(rows) {
  const byFamily = new Map();
  for (const row of rows) {
    if (typeof row?.family !== 'string') throw new TypeError('pairedBootstrap rows need a family key');
    if (!byFamily.has(row.family)) byFamily.set(row.family, []);
    byFamily.get(row.family).push(row);
  }
  return [...byFamily.values()];
}

function familyCount(rows) {
  return new Set(rows.map((row) => row.family)).size;
}

const brierDeltaStatistic = (sample) => mean(sample.map((row) => rowBrier(row, 'calibrated') - rowBrier(row, 'raw')));

function summarizeShadowRows(rows, scope, options) {
  const intervals = pairedBootstrap(rows, {
    brierDelta: brierDeltaStatistic,
    rawEce: (sample) => expectedCalibrationError(sample, 'raw'),
    calibratedEce: (sample) => expectedCalibrationError(sample, 'calibrated'),
  }, { ...options, scope });
  const side = (field, eceCi95) => ({
    brier: round(mean(rows.map((row) => rowBrier(row, field)))),
    ece: round(expectedCalibrationError(rows, field)),
    eceCi95,
    reliability: reliabilityBuckets(rows, field),
  });
  return {
    count: rows.length,
    families: familyCount(rows),
    positives: rows.reduce((sum, row) => sum + row.y, 0),
    raw: side('raw', intervals.rawEce),
    calibrated: side('calibrated', intervals.calibratedEce),
    // calibrated − raw: negative means the map lowered Brier on this cohort.
    brierDelta: { mean: round(brierDeltaStatistic(rows)), ci95: intervals.brierDelta },
  };
}

/**
 * Raw vs calibrated metrics for a forward cohort. `modeByDomain` names which
 * domains the map actually moves; identity domains are reported too, since
 * their delta is zero by construction and shows the map stayed out of them.
 */
export function summarizeCalibrationShadow(rows, modeByDomain = {}, options = {}) {
  if (!rows.length) return { count: 0, families: 0, positives: 0, byDomain: [] };
  const domains = [...new Set(rows.map((row) => row.domain))].sort();
  return {
    ...summarizeShadowRows(rows, 'overall', options),
    byDomain: domains.map((domain) => {
      const domainRows = rows.filter((row) => row.domain === domain);
      const summary = summarizeShadowRows(domainRows, `domain:${domain}`, options);
      return {
        domain,
        mode: modeByDomain[domain] ?? 'identity',
        count: summary.count,
        families: summary.families,
        positives: summary.positives,
        rawBrier: summary.raw.brier,
        calibratedBrier: summary.calibrated.brier,
        brierDelta: summary.brierDelta,
      };
    }),
  };
}

/**
 * The #7070 activation gate. Its minimums count forward families and its
 * interval is the family-cluster bootstrap (#9034). Reports eligibility and
 * every failing reason;
 * seed-forecasts publishes calibrated probabilities only while `eligible`
 * holds for the current map. Coverage, VOID
 * and origin mix ride beside the verdict (from `context`) so a cohort that
 * looks better only because its selection changed is visible next to it.
 */
export function evaluateActivationGate(shadow, modeByDomain, context = {}, options = {}) {
  const thresholds = {
    minForwardFamilies: options.minForwardFamilies ?? ACTIVATION_MIN_FORWARD_FAMILIES,
    minForwardDomainFamilies: options.minForwardDomainFamilies ?? ACTIVATION_MIN_FORWARD_DOMAIN_FAMILIES,
    nonInferiorityMargin: options.nonInferiorityMargin ?? ACTIVATION_NON_INFERIORITY_MARGIN,
    bootstrapResamples: options.resamples ?? CALIBRATION_BOOTSTRAP_RESAMPLES,
    bootstrapSeed: options.seed ?? CALIBRATION_BOOTSTRAP_SEED,
  };
  const reasons = [];
  const activated = Object.keys(modeByDomain).filter((domain) => modeByDomain[domain] !== 'identity').sort();
  if (options.mapMonotone === false) reasons.push('map_not_monotone');
  if (!activated.length) reasons.push('no_non_identity_domain');
  const forwardCount = shadow?.count ?? 0;
  const forwardFamilies = shadow?.families ?? 0;
  if (forwardFamilies < thresholds.minForwardFamilies) reasons.push('insufficient_forward_total');

  const nonInferior = (delta) => Array.isArray(delta?.ci95) && delta.ci95[1] <= thresholds.nonInferiorityMargin;
  const overallNonInferior = forwardCount > 0 && nonInferior(shadow.brierDelta);
  if (forwardCount > 0 && !overallNonInferior) reasons.push('overall_not_non_inferior');

  const domains = activated.map((domain) => {
    const row = shadow?.byDomain?.find((candidate) => candidate.domain === domain);
    const count = row?.count ?? 0;
    const families = row?.families ?? 0;
    const sufficient = families >= thresholds.minForwardDomainFamilies;
    const domainNonInferior = count > 0 && nonInferior(row.brierDelta);
    if (!sufficient) reasons.push(`insufficient_forward_domain:${domain}`);
    if (count > 0 && !domainNonInferior) reasons.push(`domain_not_non_inferior:${domain}`);
    return {
      domain,
      count,
      families,
      sufficient,
      brierDeltaUpper: row?.brierDelta?.ci95?.[1] ?? null,
      nonInferior: domainNonInferior,
    };
  });

  return {
    eligible: reasons.length === 0,
    reasons,
    thresholds,
    forwardCount,
    forwardFamilies,
    overall: {
      brierDeltaUpper: shadow?.brierDelta?.ci95?.[1] ?? null,
      nonInferior: overallNonInferior,
    },
    domains,
    context,
  };
}

// Public receipts (#5092): the newest resolved entries, reduced to members a
// signed-out reader may see. Each receipt is built member by member, never
// spread from the ledger, so judge rationale, archive contents, ledger keys and
// metric paths have no route to the page.
export const PUBLIC_RECEIPT_LIMIT = 20;
export const PUBLIC_RECEIPT_FIELDS = Object.freeze([
  'question', 'forecastAt', 'probability', 'outcome', 'resolvedAt',
  'voidReason', 'sourceFeed', 'observedValue', 'citationTitle', 'citationUrl',
]);
const QUESTION_MAX_CHARS = 240;
const CITATION_TITLE_MAX_CHARS = 160;
const CITATION_URL_MAX_CHARS = 500;
// Archive links were not gated to publisher domains until #8408 merged
// (2026-09-21T16:39:21Z). Evidence lives 15 days (FORECAST_EVIDENCE_TTL_S), and
// a day more covers the deploy rollout and instances still serving the old
// build, so a citation on an entry resolved before this instant may carry an
// ungated link; those receipts keep the title and drop the link.
export const PUBLIC_RECEIPT_LINKS_SINCE_MS = Date.parse('2026-09-21T16:39:21Z') + 16 * DAY_MS;

// Feed keys are internal Redis names, so a receipt carries a public code.
export const RECEIPT_SOURCE_FEEDS = Object.freeze({
  'conflict:ucdp-events:v1': 'ucdp-events',
  'conflict:acled-resolution:v1:all:0:0': 'acled-events',
  'unrest:events-resolution:v1': 'unrest-events',
  'cyber:threats-bootstrap:v2': 'cyber-threats',
  'supply_chain:chokepoints:v4': 'chokepoints',
  'supply_chain:shipping:v2': 'shipping-rates',
  'prediction:markets-bootstrap:v1': 'prediction-markets',
  'prediction:markets-resolution:v1': 'prediction-market-settlements',
  'intelligence:gpsjam:v2': 'gps-jamming',
  'infra:outages:v1': 'internet-outages',
  'market:stocks-bootstrap:v1': 'stock-prices',
  'market:commodities-bootstrap:v1': 'commodity-prices',
  'market:sectors:v2': 'sector-performance',
  'market:gulf-quotes:v1': 'gulf-markets',
  'market:etf-flows:v1': 'etf-flows',
  'market:crypto:v1': 'crypto-prices',
  'market:stablecoins:v1': 'stablecoins',
  'economic:bis:eer:v1': 'bis-exchange-rates',
  'economic:bis:policy:v1': 'bis-policy-rates',
  'correlation:cards-bootstrap:v1': 'correlation-cards',
  'energy:eia-petroleum:v1': 'eia-petroleum',
  'economic:fred:v1:FEDFUNDS:0': 'fred',
  'economic:fred:v1:UNRATE:0': 'fred',
  'economic:fred:v1:CPIAUCSL:0': 'fred',
  'economic:fred:v1:DGS10:0': 'fred',
});
export const RECEIPT_SOURCE_LABELS = Object.freeze({
  'ucdp-events': 'UCDP conflict events',
  'acled-events': 'ACLED conflict events',
  'unrest-events': 'Protest and unrest events',
  'cyber-threats': 'Cyber threat reports',
  chokepoints: 'Shipping chokepoint status',
  'shipping-rates': 'Shipping rates',
  'prediction-markets': 'Prediction-market prices',
  'prediction-market-settlements': 'Prediction-market settlements',
  'gps-jamming': 'GPS jamming reports',
  'internet-outages': 'Internet outage reports',
  'stock-prices': 'Stock prices',
  'commodity-prices': 'Commodity prices',
  'sector-performance': 'Sector performance',
  'gulf-markets': 'Gulf market quotes',
  'etf-flows': 'ETF flows',
  'crypto-prices': 'Crypto prices',
  stablecoins: 'Stablecoin data',
  'bis-exchange-rates': 'BIS exchange rates',
  'bis-policy-rates': 'BIS policy rates',
  'correlation-cards': 'Market correlation signals',
  'eia-petroleum': 'EIA petroleum data',
  fred: 'FRED economic data',
  other: 'A World Monitor data feed',
});
export const RECEIPT_VOID_REASON_LABELS = Object.freeze({
  no_establishable_metric: 'The feed had no reading for this question',
  value_source_never_settled: 'The feed never published a settled value',
  count_source_window_not_retained: 'The feed no longer held the question window',
  unsupported_window: 'The question could not be checked against its feed',
  unsupported_metric_key: 'The question could not be checked against its feed',
  not_hard_spec: 'The question could not be checked against its feed',
  missing_threshold: 'The question was missing a threshold',
  missing_deadline: 'The question was missing a deadline',
  missing_generated_at: 'The forecast was missing its start date',
  beyond_archive_horizon: 'The news archive no longer covered the question window',
  no_archive_evidence: 'The news archive had nothing on the subject',
  all_judges_void: 'Both judges found the evidence insufficient',
  judge_disagreement: 'The judges disagreed',
  judge_retry_exhausted: 'The judges returned no verdict',
  withheld_unpublished: 'This kind of forecast is no longer published',
  resolver_envelope_bug: 'Scored against a data feed we could not read correctly',
  market_price_not_outcome: 'The feed showed the market price, not how the market resolved',
  judged_evidence_unreliable: "Held out of scoring while the judges' evidence is being fixed",
  judged_old_selection: 'Judged with an evidence method later found unreliable',
  late_read: 'The feed was not read close enough to the deadline',
  feed_unavailable: 'The data feed was unavailable after the deadline',
  resolver_could_not_read_feed: 'Our resolver could not read this feed correctly',
  other: 'Could not be resolved',
});
const RECEIPT_OUTCOMES = new Set(['YES', 'NO', 'VOID']);

function publicText(value, maxChars) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

function publicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > CITATION_URL_MAX_CHARS) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function publicReceipt(entry) {
  const forecastAt = Number(entry.generatedAt ?? entry.firstSeenAt);
  const probability = Number(entry.probability);
  const resolvedAt = Number(entry.resolvedAt);
  const question = publicText(entry.spec?.question || entry.title, QUESTION_MAX_CHARS);
  if (!RECEIPT_OUTCOMES.has(entry.outcome) || !question) return null;
  if (![forecastAt, probability, resolvedAt].every(Number.isFinite)) return null;
  const receipt = {
    question,
    forecastAt,
    probability: Math.round(clampProbability(probability) * 1000) / 1000,
    outcome: entry.outcome,
    resolvedAt,
  };
  const evidence = entry.evidence ?? {};
  if (entry.outcome === 'VOID') {
    receipt.voidReason = Object.hasOwn(RECEIPT_VOID_REASON_LABELS, evidence.reason) ? evidence.reason : 'other';
  }
  if (entry.spec?.kind === 'hard') {
    receipt.sourceFeed = Object.hasOwn(RECEIPT_SOURCE_FEEDS, entry.spec.sourceFeed) ? RECEIPT_SOURCE_FEEDS[entry.spec.sourceFeed] : 'other';
    if (entry.outcome !== 'VOID' && typeof evidence.metricValue === 'number' && Number.isFinite(evidence.metricValue)) {
      receipt.observedValue = evidence.metricValue;
    }
  } else if (entry.outcome !== 'VOID') {
    const citation = (Array.isArray(evidence.citations) ? evidence.citations : [])
      .find((row) => publicText(row?.title, CITATION_TITLE_MAX_CHARS));
    if (citation) {
      receipt.citationTitle = publicText(citation.title, CITATION_TITLE_MAX_CHARS);
      const url = resolvedAt >= PUBLIC_RECEIPT_LINKS_SINCE_MS ? publicHttpsUrl(citation.url) : undefined;
      if (url) receipt.citationUrl = url;
    }
  }
  return receipt;
}

// Card chips (#5092): for each published family (forecast id) with an open
// window, its newest resolved windows, newest first. A live card is the open
// window, so these are the family's earlier outcomes, never the card's own.
// Open windows outlive the snapshot that published them, so the families are
// capped, keeping those seen most recently: the current snapshot's cards come
// first (#5092 review: production held 55 open families for a 15-card panel).
export const FAMILY_OUTCOME_LIMIT = 5;
export const FAMILY_OUTCOME_FAMILY_LIMIT = 24;
export const PUBLIC_FAMILY_OUTCOME_FIELDS = Object.freeze(['forecastId', 'outcome', 'voidReason']);

export function buildFamilyOutcomes(ledger, nowMs, { limit = FAMILY_OUTCOME_LIMIT } = {}) {
  const minResolvedAt = nowMs - DEFAULT_ROLLING_WINDOW_DAYS * DAY_MS;
  const windows = normalizeLedger(ledger).filter((entry) => entry && !isHorizonEntry(entry) && !isDuplicateWindow(entry) && isPublishedOriginEntry(entry));
  const lastSeenById = new Map();
  for (const entry of windows) {
    if (entry.status !== 'pending' && entry.status !== 'pending-judge') continue;
    lastSeenById.set(entry.id, Math.max(lastSeenById.get(entry.id) ?? 0, Number(entry.lastSeenAt) || 0));
  }
  const byFamily = new Map();
  for (const entry of windows) {
    if (entry.status !== 'resolved' || !lastSeenById.has(entry.id) || !RECEIPT_OUTCOMES.has(entry.outcome)) continue;
    const resolvedAt = Number(entry.resolvedAt);
    if (!Number.isFinite(resolvedAt) || resolvedAt < minResolvedAt) continue;
    if (!byFamily.has(entry.id)) byFamily.set(entry.id, []);
    byFamily.get(entry.id).push(entry);
  }
  const families = [...byFamily.keys()]
    .sort((a, b) => lastSeenById.get(b) - lastSeenById.get(a) || (a < b ? -1 : 1))
    .slice(0, FAMILY_OUTCOME_FAMILY_LIMIT)
    .sort();
  return families.flatMap((id) => byFamily.get(id)
    // One cycle can settle two overdue windows at the same instant; the later deadline is the newer window.
    .sort((a, b) => Number(b.resolvedAt) - Number(a.resolvedAt) || Number(b.deadline) - Number(a.deadline))
    .slice(0, limit)
    .map((entry) => (entry.outcome === 'VOID'
      ? { forecastId: id, outcome: 'VOID', voidReason: Object.hasOwn(RECEIPT_VOID_REASON_LABELS, entry.evidence?.reason) ? entry.evidence.reason : 'other' }
      : { forecastId: id, outcome: entry.outcome })));
}

// Published-origin forecast windows inside the rolling window: shadow,
// synthetic and unattributed origins never become receipts.
export function buildPublicReceipts(ledger, nowMs, { limit = PUBLIC_RECEIPT_LIMIT } = {}) {
  const minResolvedAt = nowMs - DEFAULT_ROLLING_WINDOW_DAYS * DAY_MS;
  return normalizeLedger(ledger)
    .filter((entry) => entry?.status === 'resolved' && !isHorizonEntry(entry) && !isDuplicateWindow(entry) && isPublishedOriginEntry(entry)
      && Number(entry.resolvedAt) >= minResolvedAt)
    .map(publicReceipt)
    .filter(Boolean)
    .sort((a, b) => b.resolvedAt - a.resolvedAt || a.question.localeCompare(b.question))
    .slice(0, limit);
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
