#!/usr/bin/env node
// #6511 — read-only acceptance capture for the live
// `financialSystemExposure` flag flip.
//
// Scores the exact sovereign universe twice against one shared production
// Redis read: once with RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=false and once
// with it=true. The scorer path is pure; this script never calls the cache or
// history writers. It writes a provenance-bearing artifact only when every
// Redis read completed without an unresolved transport error.
//
// Usage:
//   FIN_SYS_ACCEPTANCE_OUTPUT=docs/snapshots/resilience-financial-system-exposure-acceptance-YYYY-MM-DD.json \
//     node --import tsx/esm scripts/dry-run-resilience-financial-system-exposure-flip.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHROME_UA, loadEnvFile } from './_seed-utils.mjs';
import { unwrapEnvelope } from '../server/_shared/seed-envelope.ts';
import {
  computeHeadlineEligible,
  computeLowConfidence,
  computeOverallCoverage,
  buildDimensionList,
  buildDomainList,
  penalizedPillarScore,
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_INTERVAL_KEY_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_SCORE_CACHE_PREFIX,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import {
  RESILIENCE_IMF_LABOR_KEY,
  readCountryPopulationMillionsForGate,
  scoreAllDimensions,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { buildPillarList } from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';
import { RESILIENCE_COHORTS } from '../tests/helpers/resilience-cohorts.mts';

loadEnvFile(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HARNESS_PATH = 'scripts/dry-run-resilience-financial-system-exposure-flip.mjs';
const FINANCIAL_DIMENSION_ID = 'financialSystemExposure';
const FINANCIAL_FLAG = 'RESILIENCE_FIN_SYS_EXPOSURE_ENABLED';
const FINANCE_WB_EXTERNAL_DEBT_KEY = 'economic:wb-external-debt:v1';
const ACCEPTANCE_ARTIFACT_TYPE = 'resilience-financial-system-exposure-post-flip-acceptance';
const GATE_THRESHOLDS = Object.freeze({
  SPEARMAN_VS_BASELINE_MIN: 0.85,
  UNDER_THREE_DELTA_MIN: 0.60,
  MAX_NON_SANCTIONS_DELTA: 12,
});
const REPRESENTATIVE_COUNTRIES = ['US', 'PT', 'MC', 'RU', 'TD', 'ER', 'TW', 'VE'];

export function normalizeProductionRead(key, raw) {
  // The scorer needs the WB debt envelope's numeric schemaVersion to enforce
  // the v2 non-DRS producer contract. Other seed readers receive the bare
  // data shape, which matches defaultSeedReader's established behavior.
  return key === FINANCE_WB_EXTERNAL_DEBT_KEY ? raw : unwrapEnvelope(raw).data;
}

const universe = Object.values(
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/shared/sovereign-status.json'), 'utf8')).entries,
).map((entry) => entry.iso2);

const sanctionsCohort = RESILIENCE_COHORTS.find((cohort) => cohort.id === 'sanctions-isolated');
if (!sanctionsCohort || sanctionsCohort.countryCodes.length === 0) {
  throw new Error('sanctions-isolated cohort is required for the finance activation gate');
}

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const round2 = (value) => Math.round(value * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function rank(values) {
  const sorted = [...values.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const ranks = new Map();
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1][1] === sorted[index][1]) end++;
    const sharedRank = (index + end) / 2 + 1;
    for (let cursor = index; cursor <= end; cursor++) ranks.set(sorted[cursor][0], sharedRank);
    index = end + 1;
  }
  return ranks;
}

export function spearman(baseline, proposed) {
  const keys = [...baseline.keys()].filter((countryCode) => proposed.has(countryCode));
  if (keys.length < 2) return 1;
  const baselineRanks = rank(new Map(keys.map((countryCode) => [countryCode, baseline.get(countryCode)])));
  const proposedRanks = rank(new Map(keys.map((countryCode) => [countryCode, proposed.get(countryCode)])));
  const mean = (keys.length + 1) / 2;
  let numerator = 0;
  let baselineVariance = 0;
  let proposedVariance = 0;
  for (const countryCode of keys) {
    const baselineDelta = baselineRanks.get(countryCode) - mean;
    const proposedDelta = proposedRanks.get(countryCode) - mean;
    numerator += baselineDelta * proposedDelta;
    baselineVariance += baselineDelta * baselineDelta;
    proposedVariance += proposedDelta * proposedDelta;
  }
  if (baselineVariance === 0 || proposedVariance === 0) return 0;
  return numerator / Math.sqrt(baselineVariance * proposedVariance);
}

function rowsForFormula(scores, formula) {
  return new Map(
    [...scores.entries()]
      .filter(([, row]) => Number.isFinite(row?.[formula]))
      .map(([countryCode, row]) => [countryCode, row[formula]]),
  );
}

function sortedCountryCodes(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function gateResult(id, name, status, detail, evidence = {}) {
  return { id, name, status, detail, evidence };
}

export function evaluateGates({ baseline, proposed, sanctionsCountryCodes }) {
  const baselineScores = rowsForFormula(baseline, 'pc');
  const proposedScores = rowsForFormula(proposed, 'pc');
  const countries = [...baselineScores.keys()].filter((countryCode) => proposedScores.has(countryCode));
  const baselineForCommon = new Map(countries.map((countryCode) => [countryCode, baselineScores.get(countryCode)]));
  const proposedForCommon = new Map(countries.map((countryCode) => [countryCode, proposedScores.get(countryCode)]));
  const rho = spearman(baselineForCommon, proposedForCommon);

  const deltas = countries.map((countryCode) => ({
    countryCode,
    delta: proposedForCommon.get(countryCode) - baselineForCommon.get(countryCode),
  }));
  const underThree = deltas.filter(({ delta }) => Math.abs(delta) < 3);
  const overTwelve = deltas.filter(({ delta }) => Math.abs(delta) > GATE_THRESHOLDS.MAX_NON_SANCTIONS_DELTA);
  const nonSanctionsOverTwelve = overTwelve.filter(({ countryCode }) => !sanctionsCountryCodes.has(countryCode));

  const headlineEligibilityChanges = countries
    .filter((countryCode) => baseline.get(countryCode)?.headlineEligible !== proposed.get(countryCode)?.headlineEligible)
    .map((countryCode) => ({
      countryCode,
      before: Boolean(baseline.get(countryCode)?.headlineEligible),
      after: Boolean(proposed.get(countryCode)?.headlineEligible),
    }));

  const gates = [
    gateResult(
      'gate-1-spearman',
      'Spearman vs flag-off baseline >= 0.85',
      rho >= GATE_THRESHOLDS.SPEARMAN_VS_BASELINE_MIN ? 'pass' : 'fail',
      `rho ${round2(rho)} over ${countries.length} countries`,
      { spearman: rho, countries: countries.length },
    ),
    gateResult(
      'gate-2-bounded-movement',
      'At least 60% move <3 points and no non-sanctions country moves >12',
      underThree.length / Math.max(countries.length, 1) >= GATE_THRESHOLDS.UNDER_THREE_DELTA_MIN
        && nonSanctionsOverTwelve.length === 0
        ? 'pass'
        : 'fail',
      `${underThree.length}/${countries.length} under 3 points; max |delta| ${round2(Math.max(...deltas.map(({ delta }) => Math.abs(delta)), 0))}`,
      {
        underThreeCount: underThree.length,
        underThreePct: underThree.length / Math.max(countries.length, 1),
        maxAbsDelta: Math.max(...deltas.map(({ delta }) => Math.abs(delta)), 0),
        overTwelve,
        nonSanctionsOverTwelve,
        topMovers: [...deltas]
          .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.countryCode.localeCompare(right.countryCode))
          .slice(0, 15),
      },
    ),
    gateResult(
      'gate-3-headline-eligibility',
      'Headline-eligibility changes are explicitly recorded',
      'pass',
      `${headlineEligibilityChanges.length} eligibility changes across ${countries.length} countries`,
      { changes: headlineEligibilityChanges },
    ),
  ];

  return {
    verdict: gates.every((gate) => gate.status === 'pass') ? 'PASS' : 'FAIL',
    gates,
  };
}

function normalizeDimension(dimension) {
  if (!dimension) {
    return {
      score: 0,
      coverage: 0,
      observedWeight: 0,
      imputedWeight: 0,
      imputationClass: null,
    };
  }
  return {
    score: finiteNumber(dimension.score, `${FINANCIAL_DIMENSION_ID}.score`),
    coverage: finiteNumber(dimension.coverage, `${FINANCIAL_DIMENSION_ID}.coverage`),
    observedWeight: finiteNumber(dimension.observedWeight ?? 0, `${FINANCIAL_DIMENSION_ID}.observedWeight`),
    imputedWeight: finiteNumber(dimension.imputedWeight ?? 0, `${FINANCIAL_DIMENSION_ID}.imputedWeight`),
    imputationClass: dimension.imputationClass || null,
  };
}

function summarizeSourceFailures(dimensions) {
  return dimensions
    .filter((dimension) => dimension.imputationClass === 'source-failure')
    .map((dimension) => dimension.id)
    .sort();
}

async function scoreCountry(countryCode, reader) {
  const scoreMap = await scoreAllDimensions(countryCode, reader);
  const dimensions = buildDimensionList(scoreMap);
  const domains = buildDomainList(dimensions);
  const pillars = buildPillarList(domains, true);
  const pc = penalizedPillarScore(pillars.map((pillar) => ({ score: pillar.score, weight: pillar.weight })));
  const d6 = round2(domains.reduce((sum, domain) => sum + domain.score * domain.weight, 0));
  const totalImputed = dimensions.reduce((sum, dimension) => sum + (dimension.imputedWeight ?? 0), 0);
  const totalObserved = dimensions.reduce((sum, dimension) => sum + (dimension.observedWeight ?? 0), 0);
  const imputationShare = totalImputed + totalObserved > 0
    ? totalImputed / (totalImputed + totalObserved)
    : 0;
  const overallCoverage = computeOverallCoverage({ domains });
  const lowConfidence = computeLowConfidence(dimensions, imputationShare);
  const imfLabor = await reader(RESILIENCE_IMF_LABOR_KEY);
  const headlineEligible = computeHeadlineEligible({
    overallCoverage,
    populationMillions: readCountryPopulationMillionsForGate(imfLabor, countryCode),
    lowConfidence,
  });
  const financialDimension = dimensions.find((dimension) => dimension.id === FINANCIAL_DIMENSION_ID);

  return {
    pc,
    d6,
    overallCoverage: round2(overallCoverage),
    headlineEligible,
    financialSystemExposure: normalizeDimension(financialDimension),
    sourceFailureDimensions: summarizeSourceFailures(dimensions),
  };
}

// ── production read layer ─────────────────────────────────────────────────

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const readCache = new Map();
const unresolvedKeys = new Map();

async function fetchKeyOnce(key) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required; load the worktree environment first');
  }
  const response = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error(`Redis: ${body.error}`);
  if (body?.result == null) return null;
  return normalizeProductionRead(key, JSON.parse(body.result));
}

