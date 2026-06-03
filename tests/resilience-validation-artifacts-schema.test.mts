import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_CACHE_FORMULAS,
  KNOWN_METHODOLOGY_FORMULAS,
  PC_VALIDATION_ARTIFACT_MIN_GENERATED_AT,
  methodologyFormulaForCacheFormula,
} from '../scripts/lib/resilience-formula.mjs';
import {
  REQUIRED_GATE_IDS,
  buildAcceptanceArtifact,
  buildGateResults,
  buildSampledCountryEvidenceEntry,
} from '../scripts/capture-resilience-energy-v2-acceptance.mjs';
import { RESILIENCE_COHORTS } from './helpers/resilience-cohorts.mts';
import { MATCHED_PAIRS } from './helpers/resilience-matched-pairs.mts';

const here = dirname(fileURLToPath(import.meta.url));
const validationDir = resolve(here, '../docs/methodology/country-resilience-index/validation');
const benchmarkPath = resolve(validationDir, 'benchmark-results.json');
const backtestPath = resolve(validationDir, 'backtest-results.json');
const snapshotDir = resolve(here, '../docs/snapshots');
const runbookPath = resolve(here, '../docs/methodology/energy-v2-flag-flip-runbook.md');
const methodologyPath = resolve(here, '../docs/methodology/country-resilience-index.mdx');
const freezeScriptPath = resolve(here, '../scripts/freeze-resilience-ranking.mjs');
const compareScriptPath = resolve(here, '../scripts/compare-resilience-current-vs-proposed.mjs');
const energyV2CaptureScriptPath = resolve(here, '../scripts/capture-resilience-energy-v2-acceptance.mjs');

const EXPECTED_BENCHMARK_INDICES = ['HDI', 'INFORM', 'WorldRiskIndex'];
const EXPECTED_BACKTEST_FAMILIES = [
  'conflict-spillover',
  'food-crisis',
  'fx-stress',
  'power-outages',
  'refugee-surges',
  'sanctions-shocks',
  'sovereign-stress',
];
const EXPECTED_BACKTEST_DATA_SOURCES = new Map<string, string>([
  ['conflict-spillover', 'live'],
  ['food-crisis', 'live'],
  ['fx-stress', 'hardcoded'],
  ['power-outages', 'hardcoded'],
  ['refugee-surges', 'live'],
  ['sanctions-shocks', 'hardcoded'],
  ['sovereign-stress', 'hardcoded'],
]);
const POST_FLIP_RANKING_RE = /^resilience-ranking-live-post-pr1-(\d{4}-\d{2}-\d{2})\.json$/;
const ENERGY_V2_ACCEPTANCE_RE = /^resilience-energy-v2-acceptance-(\d{4}-\d{2}-\d{2})\.json$/;
const REQUIRED_ENERGY_V2_ACCEPTANCE_GATES = REQUIRED_GATE_IDS;

