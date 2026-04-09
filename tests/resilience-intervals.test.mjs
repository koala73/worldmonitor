import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeIntervals } from '../scripts/seed-resilience-intervals.mjs';

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
});
