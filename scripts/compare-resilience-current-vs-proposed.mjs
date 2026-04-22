#!/usr/bin/env node
// Compare current production overall_score (6-domain weighted aggregate)
// against the proposed pillar-combined score with penalty term (α=0.5).
// Produces a JSON artifact with the Spearman correlation, the top-N
// absolute-rank movers, and per-country score deltas so the activation
// decision (flip or keep pending?) has a concrete data point.
//
// Usage: node --import tsx/esm scripts/compare-resilience-current-vs-proposed.mjs > out.json
//
// IMPORTANT: this script must use the SAME pillar aggregation path the
// production API exposes, not a local re-implementation with different
// weighting semantics. We therefore import `buildPillarList` directly
// from `server/worldmonitor/resilience/v1/_pillar-membership.ts` (which
// weights member domains by their average dimension coverage, not by
// their static domain weights) and replicate `_shared.ts#buildDomainList`
// inline so domain scores are produced by the same coverage-weighted
// mean the production scorer uses. Any drift from production here
// invalidates the Spearman / rank-delta conclusions downstream, so if
// production ever changes its aggregation path this script must be
// updated in lockstep.

import { loadEnvFile } from './_seed-utils.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESILIENCE_COHORTS } from '../tests/helpers/resilience-cohorts.mts';
import { MATCHED_PAIRS } from '../tests/helpers/resilience-matched-pairs.mts';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'docs', 'snapshots');

loadEnvFile(import.meta.url);

// Historical 52-country sensitivity seed. Preserved as a baseline so
// the comparison shape stays recognisable to the existing sensitivity
// pipeline, but EXTENDED below with the full union of every cohort
// member and every matched-pair endpoint. Without the union, PR 0's
// acceptance gates silently skip small-island-importers (zero cohort
// members in the 52-country seed) and sg-vs-ch (Singapore not in the
// seed) — the apparatus claims to measure what it does not actually
// measure.
const HISTORICAL_SENSITIVITY_SEED = [
  'NO','IS','NZ','DK','SE','FI','CH','AU','CA',
  'US','DE','GB','FR','JP','KR','IT','ES','PL',
  'BR','MX','TR','TH','MY','CN','IN','ZA','EG',
  'PK','NG','KE','BD','VN','PH','ID','UA','RU',
  'AF','YE','SO','HT','SS','CF','SD','ML','NE','TD','SY','IQ','MM','VE','IR','ET',
];

// The authoritative sample is the union of the historical seed + every
// country referenced by a cohort definition + every matched-pair
// endpoint. Running the comparison over a subset would mean cohort
// medians and pair gap checks would be computed over partial coverage
// and fail quietly — exactly the construct problem PR 0 is supposed to
// make impossible.
const cohortUnion = new Set(RESILIENCE_COHORTS.flatMap((c) => c.countryCodes));
const pairEndpoints = new Set(MATCHED_PAIRS.flatMap((p) => [p.higherExpected, p.lowerExpected]));
const SAMPLE = [...new Set([
  ...HISTORICAL_SENSITIVITY_SEED,
  ...cohortUnion,
  ...pairEndpoints,
])];

// Mirrors `_shared.ts#coverageWeightedMean`. Kept local because the
// production helper is not exported.
function coverageWeightedMean(dims) {
  const totalCoverage = dims.reduce((s, d) => s + d.coverage, 0);
  if (!totalCoverage) return 0;
  return dims.reduce((s, d) => s + d.score * d.coverage, 0) / totalCoverage;
}

