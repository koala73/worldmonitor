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

loadEnvFile(import.meta.url);

// Same 52-country sample the sensitivity script uses so the two outputs
// are directly comparable.
const SAMPLE = [
  'NO','IS','NZ','DK','SE','FI','CH','AU','CA',
  'US','DE','GB','FR','JP','KR','IT','ES','PL',
  'BR','MX','TR','TH','MY','CN','IN','ZA','EG',
  'PK','NG','KE','BD','VN','PH','ID','UA','RU',
  'AF','YE','SO','HT','SS','CF','SD','ML','NE','TD','SY','IQ','MM','VE','IR','ET',
];

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

function spearmanCorrelation(ranksA, ranksB) {
  const keys = Object.keys(ranksA).filter((k) => k in ranksB);
  const n = keys.length;
  if (n < 2) return 1;
  const dSqSum = keys.reduce((s, k) => s + (ranksA[k] - ranksB[k]) ** 2, 0);
  return 1 - (6 * dSqSum) / (n * (n * n - 1));
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

  const sharedReader = createMemoizedSeedReader();
  const rows = [];

  for (const countryCode of validSample) {
    const scoreMap = await scoreAllDimensions(countryCode, sharedReader);

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

    rows.push({
      countryCode,
      currentOverallScore: Math.round(currentOverall * 100) / 100,
      proposedOverallScore: Math.round(proposedOverall * 100) / 100,
      scoreDelta: Math.round((proposedOverall - currentOverall) * 100) / 100,
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

  // Cohort + matched-pair summaries (PR 0 fairness-audit harness). Imports
  // lazily so the script stays runnable when the configs move/rename.
  const { RESILIENCE_COHORTS } = await import('../tests/helpers/resilience-cohorts.mts');
  const { MATCHED_PAIRS } = await import('../tests/helpers/resilience-matched-pairs.mts');
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
    cohortSummary,
    matchedPairSummary,
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
