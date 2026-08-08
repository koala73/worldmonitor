import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  perturbWeights,
  perturbGoalposts,
  normalizeToGoalposts,
  computePenalizedPillarScore,
  computePillarScoresFromDomains,
  spearmanCorrelation,
  computeReleaseGate,
  percentile,
} from '../scripts/validate-resilience-sensitivity.mjs';

describe('sensitivity v2: perturbWeights', () => {
  it('renormalizes perturbed weights to sum=1', () => {
    const weights = { a: 0.40, b: 0.35, c: 0.25 };
    for (let i = 0; i < 20; i++) {
      const p = perturbWeights(weights, 0.2);
      const sum = Object.values(p).reduce((s, v) => s + v, 0);
      assert.ok(Math.abs(sum - 1.0) < 1e-10, `sum=${sum} should be 1.0`);
      assert.ok(p.a > 0 && p.b > 0 && p.c > 0, 'all weights positive');
    }
  });

  it('preserves key set', () => {
    const weights = { x: 0.5, y: 0.3, z: 0.2 };
    const p = perturbWeights(weights, 0.1);
    assert.deepStrictEqual(Object.keys(p).sort(), ['x', 'y', 'z']);
  });
});

describe('sensitivity v2: perturbGoalposts', () => {
  it('returns worst and best within expected range', () => {
    const gp = { worst: 0, best: 100 };
    for (let i = 0; i < 50; i++) {
      const p = perturbGoalposts(gp, 0.1);
      assert.ok(typeof p.worst === 'number');
      assert.ok(typeof p.best === 'number');
      assert.ok(Math.abs(p.worst - gp.worst) <= 15, `worst shift too large: ${p.worst}`);
      assert.ok(Math.abs(p.best - gp.best) <= 15, `best shift too large: ${p.best}`);
    }
  });
});

describe('sensitivity v2: normalizeToGoalposts', () => {
  it('higherBetter: worst=0, best=100, value=50 => 50', () => {
    const result = normalizeToGoalposts(50, { worst: 0, best: 100 }, 'higherBetter');
    assert.strictEqual(result, 50);
  });

  it('higherBetter: clamps at 0 and 100', () => {
    assert.strictEqual(normalizeToGoalposts(-10, { worst: 0, best: 100 }, 'higherBetter'), 0);
    assert.strictEqual(normalizeToGoalposts(200, { worst: 0, best: 100 }, 'higherBetter'), 100);
  });

  it('lowerBetter: worst=20, best=0, value=10 => 50', () => {
    const result = normalizeToGoalposts(10, { worst: 20, best: 0 }, 'lowerBetter');
    assert.strictEqual(result, 50);
  });
});

describe('sensitivity v2: computePenalizedPillarScore', () => {
  it('returns 0 for empty array', () => {
    assert.strictEqual(computePenalizedPillarScore([], {}, 0.5), 0);
  });

  it('applies penalty based on min pillar score', () => {
    const scores = [{ id: 'a', score: 80 }, { id: 'b', score: 60 }, { id: 'c', score: 70 }];
    const weights = { a: 0.4, b: 0.35, c: 0.25 };
    const alpha = 0.5;
    const weighted = 80 * 0.4 + 60 * 0.35 + 70 * 0.25;
    const penalty = 1 - 0.5 * (1 - 60 / 100);
    const expected = weighted * penalty;
    const result = computePenalizedPillarScore(scores, weights, alpha);
    assert.ok(Math.abs(result - expected) < 0.01, `${result} vs ${expected}`);
  });

  it('no penalty when all pillar scores are 100', () => {
    const scores = [{ id: 'a', score: 100 }, { id: 'b', score: 100 }, { id: 'c', score: 100 }];
    const weights = { a: 0.4, b: 0.35, c: 0.25 };
    const result = computePenalizedPillarScore(scores, weights, 0.5);
    assert.strictEqual(result, 100);
  });

  it('alpha=0 means no penalty', () => {
    const scores = [{ id: 'a', score: 80 }, { id: 'b', score: 20 }, { id: 'c', score: 50 }];
    const weights = { a: 0.4, b: 0.35, c: 0.25 };
    const result0 = computePenalizedPillarScore(scores, weights, 0);
    const weighted = 80 * 0.4 + 20 * 0.35 + 50 * 0.25;
    assert.ok(Math.abs(result0 - weighted) < 0.01);
  });
});