// Mirrors `_shared.ts#buildDomainList` exactly so the ResilienceDomain
// objects fed to buildPillarList are byte-identical to what production
// emits. The production helper is not exported, so we re-implement it
// here; the implementation MUST stay in lockstep with _shared.ts.
function buildDomainList(dimensions, dimensionDomains, domainOrder, getDomainWeight) {
  const grouped = new Map();
  for (const domainId of domainOrder) grouped.set(domainId, []);
  for (const dim of dimensions) {
    const domainId = dimensionDomains[dim.id];
    grouped.get(domainId)?.push(dim);
  }
  return domainOrder.map((domainId) => {
    const domainDims = grouped.get(domainId) ?? [];
    const domainScore = coverageWeightedMean(domainDims);
    return {
      id: domainId,
      score: Math.round(domainScore * 100) / 100,
      weight: getDomainWeight(domainId),
      dimensions: domainDims,
    };
  });
}

function rankCountries(scores) {
  const sorted = Object.entries(scores)
    .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.localeCompare(b));
  const ranks = {};
  for (let i = 0; i < sorted.length; i++) {
    ranks[sorted[i][0]] = i + 1;
  }
  return ranks;
}

// Auto-discover the most recent pre-repair baseline snapshot committed
// by PR 0. Acceptance gates 2 + 6 + 7 from the plan compare post-change
// scoring against a LOCKED BEFORE-STATE, not against the in-process
// proposed formula. Without this discovery, the script can only compare
// two formulas from the same checkout — and cannot prove "no country
// moved >15 points vs baseline" or "cohort median shift vs baseline"
// for later scorer PRs.
//
// Matches files named `resilience-ranking-live-pre-repair-<date>.json`
// (the PR 0 freeze) or `resilience-ranking-live-post-<pr>-<date>.json`
// (later PR captures). Returns null if no baseline is present — the
// caller then skips the baselineComparison block rather than failing.
function loadMostRecentBaselineSnapshot() {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  let entries;
  try {
    entries = readdirSync(SNAPSHOT_DIR);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((name) => /^resilience-ranking-(live-pre-repair|live-post-.*)-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  if (candidates.length === 0) return null;
  const latest = candidates.at(-1);
  const raw = readFileSync(path.join(SNAPSHOT_DIR, latest), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.items)) return null;
  return {
    filename: latest,
    capturedAt: parsed.capturedAt,
    commitSha: parsed.commitSha,
    scoresByCountry: Object.fromEntries(
      parsed.items.map((item) => [item.countryCode, item.overallScore]),
    ),
    greyedOutCountries: new Set((parsed.greyedOut ?? []).map((g) => g.countryCode)),
  };
}

function spearmanCorrelation(ranksA, ranksB) {
  const keys = Object.keys(ranksA).filter((k) => k in ranksB);
  const n = keys.length;
  if (n < 2) return 1;
  const dSqSum = keys.reduce((s, k) => s + (ranksA[k] - ranksB[k]) ** 2, 0);
  return 1 - (6 * dSqSum) / (n * (n * n - 1));
}

// Per-indicator extraction. Acceptance gate 8 in the plan requires
// effective-influence-by-INDICATOR (not by dimension), so the harness
// must peek inside each scorer's input data to correlate individual
// indicators with the overall score. Covers the twelve indicators the
// repair plan specifically names as construct-risk (energy mix shares,
// electricityConsumption, energy import dependency, WGI mean,
// reserveMonths, and the four recovery-fiscal indicators). Additional
// indicators can be added to this map in PR 0.5 follow-ups.
async function extractIndicatorValues(countryCode, reader) {
  const [staticRecord, energyMix, fiscalSpace, reserveAdequacy, externalDebt, importHhi] = await Promise.all([
    reader(`resilience:static:${countryCode}`),
    reader(`energy:mix:v1:${countryCode}`),
    reader('resilience:recovery:fiscal-space:v1'),
    reader('resilience:recovery:reserve-adequacy:v1'),
    reader('resilience:recovery:external-debt:v1'),
    reader('resilience:recovery:import-hhi:v1'),
  ]);

  const fiscalEntry = (fiscalSpace?.countries ?? {})[countryCode] ?? null;
  const reserveEntry = (reserveAdequacy?.countries ?? {})[countryCode] ?? null;
  const debtEntry = (externalDebt?.countries ?? {})[countryCode] ?? null;
  const hhiEntry = (importHhi?.countries ?? {})[countryCode] ?? null;

  const wgiValues = Object.values(staticRecord?.wgi?.indicators ?? {})
    .map((entry) => (typeof entry?.value === 'number' ? entry.value : null))
    .filter((v) => v != null);
  const wgiMean = wgiValues.length > 0
    ? wgiValues.reduce((s, v) => s + v, 0) / wgiValues.length
    : null;

  return {
    // Energy indicators — four of the six indicators PR 1 §3.1–§3.2
    // explicitly overturns or re-bases. Per-indicator influence here
    // gives PR 1 the baseline for the effective-influence comparison
    // acceptance gate 8 requires.
    gasShare: typeof energyMix?.gasShare === 'number' ? energyMix.gasShare : null,
    coalShare: typeof energyMix?.coalShare === 'number' ? energyMix.coalShare : null,
    renewShare: typeof energyMix?.renewShare === 'number' ? energyMix.renewShare : null,
    electricityConsumption: staticRecord?.infrastructure?.indicators?.['EG.USE.ELEC.KH.PC']?.value ?? null,
    energyImportDependency: staticRecord?.iea?.energyImportDependency?.value ?? null,
    // Governance signal — high nominal weight, needs to show commensurate
    // effective influence in the baseline.
    wgiMean,
    // Recovery-fiscal indicators — Japan-debt construct problem (§4.4)
    // and external-debt saturation (§4.3) both depend on these showing
    // up in the per-indicator baseline so PR 3 / PR 4 can detect
    // their fixes.
    govRevenuePct: fiscalEntry?.govRevenuePct ?? null,
    fiscalBalancePct: fiscalEntry?.fiscalBalancePct ?? null,
    debtToGdpPct: fiscalEntry?.debtToGdpPct ?? null,
    reserveMonths: reserveEntry?.reserveMonths ?? null,
    debtToReservesRatio: debtEntry?.debtToReservesRatio ?? null,
    importHhi: hhiEntry?.hhi ?? null,
  };
}

// Pearson correlation across two equal-length arrays. Used for
// variable-influence baseline per acceptance gate 8 in the v3 plan.
function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom > 0 ? num / denom : 0;
}

