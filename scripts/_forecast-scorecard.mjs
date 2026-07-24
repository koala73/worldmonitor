// Pure scorecard math for forecast resolutions (#5007 Bet 2).
//
// Input is the Redis working ledger (object or array). Output is a compact,
// JSON-serializable scorecard. No wall-clock reads: nowMs is injected.

export const DEFAULT_ROLLING_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPSILON = 1e-6;

// Origins whose scored entries are held OUT of the headline skill Brier:
// `state_derived` = synthetic count-padding backfill (not a real prediction);
// `bet_engine`    = shadow bets scored for evidence but not yet promoted.
// The all-origins `overall` block still counts them for continuity.
export const SYNTHETIC_GENERATION_ORIGINS = ['state_derived'];
export const SHADOW_GENERATION_ORIGINS = ['bet_engine'];
const DEFAULT_SKILL_EXCLUDED_ORIGINS = [
  ...SYNTHETIC_GENERATION_ORIGINS,
  ...SHADOW_GENERATION_ORIGINS,
];

export function computeScorecard(ledger, nowMs, options = {}) {
  const rollingWindowDays = options.rollingWindowDays ?? DEFAULT_ROLLING_WINDOW_DAYS;
  const minResolvedAt = nowMs - rollingWindowDays * DAY_MS;
  const allEntries = normalizeLedger(ledger);
  const entries = allEntries.filter((entry) => {
    if (entry?.status !== 'resolved') return true;
    const resolvedAt = Number(entry.resolvedAt);
    return !Number.isFinite(resolvedAt) || resolvedAt >= minResolvedAt;
  });

  const resolved = entries.filter((entry) => entry?.status === 'resolved');
  const scored = resolved.filter(isScoredEntry);
  const voided = resolved.filter((entry) => entry?.outcome === 'VOID');
  const pending = entries.filter((entry) => entry?.status === 'pending');
  const pendingJudge = entries.filter((entry) => entry?.status === 'pending-judge');

  const scorecard = {
    schemaVersion: 1,
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
    byDomain: summarizeGroups(scored, resolved, 'domain', 'domain'),
    byGenerationOrigin: summarizeGroups(scored, resolved, 'generationOrigin', 'generationOrigin'),
    calibration: calibrationBuckets(scored),
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
  const marketSkill = summarizeMarketSkill(scored);
  if (marketSkill) scorecard.vsMarketSkill = marketSkill;

  // Per-origin Gate-2 measurement (#5525 U14): the pooled calibration and
  // vsMarketSkill above mix legacy + shadow origins, so Gate 2 reads these
  // bet_engine-scoped slices instead — calibration curve, market comparison,
  // ensemble-vs-base-rate baseline delta, and outcome-conditioned deviation
  // skill (KTD3: on bets where the ensemble deviates from the market, does the
  // deviation's direction predict outcomes better than the market alone?).
  const betEngineScored = scored.filter((entry) => (entry?.generationOrigin || 'unknown') === 'bet_engine');
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

function isScoredEntry(entry) {
  return entry?.status === 'resolved'
    && (entry.outcome === 'YES' || entry.outcome === 'NO')
    && Number.isFinite(Number(entry.probability));
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

// Headline "real skill" summary: Brier/log score over scored entries whose
// generationOrigin is NOT in the exclude set. Present whenever anything is
// scored — a fully synthetic funnel surfaces as count 0 with excludedScored>0,
// which is the honest signal that the headline is unmeasurable.
function summarizeSkill(scored, excludeSet) {
  if (!scored.length) return null;
  // KNOWN-GAP (#5233 follow-up, tracked in #5240): entries whose generationOrigin
  // is absent fall back to 'unknown', which is NOT in the exclude set, so they
  // count toward real skill. Deliberately conservative — untagged is not the same
  // as synthetic, and dropping genuinely-real entries would understate skill.
  // The live history payload already tags entries (buildHistoryForecastEntry
  // defaults to 'legacy_detector'), so the ~52% 'unknown' in the ledger are
  // LEGACY entries created before that default and age out over the 180d
  // retention (0 are yet scored). Residual risk only if a legacy 'unknown' entry
  // scores before aging out; #5240 tracks a one-time backfill/monitor.
  const originOf = (entry) => entry?.generationOrigin || 'unknown';
  const real = scored.filter((entry) => !excludeSet.has(originOf(entry)));
  const excludedEntries = scored.filter((entry) => excludeSet.has(originOf(entry)));
  const excludedOrigins = [...new Set(excludedEntries.map(originOf))].sort();
  const summary = summarizeScored(real);
  return pruneUndefined({
    count: real.length,
    excludedScored: excludedEntries.length,
    // Always an array (proto `repeated string` is non-optional): a typed client
    // reads skill.excludedOrigins.length on the healthy path, where it is [].
    excludedOrigins,
    brier: summary?.brier,
    logScore: summary?.logScore,
  });
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
