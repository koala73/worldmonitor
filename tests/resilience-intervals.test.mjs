import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeIntervals } from '../scripts/seed-resilience-intervals.mjs';
import {
  RESILIENCE_INTERVAL_METHODOLOGY,
  buildScoreIntervalPayload,
  domainAggregate,
  penalizedPillarScore,
} from '../scripts/_resilience-intervals.mjs';

function cycle(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

describe('computeIntervals', () => {
  it('returns p05 and p95 within expected bounds', () => {
    const domainScores = [80, 70, 60, 75, 65];
    const domainWeights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, domainWeights, 1000);

    assert.equal(typeof result.p05, 'number');
    assert.equal(typeof result.p95, 'number');
    assert.ok(result.p05 < result.p95, `p05 (${result.p05}) should be less than p95 (${result.p95})`);
    assert.ok(result.p05 > 0, 'p05 should be positive');
    assert.ok(result.p95 <= 100, 'p95 should not exceed 100');
  });

  it('produces narrow interval for uniform domain scores', () => {
    const domainScores = [70, 70, 70, 70, 70];
    const domainWeights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, domainWeights, 1000);

    assert.ok(result.p95 - result.p05 < 1, `Uniform scores should produce narrow interval, got ${result.p05}-${result.p95}`);
  });

  it('produces wider interval for divergent domain scores', () => {
    const domainScores = [95, 20, 80, 10, 60];
    const domainWeights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, domainWeights, 1000);

    assert.ok(result.p95 - result.p05 > 1, `Divergent scores should produce wider interval, got ${result.p05}-${result.p95}`);
  });

  it('respects custom draw count', () => {
    const domainScores = [60, 70, 80, 50, 65];
    const domainWeights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, domainWeights, 50);

    assert.equal(typeof result.p05, 'number');
    assert.equal(typeof result.p95, 'number');
    assert.ok(result.p05 < result.p95);
  });

  it('rounds to one decimal place', () => {
    const domainScores = [72, 68, 55, 81, 44];
    const domainWeights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, domainWeights, 100);

    const p05Decimals = String(result.p05).split('.')[1]?.length ?? 0;
    const p95Decimals = String(result.p95).split('.')[1]?.length ?? 0;
    assert.ok(p05Decimals <= 1, `p05 should have at most 1 decimal, got ${result.p05}`);
    assert.ok(p95Decimals <= 1, `p95 should have at most 1 decimal, got ${result.p95}`);
  });
});

describe('formula-aware resilience score intervals', () => {
  const liveStyleDomains = [
    { id: 'economic', score: 78.96, weight: 0.17 },
    { id: 'infrastructure', score: 85.54, weight: 0.15 },
    { id: 'energy', score: 83, weight: 0.11 },
    { id: 'social-governance', score: 70.97, weight: 0.19 },
    { id: 'health-food', score: 71.13, weight: 0.13 },
    { id: 'recovery', score: 70.91, weight: 0.25 },
  ];
  const liveStylePillars = [
    { id: 'structural-readiness', score: 80, weight: 0.40 },
    { id: 'live-shock-exposure', score: 78, weight: 0.35 },
    { id: 'recovery-capacity', score: 68, weight: 0.25 },
  ];

  it('uses pillar-combined sensitivity when the active score is pc-shaped', () => {
    const overallScore = penalizedPillarScore(liveStylePillars);
    const d6Aggregate = domainAggregate(liveStyleDomains);
    assert.ok(d6Aggregate - overallScore > 10, 'fixture must separate d6 and pc enough to catch #3967');

    const payload = buildScoreIntervalPayload({
      overallScore,
      domains: liveStyleDomains,
      pillars: liveStylePillars,
    }, {
      draws: 100,
      rng: cycle([0.01, 0.99, 0.5, 0.2, 0.8]),
      computedAt: '2026-05-29T00:00:00.000Z',
    });

    assert.ok(payload, 'expected interval payload');
    assert.equal(payload._formula, 'pc');
    assert.equal(payload.methodology, RESILIENCE_INTERVAL_METHODOLOGY);
    assert.ok(payload.p05 <= overallScore && overallScore <= payload.p95, `pc score ${overallScore} must be inside ${payload.p05}-${payload.p95}`);
    const center = (payload.p05 + payload.p95) / 2;
    assert.ok(Math.abs(center - overallScore) < 1, `pc interval center ${center} should track pc score ${overallScore}`);
    assert.ok(Math.abs(center - d6Aggregate) > 10, `pc interval center ${center} must not track d6 aggregate ${d6Aggregate}`);
  });

  it('uses legacy domain sensitivity when the active score is d6-shaped', () => {
    const overallScore = domainAggregate(liveStyleDomains);
    const payload = buildScoreIntervalPayload({
      overallScore,
      domains: liveStyleDomains,
      pillars: liveStylePillars,
    }, {
      draws: 100,
      rng: cycle([0.01, 0.99, 0.5, 0.2, 0.8]),
      computedAt: '2026-05-29T00:00:00.000Z',
    });

    assert.ok(payload, 'expected interval payload');
    assert.equal(payload._formula, 'd6');
    assert.ok(payload.p05 <= overallScore && overallScore <= payload.p95, `d6 score ${overallScore} must be inside ${payload.p05}-${payload.p95}`);
  });
});

describe('seed script is self-contained .mjs', () => {
  it('does not import from ../server/', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-intervals.mjs'), 'utf8');
    assert.equal(src.includes('../server/'), false, 'Must not import from ../server/');
    assert.equal(src.includes('tsx/esm'), false, 'Must not reference tsx/esm');
  });

  it('all imports are local ./ relative paths', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-intervals.mjs'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(imp.startsWith('./'), `Import "${imp}" must be a local ./ relative path`);
    }
  });

  it('uses the shared resilience interval helper', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-intervals.mjs'), 'utf8');
    assert.match(src, /from ['"]\.\/_resilience-intervals\.mjs['"]/);
    assert.doesNotMatch(src, /const DOMAIN_WEIGHTS =/);
  });
});