async function readKey(key) {
  if (readCache.has(key)) return readCache.get(key);
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const value = await fetchKeyOnce(key);
      readCache.set(key, value);
      return value;
    } catch (error) {
      lastError = error;
      await sleep(250 * 2 ** attempt);
    }
  }
  unresolvedKeys.set(key, lastError?.message ?? 'unknown read failure');
  readCache.set(key, null);
  return null;
}

async function scorePass(label, enabled) {
  process.env[FINANCIAL_FLAG] = enabled ? 'true' : 'false';
  const scores = new Map();
  for (const countryCode of universe) {
    scores.set(countryCode, await scoreCountry(countryCode, readKey));
    if (scores.size % 40 === 0) {
      process.stderr.write(`  [${label}] ${scores.size}/${universe.length} (${readCache.size} keys read)\n`);
    }
  }
  return scores;
}

function buildRedisCaptureProvenance() {
  const keyDigests = Object.fromEntries(
    [...readCache.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, sha256(canonicalJson(value))]),
  );
  return {
    source: 'production-upstash-redis-rest',
    resolvedKeyCount: Object.keys(keyDigests).length,
    keyDigests,
    snapshotSha256: sha256(canonicalJson(keyDigests)),
  };
}

function captureSourceState() {
  const trackedChanges = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).trim();
  if (trackedChanges) {
    throw new Error('FIN_SYS_ACCEPTANCE_OUTPUT requires a clean tracked worktree so the harness commit is exact');
  }
  const harnessCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return {
    harness: HARNESS_PATH,
    harnessCommitSha,
    harnessSha256: sha256(readFileSync(path.join(REPO_ROOT, HARNESS_PATH))),
  };
}

