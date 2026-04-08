#!/usr/bin/env node
// Weight perturbation Monte Carlo — tests ranking stability under weight variation.
// Usage: node --import tsx/esm scripts/validate-resilience-sensitivity.mjs

import { loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const NUM_DRAWS = 100;
const PERTURBATION_RANGE = 0.1; // ±10%
const STABILITY_GATE_RANKS = 5;

const SAMPLE = [
  // Top tier
  'NO','IS','NZ','DK','SE','FI','CH','AU','CA',
  // High
  'US','DE','GB','FR','JP','KR','IT','ES','PL',
  // Upper-mid
  'BR','MX','TR','TH','MY','CN','IN','ZA','EG',
  // Lower-mid
  'PK','NG','KE','BD','VN','PH','ID','UA','RU',
  // Fragile
  'AF','YE','SO','HT','SS','CF','SD','ML','NE','TD','SY','IQ','MM','VE','IR','ET',
];

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function perturbWeights(domainOrder, getWeight) {
  const raw = {};
  let total = 0;
  for (const domainId of domainOrder) {
    const base = getWeight(domainId);
    const factor = 1 + (Math.random() * 2 - 1) * PERTURBATION_RANGE;
    raw[domainId] = base * factor;
    total += raw[domainId];
  }
  const perturbed = {};
  for (const domainId of domainOrder) {
    perturbed[domainId] = raw[domainId] / total;
  }
  return perturbed;
}

function coverageWeightedMean(dims) {
  const totalCoverage = dims.reduce((s, d) => s + d.coverage, 0);
  if (!totalCoverage) return 0;
  return dims.reduce((s, d) => s + d.score * d.coverage, 0) / totalCoverage;
}

function computeOverallScore(dimensions, perturbedWeights, originalWeights, dimensionDomains, dimensionTypes) {
  const weightRatios = {};
  for (const domainId of Object.keys(originalWeights)) {
    weightRatios[domainId] = (perturbedWeights[domainId] ?? originalWeights[domainId]) / originalWeights[domainId];
  }

  const baselineDims = [];
  const stressDims = [];
  for (const dim of dimensions) {
    const domainId = dimensionDomains[dim.id];
    const scaledCoverage = dim.coverage * (weightRatios[domainId] ?? 1);
    const scaled = { score: dim.score, coverage: scaledCoverage };
    const dimType = dimensionTypes[dim.id];
    if (dimType === 'baseline' || dimType === 'mixed') baselineDims.push(scaled);
    if (dimType === 'stress' || dimType === 'mixed') stressDims.push(scaled);
  }

  const baselineScore = coverageWeightedMean(baselineDims);
  const stressScore = coverageWeightedMean(stressDims);
  const stressFactor = Math.max(0, Math.min(1 - stressScore / 100, 0.5));
  return baselineScore * (1 - stressFactor);
}

function rankCountries(countryData, perturbedWeights, originalWeights, dimensionDomains, dimensionTypes) {
  const scored = countryData.map(({ countryCode, dimensions }) => ({
    countryCode,
    score: computeOverallScore(dimensions, perturbedWeights, originalWeights, dimensionDomains, dimensionTypes),
  }));
  scored.sort((a, b) => b.score - a.score || a.countryCode.localeCompare(b.countryCode));
  const ranks = {};
  for (let i = 0; i < scored.length; i++) {
    ranks[scored[i].countryCode] = i + 1;
  }
  return ranks;
}

async function run() {
  const {
    scoreAllDimensions,
    RESILIENCE_DOMAIN_ORDER,
    RESILIENCE_DIMENSION_ORDER,
    RESILIENCE_DIMENSION_DOMAINS,
    getResilienceDomainWeight,
    RESILIENCE_DIMENSION_TYPES,
    createMemoizedSeedReader,
  } = await import('../server/worldmonitor/resilience/v1/_dimension-scorers.ts');

  const { listScorableCountries } = await import('../server/worldmonitor/resilience/v1/_shared.ts');

  const scorableCountries = await listScorableCountries();
  const validSample = SAMPLE.filter((c) => scorableCountries.includes(c));
  const skipped = SAMPLE.filter((c) => !scorableCountries.includes(c));

  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} countries not in scorable set: ${skipped.join(', ')}`);
  }
  console.log(`Scoring ${validSample.length} countries from live Redis...\n`);

  const sharedReader = createMemoizedSeedReader();
  const countryData = [];
  const originalWeights = Object.fromEntries(
    RESILIENCE_DOMAIN_ORDER.map((d) => [d, getResilienceDomainWeight(d)]),
  );

  for (const countryCode of validSample) {
    const scoreMap = await scoreAllDimensions(countryCode, sharedReader);
    const dimensions = RESILIENCE_DIMENSION_ORDER.map((dimId) => ({
      id: dimId,
      score: scoreMap[dimId].score,
      coverage: scoreMap[dimId].coverage,
    }));

    countryData.push({ countryCode, dimensions });
  }

  if (countryData.length === 0) {
    console.error('FATAL: No countries scored. Check Redis connectivity.');
    process.exit(1);
  }

  console.log(`Scored all ${countryData.length} countries. Running ${NUM_DRAWS} Monte Carlo draws...\n`);

  const rankHistory = {};
  for (const cc of validSample) rankHistory[cc] = [];

  for (let draw = 0; draw < NUM_DRAWS; draw++) {
    const perturbedWeights = perturbWeights(RESILIENCE_DOMAIN_ORDER, getResilienceDomainWeight);
    const ranks = rankCountries(countryData, perturbedWeights, originalWeights, RESILIENCE_DIMENSION_DOMAINS, RESILIENCE_DIMENSION_TYPES);
    for (const cc of validSample) {
      rankHistory[cc].push(ranks[cc]);
    }
  }

  const stats = validSample.map((cc) => {
    const ranks = rankHistory[cc].slice().sort((a, b) => a - b);
    const meanRank = ranks.reduce((s, r) => s + r, 0) / ranks.length;
    const p05 = percentile(ranks, 5);
    const p95 = percentile(ranks, 95);
    return { countryCode: cc, meanRank, p05, p95, range: p95 - p05 };
  });

  stats.sort((a, b) => a.range - b.range || a.meanRank - b.meanRank);

  console.log(`=== SENSITIVITY ANALYSIS (${NUM_DRAWS} draws, ±${PERTURBATION_RANGE * 100}% weight perturbation) ===\n`);

  console.log('TOP 10 MOST STABLE (smallest rank range in 95% CI):');
  for (let i = 0; i < Math.min(10, stats.length); i++) {
    const s = stats[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${s.countryCode}  mean_rank=${s.meanRank.toFixed(1)}  p05=${s.p05}  p95=${s.p95}  range=${s.range}`);
  }

  console.log('\nTOP 10 LEAST STABLE (largest rank range in 95% CI):');
  const leastStable = stats.slice().sort((a, b) => b.range - a.range || b.meanRank - a.meanRank);
  for (let i = 0; i < Math.min(10, leastStable.length); i++) {
    const s = leastStable[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${s.countryCode}  mean_rank=${s.meanRank.toFixed(1)}  p05=${s.p05}  p95=${s.p95}  range=${s.range}`);
  }

  const baselineRanks = rankCountries(
    countryData,
    originalWeights,
    originalWeights,
    RESILIENCE_DIMENSION_DOMAINS,
    RESILIENCE_DIMENSION_TYPES,
  );
  const top10 = Object.entries(baselineRanks)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 10)
    .map(([cc]) => cc);

  let gatePass = true;
  console.log('\nTOP-10 BASELINE RANK STABILITY CHECK (must be within ±5 ranks in 95% of draws):');
  for (const cc of top10) {
    const s = stats.find((x) => x.countryCode === cc);
    if (!s) continue;
    const baseRank = baselineRanks[cc];
    const stable = Math.abs(s.p05 - baseRank) <= STABILITY_GATE_RANKS && Math.abs(s.p95 - baseRank) <= STABILITY_GATE_RANKS;
    if (!stable) gatePass = false;
    console.log(`  ${cc}  baseline_rank=${baseRank}  p05=${s.p05}  p95=${s.p95}  ${stable ? 'PASS' : 'FAIL'}`);
  }

  console.log(`\nGATE CHECK: Top-10 stable within ±${STABILITY_GATE_RANKS} ranks? ${gatePass ? 'YES' : 'NO'}`);

  const allRanges = stats.map((s) => s.range);
  const meanRange = allRanges.length > 0
    ? allRanges.reduce((s, r) => s + r, 0) / allRanges.length
    : 0;
  const maxRange = allRanges.length > 0 ? Math.max(...allRanges) : 0;
  const minRange = allRanges.length > 0 ? Math.min(...allRanges) : 0;
  console.log(`\nSUMMARY STATISTICS:`);
  console.log(`  Countries sampled: ${countryData.length}`);
  console.log(`  Monte Carlo draws: ${NUM_DRAWS}`);
  console.log(`  Perturbation: ±${PERTURBATION_RANGE * 100}% on domain weights`);
  console.log(`  Mean rank range (p05-p95): ${meanRange.toFixed(1)}`);
  console.log(`  Min rank range: ${minRange}`);
  console.log(`  Max rank range: ${maxRange}`);
}

const isMain = process.argv[1]?.endsWith('validate-resilience-sensitivity.mjs');
if (isMain) {
  run().then(() => process.exit(0)).catch((err) => {
    console.error('Sensitivity analysis failed:', err);
    process.exit(1);
  });
}

export { run };
