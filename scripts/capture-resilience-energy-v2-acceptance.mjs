#!/usr/bin/env node
// Capture the post-flip energy-v2 acceptance artifact once real production
// ranking evidence exists. This script never fabricates the prerequisite
// ranking snapshot: it requires a committed post-flip PR1 ranking artifact
// produced by scripts/freeze-resilience-ranking.mjs with live credentials.
//
// Usage:
//   API_BASE=https://www.worldmonitor.app \
//     node --import tsx/esm scripts/capture-resilience-energy-v2-acceptance.mjs
//
// Optional:
//   BASELINE_RANKING_SNAPSHOT=docs/snapshots/resilience-ranking-live-pre-repair-2026-04-22.json
//   POST_FLIP_RANKING_SNAPSHOT=docs/snapshots/resilience-ranking-live-post-pr1-YYYY-MM-DD.json
//   WORLDMONITOR_API_KEY=<pro-api-key> # adds sampled score-endpoint evidence

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { RESILIENCE_COHORTS } from '../tests/helpers/resilience-cohorts.mts';
import { MATCHED_PAIRS } from '../tests/helpers/resilience-matched-pairs.mts';
import {
  EXTRACTION_RULES,
  buildIndicatorExtractionPlan,
} from './compare-resilience-current-vs-proposed.mjs';
import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'docs', 'snapshots');

const POST_FLIP_RANKING_RE = /^resilience-ranking-live-post-pr1-(\d{4}-\d{2}-\d{2})\.json$/;
const BASELINE_RANKING_RE = /^resilience-ranking-live-(?:pre-pr1-flip|pre-repair)-(\d{4}-\d{2}-\d{2})\.json$/;
const POST_FLIP_RANKING_SNAPSHOT_LABEL = 'post-flip PR1 resilience ranking snapshot';
const REQUIRED_HEALTH_CHECKS = ['lowCarbonGeneration', 'fossilElectricityShare', 'powerLosses'];
const REQUIRED_GATE_IDS = [
  'gate-1-spearman',
  'gate-2-country-drift',
  'gate-6-cohort-median',
  'gate-7-matched-pair',
  'gate-9-effective-influence-baseline',
];
const GATE_THRESHOLDS = {
  SPEARMAN_VS_BASELINE_MIN: 0.85,
  MAX_COUNTRY_ABS_DELTA_MAX: 15,
  COHORT_MEDIAN_SHIFT_MAX: 10,
  CORE_EXTRACTION_COVERAGE_MIN: 0.80,
};

const API_BASE = (process.env.API_BASE || 'https://www.worldmonitor.app').replace(/\/$/, '');
const API_ORIGIN = new URL(API_BASE).origin;
const USER_AGENT = process.env.USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DEFAULT_SAMPLE_COUNTRIES = ['FR', 'DE', 'SG', 'CH', 'NO', 'CA', 'AE', 'BH'];
const SAMPLE_COUNTRIES = (process.env.RESILIENCE_ENERGY_V2_SAMPLE_COUNTRIES || DEFAULT_SAMPLE_COUNTRIES.join(','))
  .split(',')
  .map((countryCode) => countryCode.trim().toUpperCase())
  .filter((countryCode) => /^[A-Z]{2}$/.test(countryCode));

class SnapshotNotFoundError extends Error {
  constructor(label) {
    super(`No ${label} found in docs/snapshots/.`);
    this.name = 'SnapshotNotFoundError';
    this.label = label;
  }
}

function commitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function rankCountries(scores) {
  const sorted = Object.entries(scores)
    .sort(([countryA, scoreA], [countryB, scoreB]) => scoreB - scoreA || countryA.localeCompare(countryB));
  return Object.fromEntries(sorted.map(([countryCode], index) => [countryCode, index + 1]));
}

function spearmanCorrelation(ranksA, ranksB) {
  const keys = Object.keys(ranksA).filter((countryCode) => countryCode in ranksB);
  const n = keys.length;
  if (n < 2) return 1;
  const dSqSum = keys.reduce((sum, countryCode) => sum + (ranksA[countryCode] - ranksB[countryCode]) ** 2, 0);
  return 1 - (6 * dSqSum) / (n * (n * n - 1));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function baseHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    origin: API_ORIGIN,
    referer: `${API_ORIGIN}/`,
    'user-agent': USER_AGENT,
  };
}

