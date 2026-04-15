import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  spearman,
  pearson,
  rankArray,
  detectOutliers,
  HYPOTHESES,
  runBenchmark,
} from '../scripts/benchmark-resilience-external.mjs';

describe('rankArray', () => {
  it('assigns sequential ranks for distinct values', () => {
    assert.deepEqual(rankArray([10, 30, 20]), [1, 3, 2]);
  });

  it('assigns average ranks for tied values', () => {
    assert.deepEqual(rankArray([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  });

  it('handles single element', () => {
    assert.deepEqual(rankArray([5]), [1]);
  });

  it('handles all tied', () => {
    assert.deepEqual(rankArray([7, 7, 7]), [2, 2, 2]);
  });
});

describe('pearson', () => {
  it('returns 1 for perfectly correlated arrays', () => {
    const r = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    assert.ok(Math.abs(r - 1) < 1e-10, `expected ~1, got ${r}`);
  });

  it('returns -1 for perfectly inversely correlated arrays', () => {
    const r = pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    assert.ok(Math.abs(r - (-1)) < 1e-10, `expected ~-1, got ${r}`);
  });

  it('returns near 0 for uncorrelated arrays', () => {
    const r = pearson([1, 2, 3, 4, 5, 6], [3, 1, 6, 2, 5, 4]);
    assert.ok(Math.abs(r) < 0.5, `expected near 0, got ${r}`);
  });

  it('returns NaN for arrays shorter than 3', () => {
    assert.ok(Number.isNaN(pearson([1, 2], [3, 4])));
  });

  it('returns 0 when one array is constant', () => {
    assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), 0);
  });
});

describe('spearman', () => {
  it('returns 1 for monotonically increasing relationship', () => {
    const r = spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
    assert.ok(Math.abs(r - 1) < 1e-10, `expected ~1, got ${r}`);
  });

  it('returns -1 for monotonically decreasing relationship', () => {
    const r = spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
    assert.ok(Math.abs(r - (-1)) < 1e-10, `expected ~-1, got ${r}`);
  });

  it('handles non-linear monotonic relationship', () => {
    const r = spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25]);
    assert.ok(Math.abs(r - 1) < 1e-10, `expected ~1 for monotonic, got ${r}`);
  });

  it('returns NaN for arrays shorter than 3', () => {
    assert.ok(Number.isNaN(spearman([1], [2])));
  });
});

describe('detectOutliers', () => {
  it('returns empty for small arrays', () => {
    assert.deepEqual(detectOutliers([1, 2, 3], [3, 2, 1], ['A', 'B', 'C']), []);
  });

  it('detects an outlier in synthetic data', () => {
    const wm = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const ext = [100, 90, 80, 70, 60, 50, 40, 30, 20, 500];
    const codes = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH', 'II', 'JJ'];
    const outliers = detectOutliers(wm, ext, codes);
    assert.ok(outliers.length > 0, 'expected at least one outlier');
    assert.ok(outliers.some(o => o.countryCode === 'JJ'), 'expected JJ to be an outlier');
  });

  it('returns empty when relationship is perfectly linear', () => {
    const wm = [10, 20, 30, 40, 50, 60, 70, 80];
    const ext = [80, 70, 60, 50, 40, 30, 20, 10];
    const codes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const outliers = detectOutliers(wm, ext, codes);
    assert.equal(outliers.length, 0, 'perfect linear should have no outliers');
  });
});

describe('HYPOTHESES', () => {
  // INFORM (negative) + HDI (positive) + WRI (negative). FSI was dropped
  // (no fresh bulk data) and ND-GAIN is deferred until the seeder can unzip
  // the 2026 archive — both documented at the top of benchmark-resilience-external.mjs.
  it('has 3 hypothesis entries', () => {
    assert.equal(HYPOTHESES.length, 3);
  });

  it('each hypothesis has required fields', () => {
    for (const h of HYPOTHESES) {
      assert.ok(h.index, 'missing index');
      assert.ok(h.pillar, 'missing pillar');
      assert.ok(['positive', 'negative'].includes(h.direction), `invalid direction: ${h.direction}`);
      assert.ok(typeof h.minSpearman === 'number', 'minSpearman must be a number');
      assert.ok(h.minSpearman > 0 && h.minSpearman < 1, `minSpearman out of range: ${h.minSpearman}`);
    }
  });

  it('INFORM expects negative correlation', () => {
    const inform = HYPOTHESES.find(h => h.index === 'INFORM');
    assert.equal(inform.direction, 'negative');
  });

  it('HDI expects positive correlation', () => {
    const hdi = HYPOTHESES.find(h => h.index === 'HDI');
    assert.equal(hdi.direction, 'positive');
  });

  it('WorldRiskIndex expects negative correlation', () => {
    const wri = HYPOTHESES.find(h => h.index === 'WorldRiskIndex');
    assert.equal(wri.direction, 'negative');
  });
});