function readJson(path: string): unknown {
  assert.ok(existsSync(path), `${path} must exist`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readTextFile(path: string): string {
  assert.ok(existsSync(path), `${path} must exist`);
  return readFileSync(path, 'utf8');
}

function listSnapshotFiles(re: RegExp): string[] {
  if (!existsSync(snapshotDir)) return [];
  return readdirSync(snapshotDir)
    .filter((filename) => re.test(filename))
    .sort();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  assert.equal(typeof value, 'number', `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
}

function assertPositiveTimestamp(value: unknown, label: string): void {
  assertFiniteNumber(value, label);
  assert.ok(value > 0, `${label} must be non-zero`);
}

function assertString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value;
}

function assertFormulaMetadata(artifact: Record<string, unknown>, label: string): void {
  const cacheFormula = assertString(artifact._formula, `${label}._formula`);
  assert.ok(KNOWN_CACHE_FORMULAS.has(cacheFormula), `${label}._formula must be one of ${[...KNOWN_CACHE_FORMULAS].join(', ')}`);
  const methodologyFormula = assertString(artifact.methodologyFormula, `${label}.methodologyFormula`);
  assert.ok(
    KNOWN_METHODOLOGY_FORMULAS.has(methodologyFormula),
    `${label}.methodologyFormula must be one of ${[...KNOWN_METHODOLOGY_FORMULAS].join(', ')}`,
  );
  assert.equal(
    methodologyFormula,
    methodologyFormulaForCacheFormula(cacheFormula),
    `${label}.methodologyFormula must match ${label}._formula`,
  );
  if (cacheFormula === 'pc') {
    assertFiniteNumber(artifact.generatedAt, `${label}.generatedAt`);
    assert.ok(
      artifact.generatedAt >= PC_VALIDATION_ARTIFACT_MIN_GENERATED_AT,
      `${label} pc artifact generatedAt ${new Date(artifact.generatedAt).toISOString()} must be at or after ${new Date(PC_VALIDATION_ARTIFACT_MIN_GENERATED_AT).toISOString()}`,
    );
  }
}

function assertEnergyV2AcceptanceArtifact(artifact: Record<string, unknown>, filename: string): void {
  const [, fileDate] = ENERGY_V2_ACCEPTANCE_RE.exec(filename)!;

  assert.equal(artifact.artifactType, 'resilience-energy-v2-post-flip-acceptance');
  assert.equal(artifact.capturedAt, fileDate, `${filename}.capturedAt must match the filename date`);
  assert.ok(!('_note' in artifact), `${filename} must not be a placeholder`);
  assert.notEqual(
    artifact.comparison,
    'currentDomainAggregate_vs_proposedPillarCombined',
    `${filename} must not be the pillar-combine comparison harness output.`,
  );
  const generatedAt = assertString(artifact.generatedAt, `${filename}.generatedAt`);
  const generatedAtMs = Date.parse(generatedAt);
  assert.ok(!Number.isNaN(generatedAtMs), `${filename}.generatedAt must be an ISO timestamp`);
  assert.ok(
    generatedAtMs >= PC_VALIDATION_ARTIFACT_MIN_GENERATED_AT,
    `${filename}.generatedAt ${new Date(generatedAtMs).toISOString()} must be at or after ${new Date(PC_VALIDATION_ARTIFACT_MIN_GENERATED_AT).toISOString()}`,
  );

  const runtime = asRecord(artifact.runtime, `${filename}.runtime`);
  const manifest = asRecord(runtime.manifest, `${filename}.runtime.manifest`);
  assert.equal(manifest.formulaTag, 'pc');
  assert.equal(asRecord(manifest.constructVersions, `${filename}.runtime.manifest.constructVersions`).energy, 'v2');
  const rankingCache = asRecord(manifest.rankingCache, `${filename}.runtime.manifest.rankingCache`);
  assert.equal(rankingCache.count, 196);
  assert.equal(rankingCache.scored, 196);
  assert.equal(rankingCache.total, 196);

  const health = asRecord(runtime.health, `${filename}.runtime.health`);
  const checks = asRecord(health.energyV2SeedChecks, `${filename}.runtime.health.energyV2SeedChecks`);
  for (const checkName of ['lowCarbonGeneration', 'fossilElectricityShare', 'powerLosses']) {
    assert.equal(checks[checkName], 'OK', `${filename} health check ${checkName} must be OK`);
  }

  const baseline = asRecord(artifact.baseline, `${filename}.baseline`);
  assert.match(
    assertString(baseline.rankingSnapshot, `${filename}.baseline.rankingSnapshot`),
    /docs\/snapshots\/resilience-ranking-live-(?:pre-pr1-flip|pre-repair)-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const postFlip = asRecord(artifact.postFlip, `${filename}.postFlip`);
  assert.match(
    assertString(postFlip.rankingSnapshot, `${filename}.postFlip.rankingSnapshot`),
    /docs\/snapshots\/resilience-ranking-live-post-pr1-\d{4}-\d{2}-\d{2}\.json$/,
  );

  const acceptanceGates = asRecord(artifact.acceptanceGates, `${filename}.acceptanceGates`);
  assert.equal(acceptanceGates.verdict, 'PASS');
  const results = acceptanceGates.results;
  assert.ok(Array.isArray(results), `${filename}.acceptanceGates.results must be an array`);
  const resultById = new Map(results.map((rawResult) => {
    const result = asRecord(rawResult, `${filename}.acceptanceGates.result`);
    return [assertString(result.id, `${filename}.acceptanceGates.result.id`), result];
  }));
  for (const gateId of REQUIRED_ENERGY_V2_ACCEPTANCE_GATES) {
    const gate = resultById.get(gateId);
    assert.ok(gate, `${filename} must include ${gateId}`);
    assert.equal(gate.status, 'pass', `${filename} ${gateId} must pass for a committed post-flip acceptance artifact`);
  }

  assertSampledCountryEvidence(artifact.sampledCountryEvidence, filename);
}

function assertSampledCountryEvidence(value: unknown, label: string): void {
  const sampledCountryEvidence = asRecord(value, `${label}.sampledCountryEvidence`);
  const status = assertString(sampledCountryEvidence.status, `${label}.sampledCountryEvidence.status`);
  assert.ok(['captured', 'skipped'].includes(status), `${label}.sampledCountryEvidence.status must be captured or skipped`);
  const countries = sampledCountryEvidence.countries;
  assert.ok(Array.isArray(countries), `${label}.sampledCountryEvidence.countries must be an array`);

  if (status === 'captured') {
    assert.ok(countries.length > 0, `${label}.sampledCountryEvidence.countries must include sampled countries`);
    for (const [index, rawCountry] of countries.entries()) {
      const country = asRecord(rawCountry, `${label}.sampledCountryEvidence.countries.${index}`);
      assert.match(
        assertString(country.countryCode, `${label}.sampledCountryEvidence.countries.${index}.countryCode`),
        /^[A-Z]{2}$/,
      );
      assertFiniteNumber(country.scoreEndpointOverallScore, `${label}.sampledCountryEvidence.countries.${index}.scoreEndpointOverallScore`);
      const energyDimension = asRecord(country.energyDimension, `${label}.sampledCountryEvidence.countries.${index}.energyDimension`);
      assertFiniteNumber(energyDimension.score, `${label}.sampledCountryEvidence.countries.${index}.energyDimension.score`);
      assertFiniteNumber(energyDimension.coverage, `${label}.sampledCountryEvidence.countries.${index}.energyDimension.coverage`);
      assert.ok(
        energyDimension.coverage >= 0 && energyDimension.coverage <= 1,
        `${label}.sampledCountryEvidence.countries.${index}.energyDimension.coverage must be in [0, 1]`,
      );
      assert.ok(
        energyDimension.imputationClass === null || typeof energyDimension.imputationClass === 'string',
        `${label}.sampledCountryEvidence.countries.${index}.energyDimension.imputationClass must be string or null`,
      );
    }
  }
}

describe('resilience validation artifacts', () => {
  it('commits a real benchmark artifact for the current comparator set', () => {
    const benchmark = asRecord(readJson(benchmarkPath), 'benchmark artifact');

    assertPositiveTimestamp(benchmark.generatedAt, 'benchmark.generatedAt');
    assertFormulaMetadata(benchmark, 'benchmark');
    assert.ok(!('_note' in benchmark), 'benchmark artifact must not be a placeholder');

    assert.equal(typeof benchmark.license, 'string', 'benchmark.license must be a string');
    assert.ok(!/\bFSI\b|Fragile States|Fund for Peace/i.test(benchmark.license), 'benchmark license must not reference retired FSI data');

    const hypotheses = benchmark.hypotheses;
    assert.ok(Array.isArray(hypotheses), 'benchmark.hypotheses must be an array');
    assert.equal(hypotheses.length, EXPECTED_BENCHMARK_INDICES.length, 'benchmark must have one hypothesis per current comparator');
    assert.deepEqual(
      hypotheses.map((entry) => asRecord(entry, 'benchmark hypothesis').index).sort(),
      EXPECTED_BENCHMARK_INDICES,
    );

    for (const raw of hypotheses) {
      const hypothesis = asRecord(raw, 'benchmark hypothesis');
      assert.equal(hypothesis.pillar, 'overall', `${hypothesis.index} benchmark must target overall resilience`);
      assert.equal(hypothesis.pass, true, `${hypothesis.index} benchmark gate must pass`);
      assert.ok(['positive', 'negative'].includes(String(hypothesis.direction)), `${hypothesis.index} must declare a direction`);
      assertFiniteNumber(hypothesis.expected, `${hypothesis.index}.expected`);
      assertFiniteNumber(hypothesis.actual, `${hypothesis.index}.actual`);
    }

    const correlations = asRecord(benchmark.correlations, 'benchmark.correlations');
    const sourceStatus = asRecord(benchmark.sourceStatus, 'benchmark.sourceStatus');
    assert.deepEqual(Object.keys(correlations).sort(), EXPECTED_BENCHMARK_INDICES);
    assert.deepEqual(Object.keys(sourceStatus).sort(), EXPECTED_BENCHMARK_INDICES);

    for (const index of EXPECTED_BENCHMARK_INDICES) {
      const correlation = asRecord(correlations[index], `benchmark.correlations.${index}`);
      assertFiniteNumber(correlation.spearman, `${index}.spearman`);
      assertFiniteNumber(correlation.pearson, `${index}.pearson`);
      assertFiniteNumber(correlation.n, `${index}.n`);
      assert.ok(correlation.n > 0, `${index}.n must be positive`);

      assert.equal(typeof sourceStatus[index], 'string', `${index} source status must be a string`);
      assert.notEqual(sourceStatus[index], '', `${index} source status must not be empty`);
    }

    assert.ok(Array.isArray(benchmark.outliers), 'benchmark.outliers must be an array');
  });

  it('commits a real passing backtest artifact for all seven families', () => {
    const backtest = asRecord(readJson(backtestPath), 'backtest artifact');

    assertPositiveTimestamp(backtest.generatedAt, 'backtest.generatedAt');
    assertFormulaMetadata(backtest, 'backtest');
    assert.ok(!('_note' in backtest), 'backtest artifact must not be a placeholder');
    assert.equal(backtest.holdoutPeriod, '2024-2025');
    assert.equal(backtest.aucThreshold, 0.75);
    assert.equal(backtest.gateWidth, 0.03);
    assert.equal(backtest.overallPass, true, 'backtest.overallPass must be true');

    const families = backtest.families;
    assert.ok(Array.isArray(families), 'backtest.families must be an array');
    assert.equal(families.length, EXPECTED_BACKTEST_FAMILIES.length, 'backtest must include all event families');
    assert.deepEqual(
      families.map((entry) => String(asRecord(entry, 'backtest family').id)).sort(),
      EXPECTED_BACKTEST_FAMILIES,
    );

    for (const raw of families) {
      const family = asRecord(raw, 'backtest family');
      assert.equal(family.pass, true, `${family.id} gate must pass`);
      assert.equal(
        family.dataSource,
        EXPECTED_BACKTEST_DATA_SOURCES.get(String(family.id)),
        `${family.id} dataSource must match the documented source split`,
      );
      assert.ok(Array.isArray(family.labelSources), `${family.id}.labelSources must be an array`);
      assert.ok(family.labelSources.length > 0, `${family.id}.labelSources must not be empty`);
      if (family.dataSource === 'hardcoded') {
        assert.ok(
          family.labelSources.some((source) => typeof source === 'string' && /^https?:\/\//.test(source)),
          `${family.id}.labelSources must include at least one source URL for curated reference sets`,
        );
      }
      assertFiniteNumber(family.auc, `${family.id}.auc`);
      assert.ok(family.auc >= 0 && family.auc <= 1, `${family.id}.auc must be in [0, 1]`);
      assert.equal(family.threshold, 0.75, `${family.id}.threshold must match AUC target`);
      assert.equal(family.gateWidth, 0.03, `${family.id}.gateWidth must match release gate width`);
      assertFiniteNumber(family.n, `${family.id}.n`);
      assert.ok(family.n > 0, `${family.id}.n must be positive`);
      assertFiniteNumber(family.positives, `${family.id}.positives`);
      assert.ok(family.positives > 0, `${family.id}.positives must be positive`);
    }

    const summary = asRecord(backtest.summary, 'backtest.summary');
    assert.equal(summary.totalFamilies, EXPECTED_BACKTEST_FAMILIES.length);
    assert.equal(summary.passed, EXPECTED_BACKTEST_FAMILIES.length);
    assert.equal(summary.failed, 0);
    assertFiniteNumber(summary.totalCountries, 'backtest.summary.totalCountries');
    assert.ok(summary.totalCountries > 0, 'backtest.summary.totalCountries must be positive');
  });

  it('keeps missing post-flip energy-v2 artifact capture explicit and actionable', () => {
    const postFlipRankingFiles = listSnapshotFiles(POST_FLIP_RANKING_RE);
    const energyV2AcceptanceFiles = listSnapshotFiles(ENERGY_V2_ACCEPTANCE_RE);
    const runbook = readTextFile(runbookPath);
    const methodology = readTextFile(methodologyPath);
    const freezeScript = readTextFile(freezeScriptPath);
    const compareScript = readTextFile(compareScriptPath);
    const energyV2CaptureScript = readTextFile(energyV2CaptureScriptPath);

    assert.match(
      runbook,
      /formulaTag == "pc"[\s\S]*constructVersions\.energy == "v2"[\s\S]*rankingCache\.count == rankingCache\.scored == rankingCache\.total == 196/,
      'runbook must preserve the public post-flip manifest evidence needed for closeout triage.',
    );
    assert.match(
      runbook,
      /lowCarbonGeneration[\s\S]*fossilElectricityShare[\s\S]*powerLosses[\s\S]*OK/,
      'runbook must name the three energy-v2 health checks and their expected OK status.',
    );
    if (postFlipRankingFiles.length === 0 || energyV2AcceptanceFiles.length === 0) {
      assert.match(
        methodology,
        /post-flip ranking and acceptance artifacts still need a credentialed operator capture/,
        'methodology doc must not imply the post-flip closeout artifacts are already committed while either required artifact is absent.',
      );
    }
    assert.match(
      freezeScript,
      /post-flip ranking snapshots must verify score anchors through get-resilience-score/,
      'freeze script must explain why unauthenticated post-flip snapshot capture is insufficient.',
    );
    assert.match(
      compareScript,
      /currentDomainAggregate_vs_proposedPillarCombined/,
      'compare script must remain identifiable as the pillar-combine harness, not the energy-v2 post-flip acceptance artifact.',
    );
    assert.match(
      energyV2CaptureScript,
      /requires a committed post-flip PR1 ranking artifact/i,
      'energy-v2 acceptance harness must require real post-flip ranking evidence before writing an artifact.',
    );
    assert.match(
      runbook,
      /capture-resilience-energy-v2-acceptance\.mjs/,
      'runbook must point operators at the dedicated energy-v2 acceptance harness.',
    );

    if (postFlipRankingFiles.length === 0) {
      assert.match(
        runbook,
        /WORLDMONITOR_API_KEY[\s\S]*get-resilience-score[\s\S]*Pro authentication required/,
        'runbook must explain that the post-flip ranking artifact requires a Pro/API key for score-anchor verification.',
      );
      assert.ok(
        runbook.includes('resilience-ranking-live-post-pr1-*.json') ||
          runbook.includes('resilience-ranking-live-post-pr1-{date}.json'),
        'runbook must name the required post-flip ranking artifact pattern.',
      );
    }

    if (energyV2AcceptanceFiles.length === 0) {
      assert.match(
        runbook,
        /capture-resilience-energy-v2-acceptance\.mjs[\s\S]*do\s+not commit (?:a )?synthetic acceptance JSON/i,
        'runbook must block synthetic energy-v2 acceptance artifacts until the dedicated harness returns PASS.',
      );
      assert.match(
        runbook,
        /resilience-energy-v2-acceptance-\{date\}\.json/,
        'runbook must name the required energy-v2 acceptance artifact pattern.',
      );
    }
  });

  it('builds a passing energy-v2 acceptance artifact only from ranking snapshot inputs', () => {
    const countryCodes = new Set<string>();
    for (const cohort of RESILIENCE_COHORTS) {
      for (const countryCode of cohort.countryCodes) countryCodes.add(countryCode);
    }
    for (const pair of MATCHED_PAIRS) {
      countryCodes.add(pair.higherExpected);
      countryCodes.add(pair.lowerExpected);
    }

    const scores: Record<string, number> = Object.fromEntries([...countryCodes].map((countryCode) => [countryCode, 50]));
    for (const pair of MATCHED_PAIRS) {
      scores[pair.higherExpected] = Math.max(scores[pair.higherExpected] ?? 0, 70);
      scores[pair.lowerExpected] = Math.min(scores[pair.lowerExpected] ?? 50, 60);
    }
    const items = Object.entries(scores).map(([countryCode, overallScore], index) => ({
      rank: index + 1,
      countryCode,
      overallScore,
    }));
    const baselineSnapshot = { capturedAt: '2026-04-22', commitSha: 'baseline', items, greyedOut: [] };
    const postFlipSnapshot = {
      capturedAt: '2026-06-03',
      commitSha: 'post-flip',
      source: 'Live capture via tests',
      methodologyFormula: 'pillar-combined-penalized-v1',
      formulaVerification: { declaredFormula: 'pillar-combined-penalized-v1' },
      items,
      greyedOut: [],
    };
    const extractionCoverage = {
      totalIndicators: 50,
      implemented: 45,
      notImplemented: 5,
      unregisteredInHarness: 0,
      coreImplemented: 40,
      coreTotal: 45,
      extractionRuleCount: 50,
    };

    const gates = buildGateResults({
      baselineScores: scores,
      postFlipScores: scores,
      extractionCoverage,
    });
    for (const gateId of REQUIRED_ENERGY_V2_ACCEPTANCE_GATES) {
      assert.equal(gates.find((gate) => gate.id === gateId)?.status, 'pass', `${gateId} should pass on stable fixture rankings`);
    }

    const artifact = buildAcceptanceArtifact({
      generatedAt: '2026-06-03T12:00:00.000Z',
      baseUrl: 'https://www.worldmonitor.app',
      baselineSnapshotPath: resolve(snapshotDir, 'resilience-ranking-live-pre-repair-2026-04-22.json'),
      baselineSnapshot,
      postFlipSnapshotPath: resolve(snapshotDir, 'resilience-ranking-live-post-pr1-2026-06-03.json'),
      postFlipSnapshot,
      runtimeEvidence: {
        manifest: {
          formulaTag: 'pc',
          constructVersions: { energy: 'v2' },
          rankingCache: { count: 196, scored: 196, total: 196 },
        },
        health: {
          checks: {
            lowCarbonGeneration: { status: 'OK' },
            fossilElectricityShare: { status: 'OK' },
            powerLosses: { status: 'OK' },
          },
        },
      },
      sampledCountryEvidence: { status: 'skipped', countries: [] },
      extractionCoverage,
    });

    assert.equal(artifact.acceptanceGates.verdict, 'PASS');
    assert.equal(artifact.capturedAt, '2026-06-03');
    assert.equal(artifact.postFlip.rankingTotals.scored, items.length);
    assertEnergyV2AcceptanceArtifact(asRecord(artifact, 'fixture acceptance artifact'), 'resilience-energy-v2-acceptance-2026-06-03.json');
  });

  it('captures sampled energy evidence from realistic score response domains', () => {
    const sampledCountry = buildSampledCountryEvidenceEntry({
      countryCode: 'FR',
      postFlipScores: { FR: 82.237 },
      score: {
        countryCode: 'FR',
        overallScore: 82.234,
        domains: [
          {
            id: 'economic',
            score: 78.1,
            weight: 0.2,
            dimensions: [
              { id: 'macroFiscal', score: 76.3, coverage: 0.91, imputationClass: '' },
            ],
          },
          {
            id: 'energy',
            score: 86.4,
            weight: 0.11,
            dimensions: [
              {
                id: 'energy',
                score: 86.456,
                coverage: 0.876,
                observedWeight: 1,
                imputedWeight: 0,
                imputationClass: '',
              },
            ],
          },
        ],
      },
    });

    assert.deepEqual(sampledCountry, {
      countryCode: 'FR',
      scoreEndpointOverallScore: 82.23,
      rankingSnapshotOverallScore: 82.24,
      energyDimension: {
        score: 86.46,
        coverage: 0.88,
        imputationClass: '',
      },
    });
    assertSampledCountryEvidence(
      { status: 'captured', countries: [sampledCountry] },
      'fixture sampled country evidence',
    );
    assert.throws(
      () => buildSampledCountryEvidenceEntry({
        countryCode: 'DE',
        postFlipScores: { DE: 80 },
        score: {
          countryCode: 'DE',
          overallScore: 80,
          domains: [{ id: 'energy', score: 70, weight: 0.11, dimensions: [] }],
        },
      }),
      /did not include energy dimension under domains\[\]\.dimensions/,
    );
  });

  it('validates any committed post-flip PR1 ranking artifacts', () => {
    for (const filename of listSnapshotFiles(POST_FLIP_RANKING_RE)) {
      const [, fileDate] = POST_FLIP_RANKING_RE.exec(filename)!;
      const snapshot = asRecord(readJson(resolve(snapshotDir, filename)), filename);

      assert.equal(snapshot.capturedAt, fileDate, `${filename}.capturedAt must match the date in the filename`);
      assert.equal(snapshot.schemaVersion, '2.0', `${filename}.schemaVersion must match the live score shape`);
      assert.equal(snapshot.methodologyFormula, 'pillar-combined-penalized-v1');
      assert.ok(!('_note' in snapshot), `${filename} must not be a placeholder`);

      const formulaVerification = asRecord(snapshot.formulaVerification, `${filename}.formulaVerification`);
      assert.equal(formulaVerification.declaredFormula, 'pillar-combined-penalized-v1');
      assert.match(assertString(formulaVerification.scoreEndpoint, `${filename}.formulaVerification.scoreEndpoint`), /\/api\/resilience\/v1\/get-resilience-score$/);
      assert.match(assertString(formulaVerification.rankingEndpoint, `${filename}.formulaVerification.rankingEndpoint`), /\/api\/resilience\/v1\/get-resilience-ranking\?refresh=1$/);
      const checks = formulaVerification.checks;
      assert.ok(Array.isArray(checks) && checks.length >= 2, `${filename} must verify at least two score anchors`);
      for (const rawCheck of checks) {
        const check = asRecord(rawCheck, `${filename}.formulaVerification.check`);
        assert.match(assertString(check.countryCode, `${filename}.formulaVerification.check.countryCode`), /^[A-Z]{2}$/);
        assertFiniteNumber(check.absoluteError, `${filename}.formulaVerification.${check.countryCode}.absoluteError`);
        assertFiniteNumber(check.rankingAbsoluteError, `${filename}.formulaVerification.${check.countryCode}.rankingAbsoluteError`);
        assert.ok(
          check.absoluteError <= Number(formulaVerification.tolerance),
          `${filename} ${check.countryCode} must match the declared formula within tolerance`,
        );
        assert.ok(
          check.rankingAbsoluteError <= Number(formulaVerification.tolerance),
          `${filename} ${check.countryCode} ranking score must match the score endpoint within tolerance`,
        );
      }

      const totals = asRecord(snapshot.totals, `${filename}.totals`);
      assertFiniteNumber(totals.rankedCountries, `${filename}.totals.rankedCountries`);
      assertFiniteNumber(totals.greyedOutCount, `${filename}.totals.greyedOutCount`);
      assert.ok(
        totals.rankedCountries + totals.greyedOutCount >= 190,
        `${filename} must represent the full country universe, got ranked=${totals.rankedCountries} greyedOut=${totals.greyedOutCount}`,
      );
      assert.ok(Array.isArray(snapshot.items), `${filename}.items must be an array`);
      assert.ok(Array.isArray(snapshot.greyedOut), `${filename}.greyedOut must be an array`);
      assert.equal((snapshot.items as unknown[]).length, totals.rankedCountries);
      assert.equal((snapshot.greyedOut as unknown[]).length, totals.greyedOutCount);
    }
  });

  it('rejects backdated energy-v2 post-flip acceptance artifact timestamps', () => {
    const filename = 'resilience-energy-v2-acceptance-2026-06-03.json';
    const backdatedArtifact = {
      artifactType: 'resilience-energy-v2-post-flip-acceptance',
      capturedAt: '2026-06-03',
      comparison: 'energyV2PostFlipAcceptance',
      generatedAt: '2026-05-27T00:00:00.000Z',
      runtime: {
        manifest: {
          formulaTag: 'pc',
          constructVersions: { energy: 'v2' },
          rankingCache: { count: 196, scored: 196, total: 196 },
        },
        health: {
          energyV2SeedChecks: {
            lowCarbonGeneration: 'OK',
            fossilElectricityShare: 'OK',
            powerLosses: 'OK',
          },
        },
      },
      baseline: {
        rankingSnapshot: 'docs/snapshots/resilience-ranking-live-pre-pr1-flip-2026-05-27.json',
      },
      postFlip: {
        rankingSnapshot: 'docs/snapshots/resilience-ranking-live-post-pr1-2026-06-03.json',
      },
      acceptanceGates: {
        verdict: 'PASS',
        results: REQUIRED_ENERGY_V2_ACCEPTANCE_GATES.map((id) => ({ id, status: 'pass' })),
      },
    };

    assert.throws(
      () => assertEnergyV2AcceptanceArtifact(backdatedArtifact, filename),
      /must be at or after/,
    );
  });

  it('validates any committed energy-v2 post-flip acceptance artifacts', () => {
    for (const filename of listSnapshotFiles(ENERGY_V2_ACCEPTANCE_RE)) {
      const artifact = asRecord(readJson(resolve(snapshotDir, filename)), filename);
      assertEnergyV2AcceptanceArtifact(artifact, filename);
    }
  });
});