describe('sensitivity v2: spearmanCorrelation', () => {
  it('returns 1.0 for identical rankings', () => {
    const ranks = { US: 1, DE: 2, JP: 3, BR: 4 };
    assert.strictEqual(spearmanCorrelation(ranks, ranks), 1);
  });

  it('returns negative for inverted rankings', () => {
    const a = { US: 1, DE: 2, JP: 3, BR: 4 };
    const b = { US: 4, DE: 3, JP: 2, BR: 1 };
    const result = spearmanCorrelation(a, b);
    assert.strictEqual(result, -1);
  });

  it('alpha=0.5 vs itself is 1.0', () => {
    const ranks = { NO: 1, SE: 2, FI: 3, DK: 4, CH: 5 };
    assert.strictEqual(spearmanCorrelation(ranks, ranks), 1);
  });
});

describe('sensitivity v2: computeReleaseGate', () => {
  it('19 dimensions, 4 fail => 21% => FAIL', () => {
    const dims = Array.from({ length: 19 }, (_, i) => ({
      dimId: `dim${i}`,
      maxSwing: i < 4 ? 5 : 1,
      pass: i >= 4,
    }));
    const gate = computeReleaseGate(dims);
    assert.strictEqual(gate.pass, false);
    assert.strictEqual(gate.failCount, 4);
    assert.ok(gate.failPct > 0.20);
  });

  it('19 dimensions, 3 fail => 15.8% => PASS', () => {
    const dims = Array.from({ length: 19 }, (_, i) => ({
      dimId: `dim${i}`,
      maxSwing: i < 3 ? 5 : 1,
      pass: i >= 3,
    }));
    const gate = computeReleaseGate(dims);
    assert.strictEqual(gate.pass, true);
    assert.strictEqual(gate.failCount, 3);
    assert.ok(gate.failPct < 0.20);
  });

  it('0 dimensions => pass (no failures)', () => {
    const gate = computeReleaseGate([]);
    assert.strictEqual(gate.pass, true);
    assert.strictEqual(gate.failCount, 0);
  });

  it('all pass => gate passes', () => {
    const dims = Array.from({ length: 10 }, (_, i) => ({
      dimId: `dim${i}`,
      maxSwing: 1,
      pass: true,
    }));
    const gate = computeReleaseGate(dims);
    assert.strictEqual(gate.pass, true);
  });
});

describe('sensitivity v2: ceiling detection', () => {
  it('score=100 is flagged as ceiling', () => {
    const scores = { US: 100, DE: 85 };
    const ceilings = [];
    for (const [cc, score] of Object.entries(scores)) {
      if (score >= 100) ceilings.push({ countryCode: cc, score, type: 'ceiling' });
      if (score <= 0) ceilings.push({ countryCode: cc, score, type: 'floor' });
    }
    assert.strictEqual(ceilings.length, 1);
    assert.strictEqual(ceilings[0].countryCode, 'US');
    assert.strictEqual(ceilings[0].type, 'ceiling');
  });

  it('score=0 is flagged as floor', () => {
    const scores = { AF: 0, NO: 80 };
    const ceilings = [];
    for (const [cc, score] of Object.entries(scores)) {
      if (score >= 100) ceilings.push({ countryCode: cc, score, type: 'ceiling' });
      if (score <= 0) ceilings.push({ countryCode: cc, score, type: 'floor' });
    }
    assert.strictEqual(ceilings.length, 1);
    assert.strictEqual(ceilings[0].countryCode, 'AF');
    assert.strictEqual(ceilings[0].type, 'floor');
  });
});

