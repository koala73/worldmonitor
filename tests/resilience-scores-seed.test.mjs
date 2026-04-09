import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_STATIC_INDEX_KEY,
} from '../scripts/seed-resilience-scores.mjs';

describe('exported constants', () => {
  it('RESILIENCE_RANKING_CACHE_KEY matches server-side key (v7)', () => {
    assert.equal(RESILIENCE_RANKING_CACHE_KEY, 'resilience:ranking:v7');
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX matches server-side prefix (v7)', () => {
    assert.equal(RESILIENCE_SCORE_CACHE_PREFIX, 'resilience:score:v7:');
  });

  it('RESILIENCE_RANKING_CACHE_TTL_SECONDS is 6 hours', () => {
    assert.equal(RESILIENCE_RANKING_CACHE_TTL_SECONDS, 6 * 60 * 60);
  });

  it('RESILIENCE_STATIC_INDEX_KEY matches expected key', () => {
    assert.equal(RESILIENCE_STATIC_INDEX_KEY, 'resilience:static:index:v1');
  });
});

describe('seed script does not export tsx/esm helpers', () => {
  it('ensureResilienceScoreCached is not exported', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.ensureResilienceScoreCached, 'undefined');
  });

  it('createMemoizedSeedReader is not exported', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.createMemoizedSeedReader, 'undefined');
  });

  it('buildRankingItem is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingItem, 'undefined');
  });

  it('sortRankingItems is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.sortRankingItems, 'undefined');
  });

  it('buildRankingPayload is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingPayload, 'undefined');
  });
});

describe('script is self-contained .mjs', () => {
  it('does not import from ../server/', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-scores.mjs'), 'utf8');
    assert.equal(src.includes('../server/'), false, 'Must not import from ../server/');
    assert.equal(src.includes('tsx/esm'), false, 'Must not reference tsx/esm');
  });

  it('all imports are local ./ relative paths', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-scores.mjs'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(imp.startsWith('./'), `Import "${imp}" must be a local ./ relative path`);
    }
  });
});