async function main() {
  const {
    scoreAllDimensions,
    RESILIENCE_DIMENSION_ORDER,
    RESILIENCE_DIMENSION_DOMAINS,
    getResilienceDomainWeight,
    RESILIENCE_DOMAIN_ORDER,
    createMemoizedSeedReader,
  } = await import('../server/worldmonitor/resilience/v1/_dimension-scorers.ts');

  const {
    listScorableCountries,
    PENALTY_ALPHA,
    penalizedPillarScore,
  } = await import('../server/worldmonitor/resilience/v1/_shared.ts');

  const {
    buildPillarList,
    PILLAR_ORDER,
    PILLAR_WEIGHTS,
  } = await import('../server/worldmonitor/resilience/v1/_pillar-membership.ts');

  const domainWeights = {};
  for (const domainId of RESILIENCE_DOMAIN_ORDER) {
    domainWeights[domainId] = getResilienceDomainWeight(domainId);
  }

  const scorableCountries = await listScorableCountries();
  const validSample = SAMPLE.filter((c) => scorableCountries.includes(c));

  // Load the frozen pre-PR-0 baseline before scoring so we can compute
  // baseline-delta gates (acceptance gates 2, 6, 7). If no baseline
  // exists yet (first run under PR 0), we still emit the comparison
  // output but mark the baselineComparison block `unavailable` so the
  // caller can detect missing-baseline vs passed-baseline.
  const baseline = loadMostRecentBaselineSnapshot();

  const sharedReader = createMemoizedSeedReader();
  const rows = [];
  // Per-indicator value collection across the sample. Filled in the
  // scoring loop so we don't open two passes over the country list.
  const perIndicatorValues = {};

  for (const countryCode of validSample) {
    const scoreMap = await scoreAllDimensions(countryCode, sharedReader);

    const indicatorValues = await extractIndicatorValues(countryCode, sharedReader);
    for (const [indicator, value] of Object.entries(indicatorValues)) {
      if (value == null || !Number.isFinite(value)) continue;
      (perIndicatorValues[indicator] ??= []).push({ countryCode, value });
    }

    // Build the same ResilienceDimension shape production uses. Only
    // `id`, `score`, and `coverage` are read by buildDomainList /
    // buildPillarList, but pass the other fields too for fidelity with
    // the production payload (empty strings / zeros are fine here
    // because the pillar aggregation does not touch them).
    const dimensions = RESILIENCE_DIMENSION_ORDER.map((dimId) => ({
      id: dimId,
      score: scoreMap[dimId].score,
      coverage: scoreMap[dimId].coverage,
      observedWeight: scoreMap[dimId].observedWeight ?? 0,
      imputedWeight: scoreMap[dimId].imputedWeight ?? 0,
      imputationClass: scoreMap[dimId].imputationClass ?? '',
      freshness: { lastObservedAtMs: '0', staleness: '' },
    }));

    // Build domains and pillars with the EXACT production aggregation.
    const domains = buildDomainList(
      dimensions,
      RESILIENCE_DIMENSION_DOMAINS,
      RESILIENCE_DOMAIN_ORDER,
      getResilienceDomainWeight,
    );

    // Current production overallScore: Σ domain.score * domain.weight
    // (pre-round `domains[*].score` matches the value used inside
    // production's `buildResilienceScore` where the reduce operates on
    // the rounded domain-list scores).
    const currentOverall = domains.reduce(
      (sum, d) => sum + d.score * d.weight,
      0,
    );

    // Production pillar shape: coverage-weighted by average dimension
    // coverage per member domain, not by the static domain weights.
    // This is the material correction vs the earlier comparison script.
    const pillars = buildPillarList(domains, true);

    // Proposed overallScore: Σ pillar.score * pillar.weight × (1 − α(1 − min/100))
    const proposedOverall = penalizedPillarScore(
      pillars.map((p) => ({ score: p.score, weight: p.weight })),
    );

    const pillarById = Object.fromEntries(pillars.map((p) => [p.id, p.score]));

    // Retain per-dimension scores on the row so the variable-influence
    // pass below can correlate each dimension's cross-country variance
    // against overall score (acceptance gate 8 baseline).
    const dimensionScores = Object.fromEntries(
      dimensions.map((d) => [d.id, d.score]),
    );

    rows.push({
      countryCode,
      currentOverallScore: Math.round(currentOverall * 100) / 100,
      proposedOverallScore: Math.round(proposedOverall * 100) / 100,
      scoreDelta: Math.round((proposedOverall - currentOverall) * 100) / 100,
      dimensionScores,
      pillars: {
        structuralReadiness: Math.round((pillarById['structural-readiness'] ?? 0) * 100) / 100,
        liveShockExposure: Math.round((pillarById['live-shock-exposure'] ?? 0) * 100) / 100,
        recoveryCapacity: Math.round((pillarById['recovery-capacity'] ?? 0) * 100) / 100,
        minPillar: Math.round(Math.min(...pillars.map((p) => p.score)) * 100) / 100,
      },
    });
  }

  const currentScoresMap = Object.fromEntries(rows.map((r) => [r.countryCode, r.currentOverallScore]));
  const proposedScoresMap = Object.fromEntries(rows.map((r) => [r.countryCode, r.proposedOverallScore]));

  const currentRanks = rankCountries(currentScoresMap);
  const proposedRanks = rankCountries(proposedScoresMap);

  for (const row of rows) {
    row.currentRank = currentRanks[row.countryCode];
    row.proposedRank = proposedRanks[row.countryCode];
    row.rankDelta = row.proposedRank - row.currentRank; // + means dropped, − means climbed
    row.rankAbsDelta = Math.abs(row.rankDelta);
  }

  const spearman = spearmanCorrelation(currentRanks, proposedRanks);

  // Top movers by absolute rank change, breaking ties by absolute score delta.
  const topMovers = [...rows]
    .sort((a, b) =>
      b.rankAbsDelta - a.rankAbsDelta ||
      Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta),
    )
    .slice(0, 10);

  const biggestScoreDrops = [...rows].sort((a, b) => a.scoreDelta - b.scoreDelta).slice(0, 5);
  const biggestScoreClimbs = [...rows].sort((a, b) => b.scoreDelta - a.scoreDelta).slice(0, 5);

  const meanScoreDelta = rows.reduce((s, r) => s + r.scoreDelta, 0) / rows.length;
  const meanAbsScoreDelta = rows.reduce((s, r) => s + Math.abs(r.scoreDelta), 0) / rows.length;
  const maxRankAbsDelta = Math.max(...rows.map((r) => r.rankAbsDelta));

  // Cohort + matched-pair summaries (PR 0 fairness-audit harness).
  // RESILIENCE_COHORTS and MATCHED_PAIRS are imported at the top of
  // this module so the SAMPLE union can include every cohort member
  // and every matched-pair endpoint — see the comment on SAMPLE above.
  const rowsByCc = new Map(rows.map((r) => [r.countryCode, r]));

  function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  const cohortSummary = RESILIENCE_COHORTS.map((cohort) => {
    const members = cohort.countryCodes
      .map((cc) => rowsByCc.get(cc))
      .filter((r) => r != null);
    if (members.length === 0) {
      return { cohortId: cohort.id, inSample: 0, skipped: true };
    }
    const deltas = members.map((m) => m.scoreDelta);
    const rankDeltas = members.map((m) => m.rankDelta);
    const sortedByDelta = [...members].sort((a, b) => b.scoreDelta - a.scoreDelta);
    return {
      cohortId: cohort.id,
      label: cohort.label,
      inSample: members.length,
      medianScoreDelta: Math.round(median(deltas) * 100) / 100,
      medianAbsScoreDelta: Math.round(median(deltas.map((d) => Math.abs(d))) * 100) / 100,
      maxRankAbsDelta: Math.max(...rankDeltas.map((d) => Math.abs(d))),
      biggestClimber: sortedByDelta[0] != null
        ? { countryCode: sortedByDelta[0].countryCode, scoreDelta: sortedByDelta[0].scoreDelta, rankDelta: sortedByDelta[0].rankDelta }
        : null,
      biggestDrop: sortedByDelta.at(-1) != null
        ? { countryCode: sortedByDelta.at(-1).countryCode, scoreDelta: sortedByDelta.at(-1).scoreDelta, rankDelta: sortedByDelta.at(-1).rankDelta }
        : null,
      middleMover: sortedByDelta[Math.floor(sortedByDelta.length / 2)] != null
        ? {
            countryCode: sortedByDelta[Math.floor(sortedByDelta.length / 2)].countryCode,
            scoreDelta: sortedByDelta[Math.floor(sortedByDelta.length / 2)].scoreDelta,
            rankDelta: sortedByDelta[Math.floor(sortedByDelta.length / 2)].rankDelta,
          }
        : null,
    };
  });

  const matchedPairSummary = MATCHED_PAIRS.map((pair) => {
    const higher = rowsByCc.get(pair.higherExpected);
    const lower = rowsByCc.get(pair.lowerExpected);
    if (!higher || !lower) {
      return { pairId: pair.id, skipped: true, reason: `pair member missing from sample: ${!higher ? pair.higherExpected : pair.lowerExpected}` };
    }
    const minGap = pair.minGap ?? 3;
    const currentGap = higher.currentOverallScore - lower.currentOverallScore;
    const proposedGap = higher.proposedOverallScore - lower.proposedOverallScore;
    const expectedDirectionHeld = proposedGap > 0;
    const gapAtLeastMin = proposedGap >= minGap;
    return {
      pairId: pair.id,
      axis: pair.axis,
      higherExpected: pair.higherExpected,
      lowerExpected: pair.lowerExpected,
      minGap,
      currentGap: Math.round(currentGap * 100) / 100,
      proposedGap: Math.round(proposedGap * 100) / 100,
      expectedDirectionHeld,
      gapAtLeastMin,
      // Gate: if either flag is false, this pair fails the matched-pair
      // acceptance check and the PR stops.
      passes: expectedDirectionHeld && gapAtLeastMin,
    };
  });

  const matchedPairFailures = matchedPairSummary.filter((p) => !p.skipped && !p.passes);

  // Variable-influence baseline (Pearson-derivative approximation of
  // Sobol indices). For every dimension, measures the cross-country
  // Pearson correlation between that dimension's score and the current
  // overall score, scaled by the dimension's nominal domain weight.
  // The scaled correlation is a proxy for "effective influence" —
  // acceptance gate 8 requires that after any scorer change the
  // measured effective-influence agree in sign and rank-order with
  // the assigned nominal weights. Indicators that nominal-weight as
  // material but measured-effective-influence as near-zero flag a
  // construct problem (the indicator carries weight but drives no
  // variance — classic wealth-proxy or saturated-signal behaviour).
  //
  // A full Sobol implementation is a PR 0.5 follow-up; this Pearson-
  // derivative is sufficient to produce the per-indicator baseline
  // the plan's acceptance gates require.
  const currentOverallArr = rows.map((r) => r.currentOverallScore);
  const variableInfluence = RESILIENCE_DIMENSION_ORDER.map((dimId) => {
    const domainId = RESILIENCE_DIMENSION_DOMAINS[dimId];
    const domainWeight = domainWeights[domainId] ?? 0;
    const dimScoresArr = rows.map((r) => r.dimensionScores[dimId] ?? 0);
    const correlation = pearsonCorrelation(dimScoresArr, currentOverallArr);
    // Normalize: the influence is the correlation × domain weight.
    // We don't know the intra-domain weight here without re-threading
    // the full indicator registry, so this is a domain-level proxy —
    // sufficient for the construct-problem detector described above.
    const influence = correlation * domainWeight;
    const dimScoreMean = dimScoresArr.reduce((s, v) => s + v, 0) / dimScoresArr.length;
    const dimScoreVariance = dimScoresArr.reduce((s, v) => s + (v - dimScoreMean) ** 2, 0) / dimScoresArr.length;
    return {
      dimensionId: dimId,
      domainId,
      nominalDomainWeight: domainWeight,
      pearsonVsOverall: Math.round(correlation * 10000) / 10000,
      effectiveInfluence: Math.round(influence * 10000) / 10000,
      dimScoreMean: Math.round(dimScoreMean * 100) / 100,
      dimScoreVariance: Math.round(dimScoreVariance * 100) / 100,
    };
  });
  // Sort by effective influence desc so the report shows the biggest
  // drivers first.
  variableInfluence.sort((a, b) => Math.abs(b.effectiveInfluence) - Math.abs(a.effectiveInfluence));

  // Per-indicator effective influence. Acceptance gate 8 requires the
  // comparison to distinguish between "dimension is highly correlated
  // because its inputs matter" and "dimension is highly correlated
  // because ONE wealth-proxy input dominates". We therefore also
  // correlate each individual indicator with the current overall
  // score. Countries with a null reading are dropped pairwise per
  // indicator, so indicators with sparse coverage still get reported
  // but carry a `pairedSampleSize` field callers can gate on.
  const scoreByCc = new Map(rows.map((r) => [r.countryCode, r.currentOverallScore]));
  const perIndicatorInfluence = Object.entries(perIndicatorValues).map(
    ([indicator, observations]) => {
      const xs = [];
      const ys = [];
      for (const { countryCode, value } of observations) {
        const overall = scoreByCc.get(countryCode);
        if (overall == null) continue;
        xs.push(value);
        ys.push(overall);
      }
      const correlation = pearsonCorrelation(xs, ys);
      return {
        indicator,
        pairedSampleSize: xs.length,
        pearsonVsOverall: Math.round(correlation * 10000) / 10000,
        effectiveInfluence: Math.round(correlation * 10000) / 10000,
      };
    },
  );
  perIndicatorInfluence.sort(
    (a, b) => Math.abs(b.effectiveInfluence) - Math.abs(a.effectiveInfluence),
  );

  // Baseline comparison. Compares today's currentOverallScore against
  // the locked baseline snapshot the plan pins for acceptance gates 2,
  // 6, and 7. If no baseline exists (first PR 0 run), emit an explicit
  // `unavailable` marker so downstream acceptance tooling can detect
  // the state difference rather than treating it as a pass.
  let baselineComparison;
  if (!baseline) {
    baselineComparison = {
      status: 'unavailable',
      reason:
        'No baseline snapshot found in docs/snapshots/. Expected resilience-ranking-live-pre-repair-<date>.json from PR 0 freeze.',
    };
  } else {
    const baselineScores = baseline.scoresByCountry;
    const overlapping = rows
      .map((r) => ({
        countryCode: r.countryCode,
        currentOverallScore: r.currentOverallScore,
        baselineOverallScore: baselineScores[r.countryCode],
      }))
      .filter((r) => typeof r.baselineOverallScore === 'number');

    const scoreDrifts = overlapping.map((r) => ({
      countryCode: r.countryCode,
      currentOverallScore: r.currentOverallScore,
      baselineOverallScore: Math.round(r.baselineOverallScore * 100) / 100,
      scoreDelta: Math.round((r.currentOverallScore - r.baselineOverallScore) * 100) / 100,
      scoreAbsDelta: Math.abs(Math.round((r.currentOverallScore - r.baselineOverallScore) * 100) / 100),
    }));

    const maxCountryAbsDelta = scoreDrifts.reduce((max, d) => Math.max(max, d.scoreAbsDelta), 0);
    const biggestDrifts = [...scoreDrifts]
      .sort((a, b) => b.scoreAbsDelta - a.scoreAbsDelta)
      .slice(0, 10);

    // Spearman vs baseline over the overlap (both ranking universes
    // restricted to the shared country set so newly-added or newly-
    // removed countries can't skew the correlation).
    const currentOverlap = Object.fromEntries(
      overlapping.map((r) => [r.countryCode, r.currentOverallScore]),
    );
    const baselineOverlap = Object.fromEntries(
      overlapping.map((r) => [r.countryCode, r.baselineOverallScore]),
    );
    const spearmanVsBaseline = spearmanCorrelation(
      rankCountries(currentOverlap),
      rankCountries(baselineOverlap),
    );

    // Cohort median shift vs baseline (the plan's effective cohort
    // gate). A cohort whose median score has drifted by more than the
    // plan's +/-5 tolerance flags for audit even if Spearman looks fine.
    const cohortShiftVsBaseline = RESILIENCE_COHORTS.map((cohort) => {
      const members = cohort.countryCodes
        .map((cc) => {
          const row = rowsByCc.get(cc);
          const base = baselineScores[cc];
          if (!row || typeof base !== 'number') return null;
          return { countryCode: cc, delta: row.currentOverallScore - base };
        })
        .filter((m) => m != null);
      if (members.length === 0) {
        return { cohortId: cohort.id, inSample: 0, skipped: true };
      }
      return {
        cohortId: cohort.id,
        label: cohort.label,
        inSample: members.length,
        medianScoreDeltaVsBaseline: Math.round(median(members.map((m) => m.delta)) * 100) / 100,
      };
    });

    // Matched-pair gap change vs baseline. For each pair, compare the
    // higher-minus-lower gap today against the same gap in the frozen
    // baseline so construct changes that reverse a pair can be flagged
    // explicitly (the matched-pair table above is current-vs-proposed;
    // this block is current-vs-baseline).
    const matchedPairGapChange = MATCHED_PAIRS.map((pair) => {
      const higherBase = baselineScores[pair.higherExpected];
      const lowerBase = baselineScores[pair.lowerExpected];
      const higher = rowsByCc.get(pair.higherExpected);
      const lower = rowsByCc.get(pair.lowerExpected);
      if (
        typeof higherBase !== 'number' ||
        typeof lowerBase !== 'number' ||
        !higher ||
        !lower
      ) {
        return { pairId: pair.id, skipped: true };
      }
      const baselineGap = higherBase - lowerBase;
      const currentGap = higher.currentOverallScore - lower.currentOverallScore;
      return {
        pairId: pair.id,
        axis: pair.axis,
        baselineGap: Math.round(baselineGap * 100) / 100,
        currentGap: Math.round(currentGap * 100) / 100,
        gapChange: Math.round((currentGap - baselineGap) * 100) / 100,
      };
    });

    baselineComparison = {
      status: 'ok',
      baselineFile: baseline.filename,
      baselineCapturedAt: baseline.capturedAt,
      baselineCommitSha: baseline.commitSha,
      overlapSize: overlapping.length,
      spearmanVsBaseline: Math.round(spearmanVsBaseline * 10000) / 10000,
      maxCountryAbsDelta: Math.round(maxCountryAbsDelta * 100) / 100,
      biggestDriftsVsBaseline: biggestDrifts,
      cohortShiftVsBaseline,
      matchedPairGapChange,
    };
  }

  const output = {
    comparison: 'currentDomainAggregate_vs_proposedPillarCombined',
    penaltyAlpha: PENALTY_ALPHA,
    pillarWeights: PILLAR_WEIGHTS,
    domainWeights,
    sampleSize: rows.length,
    sampleCountries: rows.map((r) => r.countryCode),
    summary: {
      spearmanRankCorrelation: Math.round(spearman * 10000) / 10000,
      meanScoreDelta: Math.round(meanScoreDelta * 100) / 100,
      meanAbsScoreDelta: Math.round(meanAbsScoreDelta * 100) / 100,
      maxRankAbsDelta,
      matchedPairFailures: matchedPairFailures.length,
    },
    baselineComparison,
    cohortSummary,
    matchedPairSummary,
    variableInfluence,
    perIndicatorInfluence,
    topMoversByRank: topMovers.map((r) => ({
      countryCode: r.countryCode,
      currentRank: r.currentRank,
      proposedRank: r.proposedRank,
      rankDelta: r.rankDelta,
      currentOverallScore: r.currentOverallScore,
      proposedOverallScore: r.proposedOverallScore,
      scoreDelta: r.scoreDelta,
      pillars: r.pillars,
    })),
    biggestScoreDrops: biggestScoreDrops.map((r) => ({
      countryCode: r.countryCode,
      scoreDelta: r.scoreDelta,
      currentOverallScore: r.currentOverallScore,
      proposedOverallScore: r.proposedOverallScore,
      rankDelta: r.rankDelta,
    })),
    biggestScoreClimbs: biggestScoreClimbs.map((r) => ({
      countryCode: r.countryCode,
      scoreDelta: r.scoreDelta,
      currentOverallScore: r.currentOverallScore,
      proposedOverallScore: r.proposedOverallScore,
      rankDelta: r.rankDelta,
    })),
    fullSample: rows,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  console.error('[compare-resilience-current-vs-proposed] failed:', err);
  process.exit(1);
});
