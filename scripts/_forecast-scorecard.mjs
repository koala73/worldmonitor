// Pure scorecard math for forecast resolutions (#5007 Bet 2).
//
// Input is the Redis working ledger (object or array). Output is a compact,
// JSON-serializable scorecard. No wall-clock reads: nowMs is injected.

export const DEFAULT_ROLLING_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPSILON = 1e-6;

// Service level for the judged lane (#7068): how long after its deadline a
// judged entry may take to reach a terminal state and still count as on time.
// Two days leaves room for one retry cycle on the daily cadence while staying
// well inside the archive horizon.
export const DEFAULT_JUDGED_SLA_MS = 2 * DAY_MS;

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
export function isPublishedOriginEntry(entry) {
  return !DEFAULT_SKILL_EXCLUDED_ORIGINS.includes(generationOriginOf(entry));
}

export function computeScorecard(ledger, nowMs, options = {}) {
  const rollingWindowDays = options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;
  const minResolvedAt = nowMs - rollingWindowDays * DAY_MS;
  const allEntries = normalizeLedger(ledger);
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

  const scorecard = {
    // 2: carries publishedByDomain (#5092).
    schemaVersion: 2,
    generatedAt: nowMs,
    rollingWindowDays,
    methodology: 'Brier/log score over resolved YES/NO published forecast windows; VOID and pending entries are counted for coverage but excluded from accuracy math.',
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
  const promoteBetEngine = options.promoteBetEngine === true;
  const defaultExcluded = promoteBetEngine
    ? DEFAULT_SKILL_EXCLUDED_ORIGINS.filter((origin) => origin !== 'bet_engine')
    : DEFAULT_SKILL_EXCLUDED_ORIGINS;
  const excludeOrigins = new Set(options.skillExcludeOrigins ?? defaultExcluded);
  const skill = summarizeSkill(scored, excludeOrigins);
  if (skill) scorecard.skill = skill;
  scorecard.publishedByDomain = summarizePublishedByDomain(scored);
  scorecard.uncertainty = {
    method: `entry-level percentile bootstrap, ${CALIBRATION_BOOTSTRAP_RESAMPLES} resamples, seed ${SCORECARD_BOOTSTRAP_SEED}`,
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
    const sliceMarket = summarizeMarketSkill(betEngineScored);
    if (sliceMarket) slice.vsMarketSkill = sliceMarket;
    const baseline = summarizeBaselineSkill(betEngineScored);
    if (baseline) slice.vsBaseRate = baseline;
    const deviation = summarizeDeviationSkill(betEngineScored);
    if (deviation) slice.deviationSkill = deviation;
    scorecard.betEngine = slice;
  }
  return scorecard;
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
function summarizePublishedByDomain(scored) {
  const byDomain = new Map();
  for (const entry of scored.filter(isPublishedOriginEntry)) {
    const domain = entry?.domain || 'unknown';
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(entry);
  }
  return [...byDomain.keys()].sort().map((domain) => {
    const entries = byDomain.get(domain);
    return {
      domain,
      count: entries.length,
      brier: round(mean(entries.map((entry) => brier(entry)))),
      yesCount: entries.filter((entry) => entry.outcome === 'YES').length,
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
    count: real.length,
    // yesCount / count is the cohort's base rate, the null /accuracy/ compares
    // the headline Brier against (#8873). The pooled calibration buckets carry
    // the all-scored equivalent, but nothing else carries this cohort's.
    yesCount: real.filter((entry) => entry.outcome === 'YES').length,
    excludedScored: excludedEntries.length,
    // Always an array (proto `repeated string` is non-optional): a typed client
    // reads skill.excludedOrigins.length on the healthy path, where it is [].
    excludedOrigins,
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
    return resolvedAt - deadline <= slaMs;
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
    return Number.isFinite(deadline) && nowMs >= deadline;
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
  const scores = entries.map((entry) => brier(entry));
  const { mean: ci95 } = pairedBootstrap(scores, { mean }, { scope, seed: SCORECARD_BOOTSTRAP_SEED });
  return {
    count: scores.length,
    mean: round(mean(scores)),
    ci95,
    insufficientSample: scores.length < INTERVAL_MIN_SAMPLE,
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

function marketProbability(entry) {
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
// for measured skill.
function summarizeProjectionHorizons(entries, nowMs) {
  const byHorizon = PROJECTION_HORIZON_ORDER.map((horizon) => {
    const group = entries.filter((entry) => entry?.spec?.horizon === horizon);
    const resolved = group.filter((entry) => entry?.status === 'resolved');
    const scored = resolved.filter(isScoredEntry);
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
      yes: scored.filter((entry) => entry.outcome === 'YES').length,
      no: scored.filter((entry) => entry.outcome === 'NO').length,
      unobserved: resolved.filter((entry) => entry?.outcome === 'UNOBSERVED').length,
      void: resolved.filter((entry) => entry?.outcome === 'VOID').length,
      brier: scored.length >= INTERVAL_MIN_SAMPLE ? brierInterval(scored, `projection:${horizon}`) : null,
      insufficientSample: scored.length < INTERVAL_MIN_SAMPLE,
    };
  });
  return {
    semantics: 'point_in_time',
    minSample: INTERVAL_MIN_SAMPLE,
    methodology: `Brier over resolved YES/NO point-in-time projection windows, reported per horizon only at or above ${INTERVAL_MIN_SAMPLE} scored windows and never pooled into the forecast headline; UNOBSERVED (no sample inside the stored tolerance) is counted apart from NO and VOID.`,
    byHorizon,
  };
}

// ---------------------------------------------------------------------------
// Calibration shadow metrics and activation gate (#7070).
//
// Input rows are forward-cohort pairs { domain, y, raw, calibrated }: one
// resolved YES/NO published-origin entry, its stored probability, and what the
// calibration map would have published instead. Building those rows (and
// refusing in-sample entries) belongs to _forecast-calibration.mjs; this is the
// measurement half and holds no opinion on how the map was fitted.
// ---------------------------------------------------------------------------

export const CALIBRATION_BOOTSTRAP_RESAMPLES = 2000;
export const CALIBRATION_BOOTSTRAP_SEED = 7070;
export const ACTIVATION_MIN_FORWARD_TOTAL = 60;
export const ACTIVATION_MIN_FORWARD_DOMAIN = 30;
// Upper bound of the paired 95% interval on (calibrated − raw) Brier must sit
// at or below this margin. Preregistered here so the gate cannot be tuned
// after the forward cohort is seen.
export const ACTIVATION_NON_INFERIORITY_MARGIN = 0.005;
// Scorecard intervals (#7072) use their own seed so a change to the #7070
// shadow gate's draws cannot move a published interval, and vice versa.
export const SCORECARD_BOOTSTRAP_SEED = 7072;
// Below this many entries an interval is still published, flagged as resting
// on too small a sample to read as a stable estimate.
export const INTERVAL_MIN_SAMPLE = 30;
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
 * Entry-level paired bootstrap: each resample draws entries (not raw and
 * calibrated values separately), so every statistic sees the same pairs.
 */
export function pairedBootstrap(rows, statistics, options = {}) {
  const resamples = options.resamples ?? CALIBRATION_BOOTSTRAP_RESAMPLES;
  const random = mulberry32(seedFor(options.scope ?? 'overall', options.seed ?? CALIBRATION_BOOTSTRAP_SEED));
  const names = Object.keys(statistics);
  const draws = Object.fromEntries(names.map((name) => [name, []]));
  const sample = new Array(rows.length);
  for (let r = 0; r < resamples; r += 1) {
    for (let i = 0; i < rows.length; i += 1) sample[i] = rows[Math.floor(random() * rows.length)];
    for (const name of names) draws[name].push(statistics[name](sample));
  }
  return Object.fromEntries(names.map((name) => {
    const sorted = draws[name].sort((a, b) => a - b);
    return [name, [round(percentile(sorted, 0.025)), round(percentile(sorted, 0.975))]];
  }));
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
  if (!rows.length) return { count: 0, positives: 0, byDomain: [] };
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
        positives: summary.positives,
        rawBrier: summary.raw.brier,
        calibratedBrier: summary.calibrated.brier,
        brierDelta: summary.brierDelta,
      };
    }),
  };
}

/**
 * The #7070 activation gate. Reports eligibility and every failing reason;
 * nothing reads `eligible` to change a published probability. Coverage, VOID
 * and origin mix ride beside the verdict (from `context`) so a cohort that
 * looks better only because its selection changed is visible next to it.
 */
export function evaluateActivationGate(shadow, modeByDomain, context = {}, options = {}) {
  const thresholds = {
    minForwardTotal: options.minForwardTotal ?? ACTIVATION_MIN_FORWARD_TOTAL,
    minForwardDomain: options.minForwardDomain ?? ACTIVATION_MIN_FORWARD_DOMAIN,
    nonInferiorityMargin: options.nonInferiorityMargin ?? ACTIVATION_NON_INFERIORITY_MARGIN,
    bootstrapResamples: options.resamples ?? CALIBRATION_BOOTSTRAP_RESAMPLES,
    bootstrapSeed: options.seed ?? CALIBRATION_BOOTSTRAP_SEED,
  };
  const reasons = [];
  const activated = Object.keys(modeByDomain).filter((domain) => modeByDomain[domain] !== 'identity').sort();
  if (options.mapMonotone === false) reasons.push('map_not_monotone');
  if (!activated.length) reasons.push('no_non_identity_domain');
  const forwardCount = shadow?.count ?? 0;
  if (forwardCount < thresholds.minForwardTotal) reasons.push('insufficient_forward_total');

  const nonInferior = (delta) => Array.isArray(delta?.ci95) && delta.ci95[1] <= thresholds.nonInferiorityMargin;
  const overallNonInferior = forwardCount > 0 && nonInferior(shadow.brierDelta);
  if (forwardCount > 0 && !overallNonInferior) reasons.push('overall_not_non_inferior');

  const domains = activated.map((domain) => {
    const row = shadow?.byDomain?.find((candidate) => candidate.domain === domain);
    const count = row?.count ?? 0;
    const sufficient = count >= thresholds.minForwardDomain;
    const domainNonInferior = count > 0 && nonInferior(row.brierDelta);
    if (!sufficient) reasons.push(`insufficient_forward_domain:${domain}`);
    if (count > 0 && !domainNonInferior) reasons.push(`domain_not_non_inferior:${domain}`);
    return {
      domain,
      count,
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

// Published-origin forecast windows inside the rolling window: shadow,
// synthetic and unattributed origins never become receipts.
export function buildPublicReceipts(ledger, nowMs, { limit = PUBLIC_RECEIPT_LIMIT } = {}) {
  const minResolvedAt = nowMs - DEFAULT_ROLLING_WINDOW_DAYS * DAY_MS;
  return normalizeLedger(ledger)
    .filter((entry) => entry?.status === 'resolved' && !isHorizonEntry(entry) && isPublishedOriginEntry(entry)
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
