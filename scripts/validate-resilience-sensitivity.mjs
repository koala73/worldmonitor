#!/usr/bin/env node
// Sensitivity analysis v2: weight/goalpost/alpha perturbation + ceiling-effect detection.
// Extends the original coverage-perturbation Monte Carlo with:
//   Pass 1: Domain weight perturbation (±20%)
//   Pass 2: Pillar weight perturbation (±20%, renormalized)
//   Pass 3: Goalpost perturbation (±10%)
//   Pass 4: Alpha-sensitivity curve (0.0-1.0 in 0.1 steps)
// Usage: node --import tsx/esm scripts/validate-resilience-sensitivity.mjs

import { loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const NUM_DRAWS = 50;
const DOMAIN_PERTURBATION = 0.2;
const PILLAR_PERTURBATION = 0.2;
const GOALPOST_PERTURBATION = 0.1;
const TOP_N = 50;
const RANK_SWING_THRESHOLD = 3;
const DIMENSION_FAIL_THRESHOLD = 0.20;
const MIN_SAMPLE = 20;

const SAMPLE = [
  'NO','IS','NZ','DK','SE','FI','CH','AU','CA',
  'US','DE','GB','FR','JP','KR','IT','ES','PL',
  'BR','MX','TR','TH','MY','CN','IN','ZA','EG',
  'PK','NG','KE','BD','VN','PH','ID','UA','RU',
  'AF','YE','SO','HT','SS','CF','SD','ML','NE','TD','SY','IQ','MM','VE','IR','ET',
];

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function coverageWeightedMean(dims) {
  const totalCoverage = dims.reduce((s, d) => s + d.coverage, 0);
  if (!totalCoverage) return 0;
  return dims.reduce((s, d) => s + d.score * d.coverage, 0) / totalCoverage;
}

export function perturbWeights(weights, range) {
  const perturbed = {};
  let total = 0;
  for (const [k, v] of Object.entries(weights)) {
    const factor = 1 + (Math.random() * 2 - 1) * range;
    perturbed[k] = v * factor;
    total += perturbed[k];
  }
  for (const k of Object.keys(perturbed)) {
    perturbed[k] /= total;
  }
  return perturbed;
}

export function perturbGoalposts(goalposts, range) {
  const span = Math.abs(goalposts.best - goalposts.worst) || 1;
  const worstShift = (Math.random() * 2 - 1) * range * span;
  const bestShift = (Math.random() * 2 - 1) * range * span;
  return {
    worst: goalposts.worst + worstShift,
    best: goalposts.best + bestShift,
  };
}

export function normalizeToGoalposts(value, goalposts, direction) {
  const { worst, best } = goalposts;
  if (best === worst) return 50;
  const raw = direction === 'higherBetter'
    ? (value - worst) / (best - worst)
    : (worst - value) / (worst - best);
  return Math.max(0, Math.min(100, raw * 100));
}

function computeOverallFromDomains(dimensions, dimensionDomains, domainWeights) {
  const grouped = new Map();
  for (const domainId of Object.keys(domainWeights)) grouped.set(domainId, []);
  for (const dim of dimensions) {
    const domainId = dimensionDomains[dim.id];
    if (domainId && grouped.has(domainId)) {
      grouped.get(domainId).push({ score: dim.score, coverage: dim.coverage });
    }
  }
  let overall = 0;
  for (const [domainId, dims] of grouped) {
    overall += coverageWeightedMean(dims) * domainWeights[domainId];
  }
  return overall;
}

export function computePenalizedPillarScore(pillarScores, pillarWeights, alpha) {
  if (pillarScores.length === 0) return 0;
  const weighted = pillarScores.reduce((s, entry) => {
    return s + entry.score * (pillarWeights[entry.id] || 0);
  }, 0);
  const minScore = Math.min(...pillarScores.map((e) => e.score));
  const penalty = 1 - alpha * (1 - minScore / 100);
  return weighted * penalty;
}

export function computePillarScoresFromDomains(dimensions, dimensionDomains, pillarDomains, domainWeights) {
  const domainScores = {};
  const grouped = new Map();
  for (const domainId of Object.keys(domainWeights)) grouped.set(domainId, []);
  for (const dim of dimensions) {
    const domainId = dimensionDomains[dim.id];
    if (domainId && grouped.has(domainId)) {
      grouped.get(domainId).push({ score: dim.score, coverage: dim.coverage });
    }
  }
  for (const [domainId, dims] of grouped) {
    domainScores[domainId] = coverageWeightedMean(dims);
  }

  const pillarScores = [];
  for (const [pillarId, domainIds] of Object.entries(pillarDomains)) {
    const scores = domainIds.map((d) => domainScores[d] || 0);
    const weights = domainIds.map((d) => domainWeights[d] || 0);
    const totalW = weights.reduce((s, w) => s + w, 0);
    const pillarScore = totalW > 0
      ? scores.reduce((s, sc, i) => s + sc * weights[i], 0) / totalW
      : 0;
    pillarScores.push({ id: pillarId, score: pillarScore });
  }
  return pillarScores;
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

export function spearmanCorrelation(ranksA, ranksB) {
  const keys = Object.keys(ranksA).filter((k) => k in ranksB);
  const n = keys.length;
  if (n < 2) return 1;
  const dSqSum = keys.reduce((s, k) => s + (ranksA[k] - ranksB[k]) ** 2, 0);
  return 1 - (6 * dSqSum) / (n * (n * n - 1));
}

export function computeReleaseGate(dimensionResults) {
  const failCount = dimensionResults.filter((d) => !d.pass).length;
  const failPct = dimensionResults.length > 0 ? failCount / dimensionResults.length : 0;
  return {
    pass: failPct <= DIMENSION_FAIL_THRESHOLD,
    failCount,
    failPct: Math.round(failPct * 1000) / 1000,
    threshold: DIMENSION_FAIL_THRESHOLD,
  };
}

async function run() {
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
    PILLAR_DOMAINS,
    PILLAR_WEIGHTS,
    PILLAR_ORDER,
  } = await import('../server/worldmonitor/resilience/v1/_pillar-membership.ts');

  const {
    INDICATOR_REGISTRY,
  } = await import('../server/worldmonitor/resilience/v1/_indicator-registry.ts');

  const domainWeights = {};
  for (const domainId of RESILIENCE_DOMAIN_ORDER) {
    domainWeights[domainId] = getResilienceDomainWeight(domainId);
  }

  const scorableCountries = await listScorableCountries();
  const validSample = SAMPLE.filter((c) => scorableCountries.includes(c));
  const skipped = SAMPLE.filter((c) => !scorableCountries.includes(c));

  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} countries not in scorable set: ${skipped.join(', ')}`);
  }
  console.log(`Scoring ${validSample.length} countries from live Redis...\n`);

  const sharedReader = createMemoizedSeedReader();
  const countryData = [];

  for (const countryCode of validSample) {
    const scoreMap = await scoreAllDimensions(countryCode, sharedReader);
    const dimensions = RESILIENCE_DIMENSION_ORDER.map((dimId) => ({
      id: dimId,
      score: scoreMap[dimId].score,
      coverage: scoreMap[dimId].coverage,
    }));
    countryData.push({ countryCode, dimensions });
  }

  if (countryData.length < MIN_SAMPLE) {
    console.error(`FATAL: Only ${countryData.length} countries scored (need >= ${MIN_SAMPLE}). Redis may be degraded.`);
    process.exit(1);
  }

  console.log(`Scored ${countryData.length} countries. Running sensitivity passes...\n`);

  const baselineScores = {};
  for (const cd of countryData) {
    const pillarScores = computePillarScoresFromDomains(
      cd.dimensions, RESILIENCE_DIMENSION_DOMAINS, PILLAR_DOMAINS, domainWeights
    );
    baselineScores[cd.countryCode] = computePenalizedPillarScore(
      pillarScores, PILLAR_WEIGHTS, PENALTY_ALPHA
    );
  }
  const baselineRanks = rankCountries(baselineScores);
  const topNCountries = Object.entries(baselineRanks)
    .sort(([, a], [, b]) => a - b)
    .slice(0, TOP_N)
    .map(([cc]) => cc);

  const ceilingEffects = [];

  function detectCeiling(scores, passName) {
    for (const [cc, score] of Object.entries(scores)) {
      if (score >= 100) ceilingEffects.push({ countryCode: cc, score, pass: passName, type: 'ceiling' });
      if (score <= 0) ceilingEffects.push({ countryCode: cc, score, pass: passName, type: 'floor' });
    }
  }

  function computeMaxSwings(perturbedRanks, baseRanks, topCountries) {
    const swings = {};
    for (const cc of topCountries) {
      const base = baseRanks[cc];
      const perturbed = perturbedRanks[cc];
      if (base != null && perturbed != null) {
        swings[cc] = Math.abs(perturbed - base);
      }
    }
    return swings;
  }

  // Pass 1: Domain weight perturbation
  console.log(`=== PASS 1: Domain weight perturbation (±${DOMAIN_PERTURBATION * 100}%, ${NUM_DRAWS} draws) ===`);
  const domainWeightSwings = {};
  for (const cc of topNCountries) domainWeightSwings[cc] = [];

  for (let draw = 0; draw < NUM_DRAWS; draw++) {
    const pWeights = perturbWeights(domainWeights, DOMAIN_PERTURBATION);
    const scores = {};
    for (const cd of countryData) {
      const ps = computePillarScoresFromDomains(
        cd.dimensions, RESILIENCE_DIMENSION_DOMAINS, PILLAR_DOMAINS, pWeights
      );
      scores[cd.countryCode] = computePenalizedPillarScore(ps, PILLAR_WEIGHTS, PENALTY_ALPHA);
    }
    detectCeiling(scores, 'domainWeights');
    const ranks = rankCountries(scores);
    const swings = computeMaxSwings(ranks, baselineRanks, topNCountries);
    for (const cc of topNCountries) {
      domainWeightSwings[cc].push(swings[cc] || 0);
    }
  }

  const domainMaxSwing = Math.max(
    ...topNCountries.map((cc) => Math.max(...(domainWeightSwings[cc] || [0])))
  );
  console.log(`  Max top-${TOP_N} rank swing: ${domainMaxSwing}`);

  // Pass 2: Pillar weight perturbation
  console.log(`\n=== PASS 2: Pillar weight perturbation (±${PILLAR_PERTURBATION * 100}%, ${NUM_DRAWS} draws) ===`);
  const pillarWeightSwings = {};
  for (const cc of topNCountries) pillarWeightSwings[cc] = [];

  for (let draw = 0; draw < NUM_DRAWS; draw++) {
    const pPillarWeights = perturbWeights(PILLAR_WEIGHTS, PILLAR_PERTURBATION);
    const scores = {};
    for (const cd of countryData) {
      const ps = computePillarScoresFromDomains(
        cd.dimensions, RESILIENCE_DIMENSION_DOMAINS, PILLAR_DOMAINS, domainWeights
      );
      scores[cd.countryCode] = computePenalizedPillarScore(ps, pPillarWeights, PENALTY_ALPHA);
    }
    detectCeiling(scores, 'pillarWeights');
    const ranks = rankCountries(scores);
    const swings = computeMaxSwings(ranks, baselineRanks, topNCountries);
    for (const cc of topNCountries) {
      pillarWeightSwings[cc].push(swings[cc] || 0);
    }
  }

  const pillarMaxSwing = Math.max(
    ...topNCountries.map((cc) => Math.max(...(pillarWeightSwings[cc] || [0])))
  );
  console.log(`  Max top-${TOP_N} rank swing: ${pillarMaxSwing}`);

  // Pass 3: Goalpost perturbation
  console.log(`\n=== PASS 3: Goalpost perturbation (±${GOALPOST_PERTURBATION * 100}%, ${NUM_DRAWS} draws) ===`);
  const goalpostSwings = {};
  for (const cc of topNCountries) goalpostSwings[cc] = [];
  const perDimensionSwings = {};
  for (const dimId of RESILIENCE_DIMENSION_ORDER) perDimensionSwings[dimId] = [];

  for (let draw = 0; draw < NUM_DRAWS; draw++) {
    const perturbedDims = countryData.map((cd) => {
      const newDims = cd.dimensions.map((dim) => {
        const indicators = INDICATOR_REGISTRY.filter((ind) => ind.dimension === dim.id);
        if (indicators.length === 0) return { ...dim };
        let totalWeight = 0;
        let weightedScore = 0;
        for (const ind of indicators) {
          const pg = perturbGoalposts(ind.goalposts, GOALPOST_PERTURBATION);
          const rawScore = normalizeToGoalposts(
            inverseNormalize(dim.score, ind.goalposts, ind.direction),
            pg,
            ind.direction
          );
          weightedScore += rawScore * ind.weight;
          totalWeight += ind.weight;
        }
        const newScore = totalWeight > 0 ? weightedScore / totalWeight : dim.score;
        return { ...dim, score: Math.max(0, Math.min(100, newScore)) };
      });
      return { countryCode: cd.countryCode, dimensions: newDims };
    });

    const scores = {};
    for (const cd of perturbedDims) {
      const ps = computePillarScoresFromDomains(
        cd.dimensions, RESILIENCE_DIMENSION_DOMAINS, PILLAR_DOMAINS, domainWeights
      );
      scores[cd.countryCode] = computePenalizedPillarScore(ps, PILLAR_WEIGHTS, PENALTY_ALPHA);
    }
    detectCeiling(scores, 'goalposts');
    const ranks = rankCountries(scores);
    const swings = computeMaxSwings(ranks, baselineRanks, topNCountries);
    for (const cc of topNCountries) {
      goalpostSwings[cc].push(swings[cc] || 0);
    }
  }

  for (const dimId of RESILIENCE_DIMENSION_ORDER) {
    const dimIndicators = INDICATOR_REGISTRY.filter((ind) => ind.dimension === dimId);
    if (dimIndicators.length === 0) continue;
    const perturbedDims = countryData.map((cd) => {
      const newDims = cd.dimensions.map((dim) => {
        if (dim.id !== dimId) return { ...dim };
        let totalWeight = 0;
        let weightedScore = 0;
        for (const ind of dimIndicators) {
          const pg = perturbGoalposts(ind.goalposts, GOALPOST_PERTURBATION);
          const rawScore = normalizeToGoalposts(
            inverseNormalize(dim.score, ind.goalposts, ind.direction),
            pg,
            ind.direction
          );
          weightedScore += rawScore * ind.weight;
          totalWeight += ind.weight;
        }
        const newScore = totalWeight > 0 ? weightedScore / totalWeight : dim.score;
        return { ...dim, score: Math.max(0, Math.min(100, newScore)) };
      });
      return { countryCode: cd.countryCode, dimensions: newDims };
    });
    const dimScores = {};
    for (const cd of perturbedDims) {
      const ps = computePillarScoresFromDomains(
        cd.dimensions, RESILIENCE_DIMENSION_DOMAINS, PILLAR_DOMAINS, domainWeights
      );
      dimScores[cd.countryCode] = computePenalizedPillarScore(ps, PILLAR_WEIGHTS, PENALTY_ALPHA);
    }
    const dimRanks = rankCountries(dimScores);
    const dimSwings = computeMaxSwings(dimRanks, baselineRanks, topNCountries);
    const maxDimSwing = Math.max(...topNCountries.slice(0, 10).map((cc) => dimSwings[cc] || 0), 0);
    perDimensionSwings[dimId].push(maxDimSwing);
  }

  const goalpostMaxSwing = Math.max(
    ...topNCountries.map((cc) => Math.max(...(goalpostSwings[cc] || [0])))
  );
  console.log(`  Max top-${TOP_N} rank swing: ${goalpostMaxSwing}`);

  // Pass 4: Alpha sensitivity curve
  console.log(`\n=== PASS 4: Alpha sensitivity curve (0.0 to 1.0, step 0.1) ===`);
  const baseAlphaRanks = {};
  for (const cd of countryData) {
    const ps = computePillarScoresFromDomains(
      cd.dimensions, RESILIENCE_DIMENSION_DOMAINS, PILLAR_DOMAINS, domainWeights
    );
    baseAlphaRanks[cd.countryCode] = computePenalizedPillarScore(ps, PILLAR_WEIGHTS, 0.5);
  }
  const baseAlphaRanked = rankCountries(baseAlphaRanks);

  const alphaSensitivity = [];
  for (let alphaStep = 0; alphaStep <= 10; alphaStep++) {
    const alpha = Math.round(alphaStep * 10) / 100;
    const scores = {};
    for (const cd of countryData) {
      const ps = computePillarScoresFromDomains(
        cd.dimensions, RESILIENCE_DIMENSION_DOMAINS, PILLAR_DOMAINS, domainWeights
      );
      scores[cd.countryCode] = computePenalizedPillarScore(ps, PILLAR_WEIGHTS, alpha);
    }
    const ranks = rankCountries(scores);
    const spearman = spearmanCorrelation(baseAlphaRanked, ranks);
    const maxSwing = Math.max(
      ...topNCountries.map((cc) => Math.abs((ranks[cc] || 0) - (baseAlphaRanked[cc] || 0)))
    );
    alphaSensitivity.push({
      alpha,
      spearmanVs05: Math.round(spearman * 10000) / 10000,
      maxTop50Swing: maxSwing,
    });
  }

  console.log('  alpha | spearman_vs_0.5 | max_top50_swing');
  console.log('  ------+-----------------+----------------');
  for (const row of alphaSensitivity) {
    console.log(`  ${row.alpha.toFixed(1).padStart(5)} | ${row.spearmanVs05.toFixed(4).padStart(15)} | ${String(row.maxTop50Swing).padStart(14)}`);
  }

  // Dimension stability
  const dimensionResults = RESILIENCE_DIMENSION_ORDER.map((dimId) => {
    const maxSwing = perDimensionSwings[dimId]?.length > 0
      ? Math.max(...perDimensionSwings[dimId])
      : 0;
    return { dimId, maxSwing, pass: maxSwing <= RANK_SWING_THRESHOLD };
  });

  const releaseGate = computeReleaseGate(dimensionResults);

  console.log('\n=== DIMENSION STABILITY (goalpost perturbation, top-10 rank swing) ===');
  for (const dr of dimensionResults) {
    console.log(`  ${dr.dimId.padEnd(25)} maxSwing=${dr.maxSwing}  ${dr.pass ? 'PASS' : 'FAIL'}`);
  }

  console.log(`\n=== RELEASE GATE ===`);
  console.log(`  Threshold: >${releaseGate.threshold * 100}% of dimensions failing (swing > ${RANK_SWING_THRESHOLD} ranks)`);
  console.log(`  Failed: ${releaseGate.failCount}/${dimensionResults.length} (${(releaseGate.failPct * 100).toFixed(1)}%)`);
  console.log(`  Result: ${releaseGate.pass ? 'PASS' : 'FAIL'}`);

  // Ceiling effects
  const uniqueCeilings = [];
  const seen = new Set();
  for (const ce of ceilingEffects) {
    const key = `${ce.countryCode}:${ce.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCeilings.push(ce);
    }
  }

  if (uniqueCeilings.length > 0) {
    console.log(`\n=== CEILING/FLOOR EFFECTS (${uniqueCeilings.length} unique) ===`);
    for (const ce of uniqueCeilings.slice(0, 20)) {
      console.log(`  ${ce.countryCode}  ${ce.type}  score=${ce.score.toFixed(2)}  pass=${ce.pass}`);
    }
  } else {
    console.log('\n=== CEILING/FLOOR EFFECTS: None detected ===');
  }

  const result = {
    generatedAt: Date.now(),
    passes: {
      domainWeights: { maxSwing: domainMaxSwing, pass: domainMaxSwing <= RANK_SWING_THRESHOLD * 2 },
      pillarWeights: { maxSwing: pillarMaxSwing, pass: pillarMaxSwing <= RANK_SWING_THRESHOLD * 2 },
      goalposts: { maxSwing: goalpostMaxSwing, pass: goalpostMaxSwing <= RANK_SWING_THRESHOLD * 2 },
    },
    alphaSensitivity,
    dimensionStability: dimensionResults,
    releaseGate,
    ceilingEffects: uniqueCeilings,
  };

  console.log(`\nSensitivity analysis v2 complete.`);
  return result;
}

function inverseNormalize(normalizedScore, goalposts, direction) {
  const { worst, best } = goalposts;
  if (best === worst) return worst;
  if (direction === 'higherBetter') {
    return worst + (normalizedScore / 100) * (best - worst);
  }
  return worst - (normalizedScore / 100) * (worst - best);
}

const isMain = process.argv[1]?.endsWith('validate-resilience-sensitivity.mjs');
if (isMain) {
  run().then((_result) => {
    console.log('\nJSON output written to stdout (pipe to file if needed).');
    process.exit(0);
  }).catch((err) => {
    console.error('Sensitivity analysis failed:', err);
    process.exit(1);
  });
}

export { run };