async function fetchJson(url, headers = baseHeaders()) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
  }
  return response.json();
}

function findScoreDimension(score, dimensionId) {
  return (Array.isArray(score?.domains) ? score.domains : [])
    .flatMap((domain) => (Array.isArray(domain?.dimensions) ? domain.dimensions : []))
    .find((dimension) => dimension?.id === dimensionId) ?? null;
}

function buildSampledCountryEvidenceEntry({ countryCode, score, postFlipScores }) {
  const energyDimension = findScoreDimension(score, 'energy');
  if (!energyDimension) {
    throw new Error(`Score endpoint response for ${countryCode} did not include energy dimension under domains[].dimensions`);
  }
  return {
    countryCode,
    scoreEndpointOverallScore: typeof score?.overallScore === 'number' ? round2(score.overallScore) : null,
    rankingSnapshotOverallScore: typeof postFlipScores?.[countryCode] === 'number'
      ? round2(postFlipScores[countryCode])
      : null,
    energyDimension: {
      score: typeof energyDimension.score === 'number' ? round2(energyDimension.score) : null,
      coverage: typeof energyDimension.coverage === 'number' ? round2(energyDimension.coverage) : null,
      imputationClass: energyDimension.imputationClass ?? null,
    },
  };
}

async function fetchRuntimeEvidence(baseUrl = API_BASE) {
  const [manifest, health] = await Promise.all([
    fetchJson(`${baseUrl}/api/resilience/v1/get-runtime-manifest`),
    fetchJson(`${baseUrl}/api/health`),
  ]);
  return { manifest, health };
}

async function fetchSampledCountryEvidence(baseUrl, postFlipScores) {
  if (!process.env.WORLDMONITOR_API_KEY) {
    return {
      status: 'skipped',
      reason: 'WORLDMONITOR_API_KEY not set; sampled score-endpoint evidence was not fetched.',
      countries: [],
    };
  }

  const headers = {
    ...baseHeaders(),
    'X-WorldMonitor-Key': process.env.WORLDMONITOR_API_KEY,
  };
  const countries = [];
  for (const countryCode of SAMPLE_COUNTRIES) {
    const url = new URL(`${baseUrl}/api/resilience/v1/get-resilience-score`);
    url.searchParams.set('countryCode', countryCode);
    const score = await fetchJson(url.toString(), headers);
    countries.push(buildSampledCountryEvidenceEntry({
      countryCode,
      score,
      postFlipScores,
    }));
  }
  return { status: 'captured', countries };
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function snapshotScores(snapshot) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  return Object.fromEntries(
    items
      .filter((item) => /^[A-Z]{2}$/.test(String(item.countryCode || '')) && typeof item.overallScore === 'number')
      .map((item) => [item.countryCode, item.overallScore]),
  );
}

function snapshotTotals(snapshot) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const greyedOut = Array.isArray(snapshot.greyedOut) ? snapshot.greyedOut : [];
  return {
    total: items.length + greyedOut.length,
    scored: items.length,
    greyedOut: greyedOut.length,
  };
}