describe('runBenchmark (mocked)', () => {
  it('produces correct output shape with mock data', async () => {
    const wmScores = new Map([
      ['US', 85], ['GB', 78], ['DE', 80], ['FR', 76], ['JP', 82],
      ['IN', 45], ['BR', 50], ['NG', 30], ['SO', 20], ['CH', 88],
    ]);

    const mockInform = async () => ({
      scores: new Map([
        ['US', 2.1], ['GB', 2.5], ['DE', 2.3], ['FR', 2.8], ['JP', 2.0],
        ['IN', 5.5], ['BR', 4.8], ['NG', 7.2], ['SO', 8.5], ['CH', 1.8],
      ]),
      source: 'mock',
    });

    const mockNdGain = async () => ({
      scores: new Map([
        ['US', 72], ['GB', 70], ['DE', 71], ['FR', 68], ['JP', 73],
        ['IN', 42], ['BR', 45], ['NG', 35], ['SO', 28], ['CH', 75],
      ]),
      source: 'mock',
    });

    const mockWri = async () => ({
      scores: new Map([
        ['US', 3.8], ['GB', 4.2], ['DE', 3.6], ['FR', 4.5], ['JP', 5.1],
        ['IN', 7.1], ['BR', 5.9], ['NG', 9.3], ['SO', 12.1], ['CH', 2.9],
      ]),
      source: 'mock',
    });

    const mockFsi = async () => ({
      scores: new Map([
        ['US', 38], ['GB', 36], ['DE', 30], ['FR', 35], ['JP', 28],
        ['IN', 72], ['BR', 68], ['NG', 98], ['SO', 112], ['CH', 25],
      ]),
      source: 'mock',
    });

    const result = await runBenchmark({
      wmScores,
      fetchInform: mockInform,
      fetchHdi: mockNdGain,  // HDI test fixture reused — same correlation pattern
      fetchWri: mockWri,
      dryRun: true,
    });

    assert.ok(result.generatedAt > 0, 'missing generatedAt');
    assert.ok(result.license, 'missing license note');
    assert.equal(result.hypotheses.length, 3, 'expected 3 hypotheses');
    assert.ok(result.correlations.INFORM, 'missing INFORM correlation');
    assert.ok(result.correlations.HDI, 'missing HDI correlation');
    assert.ok(result.correlations.WorldRiskIndex, 'missing WorldRiskIndex correlation');
    assert.ok(Array.isArray(result.outliers), 'outliers must be an array');
    assert.ok(result.sourceStatus, 'missing sourceStatus');

    for (const [, corr] of Object.entries(result.correlations)) {
      assert.ok(typeof corr.spearman === 'number', 'spearman must be number');
      assert.ok(typeof corr.pearson === 'number', 'pearson must be number');
      assert.ok(typeof corr.n === 'number', 'n must be number');
      assert.equal(corr.n, 10, `expected 10 countries, got ${corr.n}`);
    }

    for (const h of result.hypotheses) {
      assert.ok(typeof h.pass === 'boolean', 'pass must be boolean');
      assert.ok(h.index, 'hypothesis must have index');
      assert.ok(h.pillar, 'hypothesis must have pillar');
    }
  });

  it('INFORM shows negative correlation with mock data', async () => {
    const wmScores = new Map([
      ['US', 85], ['GB', 78], ['DE', 80], ['FR', 76], ['JP', 82],
      ['IN', 45], ['BR', 50], ['NG', 30], ['SO', 20], ['CH', 88],
    ]);

    const mockInform = async () => ({
      scores: new Map([
        ['US', 2.1], ['GB', 2.5], ['DE', 2.3], ['FR', 2.8], ['JP', 2.0],
        ['IN', 5.5], ['BR', 4.8], ['NG', 7.2], ['SO', 8.5], ['CH', 1.8],
      ]),
      source: 'mock',
    });
    const emptyFetcher = async () => ({ scores: new Map(), source: 'mock' });

    const result = await runBenchmark({
      wmScores,
      fetchInform: mockInform,
      fetchHdi: emptyFetcher,
      fetchWri: emptyFetcher,
      dryRun: true,
    });

    const informCorr = result.correlations.INFORM;
    assert.ok(informCorr.spearman < 0, `INFORM spearman should be negative, got ${informCorr.spearman}`);
  });

  it('handles empty external indices gracefully', async () => {
    const wmScores = new Map([['US', 85], ['GB', 78], ['DE', 80]]);
    const emptyFetcher = async () => ({ scores: new Map(), source: 'unavailable' });

    const result = await runBenchmark({
      wmScores,
      fetchInform: emptyFetcher,
      fetchHdi: emptyFetcher,
      fetchWri: emptyFetcher,
      dryRun: true,
    });

    assert.equal(result.hypotheses.filter(h => h.pass).length, 0, 'no hypotheses should pass with empty data');
    assert.equal(result.outliers.length, 0, 'no outliers with empty data');
  });

  it('outlier entries have commentary', async () => {
    const n = 20;
    const wmScores = new Map();
    const informScores = new Map();
    const codes = [];
    for (let i = 0; i < n; i++) {
      const code = String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
      codes.push(code);
      wmScores.set(code, 10 + i * 4);
      informScores.set(code, 9 - i * 0.4);
    }
    wmScores.set(codes[n - 1], 10);
    informScores.set(codes[n - 1], 0.5);

    const result = await runBenchmark({
      wmScores,
      fetchInform: async () => ({ scores: informScores, source: 'mock' }),
      fetchHdi: async () => ({ scores: new Map(), source: 'mock' }),
      fetchWri: async () => ({ scores: new Map(), source: 'mock' }),
      dryRun: true,
    });

    for (const o of result.outliers) {
      assert.ok(o.commentary, `outlier ${o.countryCode} missing commentary`);
      assert.ok(typeof o.residual === 'number', 'residual must be number');
      assert.ok(o.index, 'outlier must have index name');
    }
  });
});