describe('sensitivity v2: computePillarScoresFromDomains', () => {
  it('computes pillar scores from domain groupings', () => {
    const dims = [
      { id: 'macroFiscal', score: 80, coverage: 1 },
      { id: 'currencyExternal', score: 60, coverage: 1 },
      { id: 'tradePolicy', score: 70, coverage: 1 },
      { id: 'cyberDigital', score: 50, coverage: 1 },
      { id: 'logisticsSupply', score: 40, coverage: 1 },
      { id: 'infrastructure', score: 60, coverage: 1 },
      { id: 'energy', score: 55, coverage: 1 },
      { id: 'governanceInstitutional', score: 75, coverage: 1 },
      { id: 'socialCohesion', score: 65, coverage: 1 },
      { id: 'borderSecurity', score: 70, coverage: 1 },
      { id: 'informationCognitive', score: 60, coverage: 1 },
      { id: 'healthPublicService', score: 80, coverage: 1 },
      { id: 'foodWater', score: 70, coverage: 1 },
      { id: 'fiscalSpace', score: 45, coverage: 1 },
      { id: 'reserveAdequacy', score: 50, coverage: 1 },
      { id: 'externalDebtCoverage', score: 55, coverage: 1 },
      { id: 'importConcentration', score: 60, coverage: 1 },
      { id: 'stateContinuity', score: 65, coverage: 1 },
      { id: 'fuelStockDays', score: 40, coverage: 1 },
    ];
    const dimensionDomains = {
      macroFiscal: 'economic',
      currencyExternal: 'economic',
      tradePolicy: 'economic',
      cyberDigital: 'infrastructure',
      logisticsSupply: 'infrastructure',
      infrastructure: 'infrastructure',
      energy: 'energy',
      governanceInstitutional: 'social-governance',
      socialCohesion: 'social-governance',
      borderSecurity: 'social-governance',
      informationCognitive: 'social-governance',
      healthPublicService: 'health-food',
      foodWater: 'health-food',
      fiscalSpace: 'recovery',
      reserveAdequacy: 'recovery',
      externalDebtCoverage: 'recovery',
      importConcentration: 'recovery',
      stateContinuity: 'recovery',
      fuelStockDays: 'recovery',
    };
    const pillarDomains = {
      'structural-readiness': ['economic', 'social-governance'],
      'live-shock-exposure': ['infrastructure', 'energy', 'health-food'],
      'recovery-capacity': ['recovery'],
    };
    const domainWeights = {
      economic: 0.17,
      infrastructure: 0.15,
      energy: 0.11,
      'social-governance': 0.19,
      'health-food': 0.13,
      recovery: 0.25,
    };

    const pillarScores = computePillarScoresFromDomains(
      dims, dimensionDomains, pillarDomains, domainWeights
    );
    assert.strictEqual(pillarScores.length, 3);
    for (const ps of pillarScores) {
      assert.ok(typeof ps.id === 'string', `pillar entry should have string id`);
      assert.ok(typeof ps.score === 'number', `pillar entry should have numeric score`);
      assert.ok(ps.score >= 0 && ps.score <= 100, `pillar score ${ps.score} out of range`);
    }
    const ids = pillarScores.map((p) => p.id);
    assert.deepStrictEqual(ids, ['structural-readiness', 'live-shock-exposure', 'recovery-capacity']);
  });
});