function resolveSnapshotPath(value, label) {
  if (!value) return null;
  const resolved = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve inside the repository: ${value}`);
  }
  return resolved;
}

async function latestSnapshotPath(re, label, snapshotDir = SNAPSHOT_DIR) {
  const entries = await fs.readdir(snapshotDir).catch(() => []);
  const matches = entries
    .filter((filename) => re.test(filename))
    .sort();
  if (matches.length === 0) {
    throw new SnapshotNotFoundError(label);
  }
  return path.join(snapshotDir, matches.at(-1));
}

function formatMissingPostFlipRankingSnapshotMessage() {
  return [
    'No post-flip PR1 resilience ranking snapshot found in docs/snapshots/.',
    '',
    'Required prerequisite:',
    '  docs/snapshots/resilience-ranking-live-post-pr1-YYYY-MM-DD.json',
    '',
    'Capture it with production credentials; the freeze script verifies score anchors through get-resilience-score:',
    '  API_BASE=https://www.worldmonitor.app \\',
    '    WORLDMONITOR_API_KEY=<pro-api-key> \\',
    '    RESILIENCE_RANKING_OUTPUT_BASENAME=resilience-ranking-live-post-pr1-YYYY-MM-DD.json \\',
    '    node scripts/freeze-resilience-ranking.mjs',
    '  # The script must print:',
    '  #   [freeze-resilience-ranking] wrote .../docs/snapshots/resilience-ranking-live-post-pr1-YYYY-MM-DD.json',
    '',
    'Then rerun this harness:',
    '  API_BASE=https://www.worldmonitor.app \\',
    '    WORLDMONITOR_API_KEY=<pro-api-key> \\',
    '    node --import tsx/esm scripts/capture-resilience-energy-v2-acceptance.mjs',
    '',
    'Expected unauthenticated failure mode:',
    '  HTTP 401 from /api/resilience/v1/get-resilience-score: Pro authentication required',
    '',
    'If the harness prints acceptanceGates with gate-7-matched-pair failures, do not commit a synthetic artifact; attach the gate JSON to the closeout issue and wait for the P1 matched-pair workstream.',
  ].join('\n');
}

async function resolveBaselineSnapshotPath() {
  const explicit = resolveSnapshotPath(process.env.BASELINE_RANKING_SNAPSHOT, 'BASELINE_RANKING_SNAPSHOT');
  if (explicit) return explicit;
  return latestSnapshotPath(BASELINE_RANKING_RE, 'pre-flip/pre-repair resilience ranking snapshot');
}

async function resolvePostFlipSnapshotPath({ snapshotDir = SNAPSHOT_DIR } = {}) {
  const explicit = resolveSnapshotPath(process.env.POST_FLIP_RANKING_SNAPSHOT, 'POST_FLIP_RANKING_SNAPSHOT');
  if (explicit) return explicit;
  try {
    return await latestSnapshotPath(POST_FLIP_RANKING_RE, POST_FLIP_RANKING_SNAPSHOT_LABEL, snapshotDir);
  } catch (err) {
    if (err instanceof SnapshotNotFoundError && err.label === POST_FLIP_RANKING_SNAPSHOT_LABEL) {
      throw new Error(formatMissingPostFlipRankingSnapshotMessage());
    }
    throw err;
  }
}

function relativeRepoPath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function assertPostFlipSnapshotFilename(filePath) {
  const filename = path.basename(filePath);
  const match = POST_FLIP_RANKING_RE.exec(filename);
  if (!match) {
    throw new Error(`Post-flip ranking snapshot must match ${POST_FLIP_RANKING_RE}, got ${filename}`);
  }
  return match[1];
}

function assertBaselineSnapshotFilename(filePath) {
  const filename = path.basename(filePath);
  const match = BASELINE_RANKING_RE.exec(filename);
  if (!match) {
    throw new Error(`Baseline ranking snapshot must match ${BASELINE_RANKING_RE}, got ${filename}`);
  }
  return match[1];
}

function buildExtractionCoverage() {
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  return {
    totalIndicators: plan.length,
    implemented: plan.filter((entry) => entry.extractionStatus === 'implemented').length,
    notImplemented: plan.filter((entry) => entry.extractionStatus === 'not-implemented').length,
    unregisteredInHarness: plan.filter((entry) => entry.extractionStatus === 'unregistered-in-harness').length,
    coreImplemented: plan.filter((entry) => entry.tier === 'core' && entry.extractionStatus === 'implemented').length,
    coreTotal: plan.filter((entry) => entry.tier === 'core').length,
    extractionRuleCount: Object.keys(EXTRACTION_RULES).length,
  };
}

function buildGateResults({ baselineScores, postFlipScores, extractionCoverage }) {
  const gates = [];
  const addGate = (id, name, status, detail, evidence = {}) => {
    gates.push({ id, name, status, detail, evidence });
  };

  const overlapping = Object.keys(postFlipScores)
    .filter((countryCode) => typeof baselineScores[countryCode] === 'number')
    .map((countryCode) => ({
      countryCode,
      baselineOverallScore: baselineScores[countryCode],
      postFlipOverallScore: postFlipScores[countryCode],
      scoreDelta: round2(postFlipScores[countryCode] - baselineScores[countryCode]),
      scoreAbsDelta: round2(Math.abs(postFlipScores[countryCode] - baselineScores[countryCode])),
    }));
  const baselineOverlapScores = Object.fromEntries(
    overlapping.map((entry) => [entry.countryCode, entry.baselineOverallScore]),
  );
  const postFlipOverlapScores = Object.fromEntries(
    overlapping.map((entry) => [entry.countryCode, entry.postFlipOverallScore]),
  );
  const spearman = Math.round(spearmanCorrelation(
    rankCountries(baselineOverlapScores),
    rankCountries(postFlipOverlapScores),
  ) * 10_000) / 10_000;
  const biggestDrifts = [...overlapping]
    .sort((a, b) => b.scoreAbsDelta - a.scoreAbsDelta || a.countryCode.localeCompare(b.countryCode))
    .slice(0, 10);
  const maxCountryAbsDelta = biggestDrifts[0]?.scoreAbsDelta ?? 0;

  addGate(
    'gate-1-spearman',
    'Spearman vs baseline >= 0.85',
    overlapping.length >= 2 && spearman >= GATE_THRESHOLDS.SPEARMAN_VS_BASELINE_MIN ? 'pass' : 'fail',
    `${spearman} (floor ${GATE_THRESHOLDS.SPEARMAN_VS_BASELINE_MIN})`,
    { overlapSize: overlapping.length },
  );

  addGate(
    'gate-2-country-drift',
    'Max country drift vs baseline <= 15 points',
    overlapping.length > 0 && maxCountryAbsDelta <= GATE_THRESHOLDS.MAX_COUNTRY_ABS_DELTA_MAX ? 'pass' : 'fail',
    `${maxCountryAbsDelta}pt (ceiling ${GATE_THRESHOLDS.MAX_COUNTRY_ABS_DELTA_MAX})`,
    { biggestDrifts },
  );

  const cohortShiftVsBaseline = RESILIENCE_COHORTS.map((cohort) => {
    const members = cohort.countryCodes
      .filter((countryCode) => typeof baselineScores[countryCode] === 'number' && typeof postFlipScores[countryCode] === 'number')
      .map((countryCode) => ({
        countryCode,
        delta: postFlipScores[countryCode] - baselineScores[countryCode],
      }));
    const medianDelta = median(members.map((member) => member.delta));
    return {
      cohortId: cohort.id,
      label: cohort.label,
      inSample: members.length,
      medianScoreDeltaVsBaseline: medianDelta == null ? null : round2(medianDelta),
    };
  });
  const worstCohort = cohortShiftVsBaseline
    .filter((cohort) => typeof cohort.medianScoreDeltaVsBaseline === 'number')
    .sort((a, b) => Math.abs(b.medianScoreDeltaVsBaseline) - Math.abs(a.medianScoreDeltaVsBaseline))[0];
  const worstCohortShift = Math.abs(worstCohort?.medianScoreDeltaVsBaseline ?? Number.POSITIVE_INFINITY);
  addGate(
    'gate-6-cohort-median',
    'Cohort median shift vs baseline <= 10 points',
    worstCohort && worstCohortShift <= GATE_THRESHOLDS.COHORT_MEDIAN_SHIFT_MAX ? 'pass' : 'fail',
    worstCohort
      ? `worst: ${worstCohort.cohortId} ${worstCohort.medianScoreDeltaVsBaseline}pt (ceiling ${GATE_THRESHOLDS.COHORT_MEDIAN_SHIFT_MAX})`
      : 'no cohort has baseline overlap',
    { cohortShiftVsBaseline },
  );

  const matchedPairSummary = MATCHED_PAIRS.map((pair) => {
    const higher = postFlipScores[pair.higherExpected];
    const lower = postFlipScores[pair.lowerExpected];
    const minGap = pair.minGap ?? 3;
    if (typeof higher !== 'number' || typeof lower !== 'number') {
      return {
        pairId: pair.id,
        skipped: true,
        reason: 'pair endpoint missing from post-flip snapshot',
      };
    }
    const gap = round2(higher - lower);
    return {
      pairId: pair.id,
      axis: pair.axis,
      higherExpected: pair.higherExpected,
      lowerExpected: pair.lowerExpected,
      minGap,
      gap,
      status: gap >= minGap ? 'pass' : 'fail',
    };
  });
  const matchedPairFailures = matchedPairSummary.filter((pair) => pair.status !== 'pass');
  addGate(
    'gate-7-matched-pair',
    'Matched-pair within-pair gaps hold expected direction',
    matchedPairFailures.length === 0 ? 'pass' : 'fail',
    matchedPairFailures.length === 0
      ? `${matchedPairSummary.length}/${matchedPairSummary.length} pairs pass`
      : `${matchedPairFailures.length} pair(s) failed or missing: ${matchedPairFailures.map((pair) => pair.pairId).join(', ')}`,
    { matchedPairSummary },
  );

  const coverageRatio = extractionCoverage.coreTotal > 0
    ? extractionCoverage.coreImplemented / extractionCoverage.coreTotal
    : 0;
  addGate(
    'gate-9-effective-influence-baseline',
    'Per-indicator effective-influence baseline exists (>= 80% of Core implemented)',
    coverageRatio >= GATE_THRESHOLDS.CORE_EXTRACTION_COVERAGE_MIN ? 'pass' : 'fail',
    `${extractionCoverage.coreImplemented}/${extractionCoverage.coreTotal} Core indicators measurable`,
    { extractionCoverage },
  );

  return gates;
}

function extractRuntimeManifest(manifest) {
  return {
    formulaTag: manifest?.formulaTag ?? null,
    constructVersions: {
      energy: manifest?.constructVersions?.energy ?? null,
    },
    rankingCache: {
      count: manifest?.rankingCache?.count ?? null,
      scored: manifest?.rankingCache?.scored ?? null,
      total: manifest?.rankingCache?.total ?? null,
    },
  };
}

function extractRuntimeHealth(health) {
  const checks = {};
  for (const checkName of REQUIRED_HEALTH_CHECKS) {
    checks[checkName] = health?.checks?.[checkName]?.status ?? null;
  }
  return { energyV2SeedChecks: checks };
}

function buildRuntimeGate(runtime) {
  const failures = [];
  if (runtime.manifest.formulaTag !== 'pc') failures.push(`formulaTag=${runtime.manifest.formulaTag}`);
  if (runtime.manifest.constructVersions.energy !== 'v2') {
    failures.push(`constructVersions.energy=${runtime.manifest.constructVersions.energy}`);
  }
  for (const field of ['count', 'scored', 'total']) {
    if (runtime.manifest.rankingCache[field] !== 196) {
      failures.push(`rankingCache.${field}=${runtime.manifest.rankingCache[field]}`);
    }
  }
  for (const checkName of REQUIRED_HEALTH_CHECKS) {
    if (runtime.health.energyV2SeedChecks[checkName] !== 'OK') {
      failures.push(`${checkName}=${runtime.health.energyV2SeedChecks[checkName]}`);
    }
  }
  return {
    id: 'gate-runtime-post-flip',
    name: 'Runtime manifest and energy-v2 source health are post-flip',
    status: failures.length === 0 ? 'pass' : 'fail',
    detail: failures.length === 0
      ? 'formulaTag=pc, constructVersions.energy=v2, rankingCache=196/196, energy-v2 health OK'
      : failures.join('; '),
  };
}

function summarizeGates(results) {
  return {
    total: results.length,
    pass: results.filter((gate) => gate.status === 'pass').length,
    fail: results.filter((gate) => gate.status === 'fail').length,
    skipped: results.filter((gate) => gate.status === 'skipped').length,
  };
}

function buildAcceptanceArtifact({
  generatedAt,
  baseUrl,
  baselineSnapshotPath,
  baselineSnapshot,
  postFlipSnapshotPath,
  postFlipSnapshot,
  runtimeEvidence,
  sampledCountryEvidence,
  extractionCoverage = buildExtractionCoverage(),
}) {
  const capturedAt = assertPostFlipSnapshotFilename(postFlipSnapshotPath);
  assertBaselineSnapshotFilename(baselineSnapshotPath);

  const baselineScores = snapshotScores(baselineSnapshot);
  const postFlipScores = snapshotScores(postFlipSnapshot);
  const runtime = {
    manifest: extractRuntimeManifest(runtimeEvidence.manifest),
    health: extractRuntimeHealth(runtimeEvidence.health),
  };
  const requiredGateResults = buildGateResults({ baselineScores, postFlipScores, extractionCoverage });
  const results = [
    buildRuntimeGate(runtime),
    ...requiredGateResults,
  ];
  const summary = summarizeGates(results);
  const verdict = summary.fail > 0 || summary.skipped > 0 ? 'BLOCK' : 'PASS';

  return {
    artifactType: 'resilience-energy-v2-post-flip-acceptance',
    comparison: 'energyV2PostFlipAcceptance',
    generatedAt,
    capturedAt,
    baseUrl,
    commitSha: commitSha(),
    runtime,
    baseline: {
      rankingSnapshot: relativeRepoPath(baselineSnapshotPath),
      capturedAt: baselineSnapshot.capturedAt ?? null,
      commitSha: baselineSnapshot.commitSha ?? null,
      rankingTotals: snapshotTotals(baselineSnapshot),
    },
    postFlip: {
      rankingSnapshot: relativeRepoPath(postFlipSnapshotPath),
      capturedAt: postFlipSnapshot.capturedAt ?? null,
      source: postFlipSnapshot.source ?? null,
      commitSha: postFlipSnapshot.commitSha ?? null,
      methodologyFormula: postFlipSnapshot.methodologyFormula ?? null,
      rankingTotals: snapshotTotals(postFlipSnapshot),
      formulaVerification: postFlipSnapshot.formulaVerification ?? null,
    },
    sourceHealth: runtime.health.energyV2SeedChecks,
    sampledCountryEvidence,
    acceptanceGates: {
      thresholds: GATE_THRESHOLDS,
      requiredGateIds: REQUIRED_GATE_IDS,
      verdict,
      results,
      summary,
    },
  };
}

async function main() {
  const baselineSnapshotPath = await resolveBaselineSnapshotPath();
  const postFlipSnapshotPath = await resolvePostFlipSnapshotPath();
  const postFlipDate = assertPostFlipSnapshotFilename(postFlipSnapshotPath);
  assertBaselineSnapshotFilename(baselineSnapshotPath);

  const baselineSnapshot = await readJsonFile(baselineSnapshotPath);
  const postFlipSnapshot = await readJsonFile(postFlipSnapshotPath);
  const postFlipScores = snapshotScores(postFlipSnapshot);
  const [runtimeEvidence, sampledCountryEvidence] = await Promise.all([
    fetchRuntimeEvidence(API_BASE),
    fetchSampledCountryEvidence(API_BASE, postFlipScores),
  ]);
  const artifact = buildAcceptanceArtifact({
    generatedAt: new Date().toISOString(),
    baseUrl: API_BASE,
    baselineSnapshotPath,
    baselineSnapshot,
    postFlipSnapshotPath,
    postFlipSnapshot,
    runtimeEvidence,
    sampledCountryEvidence,
  });

  if (artifact.acceptanceGates.verdict !== 'PASS') {
    console.error('[capture-resilience-energy-v2-acceptance] acceptance gates did not pass; no artifact written.');
    console.error(JSON.stringify(artifact.acceptanceGates, null, 2));
    process.exit(1);
  }

  const outPath = path.join(SNAPSHOT_DIR, `resilience-energy-v2-acceptance-${postFlipDate}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`[capture-resilience-energy-v2-acceptance] wrote ${outPath}`);
}

export {
  DEFAULT_SAMPLE_COUNTRIES,
  GATE_THRESHOLDS,
  REQUIRED_GATE_IDS,
  buildAcceptanceArtifact,
  buildExtractionCoverage,
  buildGateResults,
  buildSampledCountryEvidenceEntry,
  formatMissingPostFlipRankingSnapshotMessage,
  resolvePostFlipSnapshotPath,
  snapshotScores,
  snapshotTotals,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[capture-resilience-energy-v2-acceptance] failed:', err.message || err);
    process.exit(1);
  });
}