function serializableScores(scores) {
  return Object.fromEntries(
    sortedCountryCodes(scores.keys()).map((countryCode) => [countryCode, scores.get(countryCode)]),
  );
}

function representativeCountries(baseline, proposed) {
  return Object.fromEntries(
    REPRESENTATIVE_COUNTRIES
      .filter((countryCode) => baseline.has(countryCode) && proposed.has(countryCode))
      .map((countryCode) => [countryCode, {
        before: baseline.get(countryCode),
        after: proposed.get(countryCode),
      }]),
  );
}

export function buildAcceptanceArtifact({
  measuredAt,
  capture,
  baseline,
  proposed,
  sanctionsCountryCodes,
  cacheNamespaces,
}) {
  const gateSummary = evaluateGates({ baseline, proposed, sanctionsCountryCodes });
  return {
    schemaVersion: 1,
    artifactType: ACCEPTANCE_ARTIFACT_TYPE,
    measuredAt,
    capture: {
      ...capture,
      activeFormula: 'pc',
      flag: FINANCIAL_FLAG,
      cacheNamespaces,
      redis: capture.redis,
    },
    productionState: {
      flag: 'true',
      note: 'The owner-controlled production flag was already true at capture time; the false arm is a read-only counterfactual baseline.',
    },
    universeSize: baseline.size,
    sanctionsCountryCodes: sortedCountryCodes(sanctionsCountryCodes),
    baseline: {
      flagValue: 'false',
      countryCount: baseline.size,
    },
    postFlip: {
      flagValue: 'true',
      countryCount: proposed.size,
    },
    acceptanceGates: {
      verdict: gateSummary.verdict,
      gatingFormula: 'pc',
      gates: gateSummary.gates,
    },
    representativeCountries: representativeCountries(baseline, proposed),
    scores: Object.fromEntries(
      sortedCountryCodes(baseline.keys()).map((countryCode) => [countryCode, {
        baseline: baseline.get(countryCode),
        proposed: proposed.get(countryCode),
      }]),
    ),
  };
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a 64-character hex digest`);
  }
}

function assertScoreRow(row, label) {
  finiteNumber(row?.pc, `${label}.pc`);
  finiteNumber(row?.d6, `${label}.d6`);
  finiteNumber(row?.overallCoverage, `${label}.overallCoverage`);
  if (typeof row?.headlineEligible !== 'boolean') throw new Error(`${label}.headlineEligible must be boolean`);
  finiteNumber(row?.financialSystemExposure?.score, `${label}.financialSystemExposure.score`);
  finiteNumber(row?.financialSystemExposure?.coverage, `${label}.financialSystemExposure.coverage`);
  if (!Array.isArray(row?.sourceFailureDimensions)) throw new Error(`${label}.sourceFailureDimensions must be an array`);
}

export function validateAcceptanceArtifact(artifact) {
  if (artifact?.schemaVersion !== 1 || artifact?.artifactType !== ACCEPTANCE_ARTIFACT_TYPE) {
    throw new Error('finance acceptance artifact type or schemaVersion is invalid');
  }
  if (typeof artifact.measuredAt !== 'string' || Number.isNaN(Date.parse(artifact.measuredAt))) {
    throw new Error('finance acceptance artifact measuredAt must be an ISO timestamp');
  }
  if (artifact.capture?.activeFormula !== 'pc' || artifact.capture?.flag !== FINANCIAL_FLAG) {
    throw new Error('finance acceptance capture formula or flag is invalid');
  }
  if (typeof artifact.capture?.harness !== 'string' || !/^[a-z0-9_./-]+\.mjs$/.test(artifact.capture.harness)) {
    throw new Error('finance acceptance capture harness is invalid');
  }
  if (!/^[a-f0-9]{40}$/.test(artifact.capture?.harnessCommitSha ?? '')) {
    throw new Error('finance acceptance harnessCommitSha is invalid');
  }
  assertHash(artifact.capture?.harnessSha256, 'finance acceptance harnessSha256');
  const redis = artifact.capture?.redis;
  if (redis?.source !== 'production-upstash-redis-rest' || !Number.isInteger(redis?.resolvedKeyCount)) {
    throw new Error('finance acceptance Redis provenance is invalid');
  }
  const keyDigests = redis.keyDigests;
  if (!keyDigests || typeof keyDigests !== 'object' || Array.isArray(keyDigests)) {
    throw new Error('finance acceptance keyDigests is invalid');
  }
  for (const [key, digest] of Object.entries(keyDigests)) assertHash(digest, `finance acceptance keyDigests.${key}`);
  if (redis.resolvedKeyCount !== Object.keys(keyDigests).length) throw new Error('finance acceptance key count is inconsistent');
  assertHash(redis.snapshotSha256, 'finance acceptance snapshotSha256');
  if (redis.snapshotSha256 !== sha256(canonicalJson(keyDigests))) throw new Error('finance acceptance snapshotSha256 does not match keyDigests');

  const cacheNamespaces = artifact.capture.cacheNamespaces;
  if (!/^resilience:score:v\d+:$/.test(cacheNamespaces?.score ?? '')
    || !/^resilience:ranking:v\d+$/.test(cacheNamespaces?.ranking ?? '')
    || !/^resilience:history:v\d+:$/.test(cacheNamespaces?.history ?? '')
    || !/^resilience:intervals:v\d+:$/.test(cacheNamespaces?.intervals ?? '')) {
    throw new Error('finance acceptance cache namespaces are invalid');
  }
  if (cacheNamespaces.score.replace('score', 'ranking').replace(/:$/, '') !== cacheNamespaces.ranking) {
    throw new Error('finance acceptance score and ranking namespaces do not share a generation');
  }

  const scores = artifact.scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) throw new Error('finance acceptance scores are invalid');
  const countryCodes = Object.keys(scores);
  if (artifact.universeSize !== countryCodes.length || artifact.baseline?.countryCount !== countryCodes.length || artifact.postFlip?.countryCount !== countryCodes.length) {
    throw new Error('finance acceptance universe counts are inconsistent');
  }
  const baseline = new Map();
  const proposed = new Map();
  for (const countryCode of countryCodes) {
    assertScoreRow(scores[countryCode]?.baseline, `${countryCode}.baseline`);
    assertScoreRow(scores[countryCode]?.proposed, `${countryCode}.proposed`);
    baseline.set(countryCode, scores[countryCode].baseline);
    proposed.set(countryCode, scores[countryCode].proposed);
  }
  if (artifact.baseline.flagValue !== 'false' || artifact.postFlip.flagValue !== 'true') throw new Error('finance acceptance flag arms are invalid');
  if (artifact.productionState?.flag !== 'true') throw new Error('finance acceptance production state must be flag-on');
  const sanctionsCountryCodes = new Set(artifact.sanctionsCountryCodes);
  const gateSummary = evaluateGates({ baseline, proposed, sanctionsCountryCodes });
  if (artifact.acceptanceGates?.gatingFormula !== 'pc') throw new Error('finance acceptance gating formula is invalid');
  if (artifact.acceptanceGates?.verdict !== gateSummary.verdict) throw new Error('finance acceptance verdict does not match recomputed gates');
  if (canonicalJson(artifact.acceptanceGates.gates) !== canonicalJson(gateSummary.gates)) throw new Error('finance acceptance gates do not match recomputed gates');
  return gateSummary.verdict;
}

function resolveOutputPath(measuredAt) {
  const defaultName = `resilience-financial-system-exposure-acceptance-${measuredAt.slice(0, 10)}.json`;
  const configured = process.env.FIN_SYS_ACCEPTANCE_OUTPUT || path.join('docs', 'snapshots', defaultName);
  const outputPath = path.isAbsolute(configured) ? configured : path.join(REPO_ROOT, configured);
  const relative = path.relative(REPO_ROOT, outputPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('FIN_SYS_ACCEPTANCE_OUTPUT must stay inside the repository');
  if (!/^resilience-financial-system-exposure-acceptance-\d{4}-\d{2}-\d{2}\.json$/.test(path.basename(outputPath))) {
    throw new Error('FIN_SYS_ACCEPTANCE_OUTPUT must use resilience-financial-system-exposure-acceptance-YYYY-MM-DD.json');
  }
  if (!path.basename(outputPath).includes(measuredAt.slice(0, 10))) throw new Error('acceptance filename date must match measuredAt');
  return outputPath;
}

async function main() {
  const startedAt = new Date().toISOString();
  const baseline = await scorePass('flag-off', false);
  const proposed = await scorePass('flag-on', true);
  if (unresolvedKeys.size > 0) {
    throw new Error(`unresolved production Redis reads; refusing to write an acceptance artifact: ${JSON.stringify(Object.fromEntries(unresolvedKeys))}`);
  }
  const financeSourceFailures = [...proposed.entries()]
    .filter(([, row]) => row.sourceFailureDimensions.includes(FINANCIAL_DIMENSION_ID))
    .map(([countryCode]) => countryCode);
  if (financeSourceFailures.length > 0) {
    throw new Error(
      `financialSystemExposure source-failure in the flag-on arm for ${financeSourceFailures.length} countries; refusing to write an acceptance artifact: ${financeSourceFailures.slice(0, 12).join(', ')}`,
    );
  }
  const measuredAt = new Date().toISOString();
  const cacheNamespaces = {
    score: RESILIENCE_SCORE_CACHE_PREFIX,
    ranking: RESILIENCE_RANKING_CACHE_KEY,
    history: RESILIENCE_HISTORY_KEY_PREFIX,
    intervals: RESILIENCE_INTERVAL_KEY_PREFIX,
  };
  const artifact = buildAcceptanceArtifact({
    measuredAt,
    capture: {
      ...captureSourceState(),
      startedAt,
      completedAt: measuredAt,
      redis: buildRedisCaptureProvenance(),
    },
    baseline,
    proposed,
    sanctionsCountryCodes: new Set(sanctionsCohort.countryCodes),
    cacheNamespaces,
  });
  if (artifact.acceptanceGates.verdict !== 'PASS') {
    throw new Error(`finance activation acceptance gates failed; refusing to write artifact: ${JSON.stringify(artifact.acceptanceGates.gates)}`);
  }
  const outputPath = resolveOutputPath(measuredAt);
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`[finance-activation] wrote ${outputPath}`);
  console.log(`[finance-activation] verdict=${artifact.acceptanceGates.verdict} countries=${artifact.universeSize} keys=${artifact.capture.redis.resolvedKeyCount}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[finance-activation] failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export {
  ACCEPTANCE_ARTIFACT_TYPE,
  GATE_THRESHOLDS,
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_INTERVAL_KEY_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_SCORE_CACHE_PREFIX,
};
