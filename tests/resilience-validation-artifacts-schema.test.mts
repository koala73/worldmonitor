import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const validationDir = resolve(here, '../docs/methodology/country-resilience-index/validation');
const benchmarkPath = resolve(validationDir, 'benchmark-results.json');
const backtestPath = resolve(validationDir, 'backtest-results.json');

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
const KNOWN_CACHE_FORMULAS = new Set(['d6', 'pc']);
const KNOWN_METHODOLOGY_FORMULAS = new Set(['domain-weighted-6d', 'pillar-combined-penalized-v1']);

function readJson(path: string): unknown {
  assert.ok(existsSync(path), `${path} must exist`);
  return JSON.parse(readFileSync(path, 'utf8'));
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

function assertFormulaMetadata(artifact: Record<string, unknown>, label: string): void {
  const cacheFormula = artifact._formula;
  const methodologyFormula = artifact.methodologyFormula;
  assert.equal(typeof cacheFormula, 'string', `${label}._formula must be a string`);
  assert.ok(KNOWN_CACHE_FORMULAS.has(cacheFormula), `${label}._formula must be one of ${[...KNOWN_CACHE_FORMULAS].join(', ')}`);
  assert.equal(typeof methodologyFormula, 'string', `${label}.methodologyFormula must be a string`);
  assert.ok(
    KNOWN_METHODOLOGY_FORMULAS.has(methodologyFormula),
    `${label}.methodologyFormula must be one of ${[...KNOWN_METHODOLOGY_FORMULAS].join(', ')}`,
  );
  assert.equal(
    methodologyFormula,
    cacheFormula === 'pc' ? 'pillar-combined-penalized-v1' : 'domain-weighted-6d',
    `${label}.methodologyFormula must match ${label}._formula`,
  );
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
});