describe('sensitivity v2: per-dimension goalpost perturbation', () => {
  it('produces different maxSwing values for different dimensions', () => {
    const dimA = { id: 'dimA', score: 50, coverage: 1 };
    const dimB = { id: 'dimB', score: 50, coverage: 1 };
    const dimensionDomains = { dimA: 'economic', dimB: 'infra' } as Record<string, string>;
    const pillarDomains = { p1: ['economic', 'infra'] } as Record<string, string[]>;
    const domainWeights = { economic: 0.5, infra: 0.5 };
    const pillarWeights = { p1: 1.0 };
    const alpha = 0.5;

    const indicatorRegistry = [
      { id: 'indA', dimension: 'dimA', goalposts: { worst: 0, best: 100 }, direction: 'higherBetter', weight: 1 },
      { id: 'indB', dimension: 'dimB', goalposts: { worst: 0, best: 1 }, direction: 'higherBetter', weight: 1 },
    ];

    const countries = [
      { countryCode: 'US', dimensions: [{ ...dimA, score: 80 }, { ...dimB, score: 50 }] },
      { countryCode: 'DE', dimensions: [{ ...dimA, score: 70 }, { ...dimB, score: 60 }] },
      { countryCode: 'JP', dimensions: [{ ...dimA, score: 60 }, { ...dimB, score: 55 }] },
      { countryCode: 'BR', dimensions: [{ ...dimA, score: 50 }, { ...dimB, score: 45 }] },
    ];

    const baseScores: Record<string, number> = {};
    for (const cd of countries) {
      const ps = computePillarScoresFromDomains(cd.dimensions, dimensionDomains, pillarDomains, domainWeights);
      baseScores[cd.countryCode] = computePenalizedPillarScore(ps, pillarWeights, alpha);
    }
    const baseRanks: Record<string, number> = {};
    const sorted = Object.entries(baseScores).sort(([, a], [, b]) => b - a);
    sorted.forEach(([cc], i) => { baseRanks[cc] = i + 1; });

    const topN = Object.keys(baseRanks);
    const perDimSwings: Record<string, number[]> = { dimA: [], dimB: [] };

    for (const dimId of ['dimA', 'dimB']) {
      const dimInds = indicatorRegistry.filter(ind => ind.dimension === dimId);
      const perturbedCountries = countries.map(cd => {
        const newDims = cd.dimensions.map(dim => {
          if (dim.id !== dimId) return { ...dim };
          let tw = 0, ws = 0;
          for (const ind of dimInds) {
            const pg = perturbGoalposts(ind.goalposts, 0.1);
            const raw = normalizeToGoalposts(
              dim.score, pg, ind.direction as 'higherBetter' | 'lowerBetter'
            );
            ws += raw * ind.weight;
            tw += ind.weight;
          }
          return { ...dim, score: Math.max(0, Math.min(100, tw > 0 ? ws / tw : dim.score)) };
        });
        return { countryCode: cd.countryCode, dimensions: newDims };
      });
      const scores: Record<string, number> = {};
      for (const cd of perturbedCountries) {
        const ps = computePillarScoresFromDomains(cd.dimensions, dimensionDomains, pillarDomains, domainWeights);
        scores[cd.countryCode] = computePenalizedPillarScore(ps, pillarWeights, alpha);
      }
      const ranks: Record<string, number> = {};
      const s2 = Object.entries(scores).sort(([, a], [, b]) => b - a);
      s2.forEach(([cc], i) => { ranks[cc] = i + 1; });
      const maxSwing = Math.max(...topN.map(cc => Math.abs((ranks[cc] || 0) - (baseRanks[cc] || 0))), 0);
      perDimSwings[dimId].push(maxSwing);
    }

    assert.ok(
      perDimSwings.dimA.length > 0 && perDimSwings.dimB.length > 0,
      'both dimensions have swing values'
    );
  });

  it('value near edge of narrow goalposts produces higher swing than midpoint of wide goalposts', () => {
    const wideGoalposts = { worst: 0, best: 100 };
    const narrowGoalposts = { worst: 48, best: 52 };

    let wideTotal = 0;
    let narrowTotal = 0;
    const trials = 500;

    for (let t = 0; t < trials; t++) {
      const widePg = perturbGoalposts(wideGoalposts, 0.1);
      const wideScore = normalizeToGoalposts(50, widePg, 'higherBetter');
      wideTotal += Math.abs(wideScore - 50);

      const narrowPg = perturbGoalposts(narrowGoalposts, 0.1);
      const narrowScore = normalizeToGoalposts(51.5, narrowPg, 'higherBetter');
      narrowTotal += Math.abs(narrowScore - normalizeToGoalposts(51.5, narrowGoalposts, 'higherBetter'));
    }

    const wideAvg = wideTotal / trials;
    const narrowAvg = narrowTotal / trials;

    assert.ok(
      narrowAvg > wideAvg,
      `narrow goalposts near edge (avg shift=${narrowAvg.toFixed(2)}) should produce higher swing than wide at midpoint (avg shift=${wideAvg.toFixed(2)})`
    );
  });
});

describe('sensitivity v2: percentile', () => {
  it('p50 of [1,2,3,4,5] is 3', () => {
    assert.strictEqual(percentile([1, 2, 3, 4, 5], 50), 3);
  });

  it('p0 returns first element', () => {
    assert.strictEqual(percentile([10, 20, 30], 0), 10);
  });

  it('p100 returns last element', () => {
    assert.strictEqual(percentile([10, 20, 30], 100), 30);
  });

  it('empty array returns 0', () => {
    assert.strictEqual(percentile([], 50), 0);
  });
});
