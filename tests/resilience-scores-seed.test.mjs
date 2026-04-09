import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  RESILIENCE_SCORE_CACHE_PREFIX,
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
});

describe('seed script does not export ranking helpers', () => {
  it('buildRankingItem is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingItem, 'undefined', 'buildRankingItem should no longer be exported');
  });

  it('sortRankingItems is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.sortRankingItems, 'undefined', 'sortRankingItems should no longer be exported');
  });

  it('buildRankingPayload is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingPayload, 'undefined', 'buildRankingPayload should no longer be exported');
  });
});
