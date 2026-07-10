// Pure scorecard math for forecast resolutions (#5007 Bet 2).
//
// Input is the Redis working ledger (object or array). Output is a compact,
// JSON-serializable scorecard. No wall-clock reads: nowMs is injected.

export const DEFAULT_ROLLING_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPSILON = 1e-6;

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
  const marketSkill = summarizeMarketSkill(scored);
  if (marketSkill) scorecard.vsMarketSkill = marketSkill;
  return scorecard;
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
