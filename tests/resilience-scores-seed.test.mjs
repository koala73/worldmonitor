import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRankingItem,
  buildRankingPayload,
  sortRankingItems,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  RESILIENCE_SCORE_CACHE_PREFIX,
} from '../scripts/seed-resilience-scores.mjs';

// ---------------------------------------------------------------------------
// buildRankingItem
// ---------------------------------------------------------------------------

describe('buildRankingItem', () => {
  it('returns sentinel score -1 when score is null', () => {
    const item = buildRankingItem('US', null);
    assert.equal(item.countryCode, 'US');
    assert.equal(item.overallScore, -1);
    assert.equal(item.level, 'unknown');
    assert.equal(item.lowConfidence, true);
  });

  it('returns sentinel score -1 when score is undefined', () => {
    const item = buildRankingItem('DE', undefined);
    assert.equal(item.overallScore, -1);
    assert.equal(item.level, 'unknown');
  });

  it('extracts overallScore, level, and lowConfidence from a real score', () => {
    const score = { overallScore: 72.5, level: 'high', lowConfidence: false, domains: [] };
    const item = buildRankingItem('NO', score);
    assert.equal(item.countryCode, 'NO');
    assert.equal(item.overallScore, 72.5);
    assert.equal(item.level, 'high');
    assert.equal(item.lowConfidence, false);
  });

  it('passes lowConfidence: true from the score object', () => {
    const score = { overallScore: 35.0, level: 'low', lowConfidence: true };
    const item = buildRankingItem('YE', score);
    assert.equal(item.lowConfidence, true);
    assert.equal(item.level, 'low');
  });

  it('does not include extraneous fields from the score', () => {
    const score = { overallScore: 60, level: 'medium', lowConfidence: false, domains: [], trend: 'stable' };
    const item = buildRankingItem('FR', score);
    assert.deepEqual(Object.keys(item).sort(), ['countryCode', 'level', 'lowConfidence', 'overallScore']);
  });
});

// ---------------------------------------------------------------------------
// sortRankingItems
// ---------------------------------------------------------------------------

describe('sortRankingItems', () => {
  it('sorts by overallScore descending', () => {
    const items = [
      { countryCode: 'DE', overallScore: 55, level: 'medium', lowConfidence: false },
      { countryCode: 'NO', overallScore: 80, level: 'high', lowConfidence: false },
      { countryCode: 'YE', overallScore: 20, level: 'low', lowConfidence: false },
    ];
    const sorted = sortRankingItems(items);
    assert.deepEqual(sorted.map((i) => i.countryCode), ['NO', 'DE', 'YE']);
    assert.deepEqual(sorted.map((i) => i.overallScore), [80, 55, 20]);
  });

  it('breaks score ties alphabetically by countryCode', () => {
    const items = [
      { countryCode: 'US', overallScore: 60, level: 'medium', lowConfidence: false },
      { countryCode: 'AU', overallScore: 60, level: 'medium', lowConfidence: false },
      { countryCode: 'FR', overallScore: 60, level: 'medium', lowConfidence: false },
    ];
    const sorted = sortRankingItems(items);
    assert.deepEqual(sorted.map((i) => i.countryCode), ['AU', 'FR', 'US']);
  });

  it('places sentinel (-1) items at the bottom', () => {
    const items = [
      { countryCode: 'US', overallScore: -1, level: 'unknown', lowConfidence: true },
      { countryCode: 'NO', overallScore: 75, level: 'high', lowConfidence: false },
      { countryCode: 'YE', overallScore: -1, level: 'unknown', lowConfidence: true },
    ];
    const sorted = sortRankingItems(items);
    assert.equal(sorted[0].countryCode, 'NO');
    assert.ok(sorted.slice(1).every((i) => i.overallScore === -1));
  });

  it('does not mutate the input array', () => {
    const items = [
      { countryCode: 'B', overallScore: 10, level: 'low', lowConfidence: false },
      { countryCode: 'A', overallScore: 90, level: 'high', lowConfidence: false },
    ];
    sortRankingItems(items);
    assert.equal(items[0].countryCode, 'B');
  });
});

// ---------------------------------------------------------------------------
// buildRankingPayload — the "skip ranking cache write" guard
// ---------------------------------------------------------------------------

describe('buildRankingPayload', () => {
  function makeScore(overallScore) {
    return { overallScore, level: overallScore >= 70 ? 'high' : 'medium', lowConfidence: false };
  }

  it('returns scored === countryCodes.length when every country has a score', () => {
    const scoreMap = new Map([
      ['US', makeScore(80)],
      ['DE', makeScore(65)],
      ['NO', makeScore(82)],
    ]);
    const { items, scored } = buildRankingPayload(['US', 'DE', 'NO'], scoreMap);
    assert.equal(scored, 3);
    assert.equal(items.length, 3);
  });

  it('returns scored < countryCodes.length when some scores are missing — triggers skip', () => {
    const scoreMap = new Map([
      ['NO', makeScore(82)],
      // 'US' and 'DE' are absent — simulates cold cache for those countries
    ]);
    const { scored } = buildRankingPayload(['US', 'DE', 'NO'], scoreMap);
    assert.equal(scored, 1);
    // Caller skips the ranking write when scored < countryCodes.length
    assert.ok(scored < 3, 'skip condition should be true');
  });

  it('returns scored === 0 and does not throw when scoreMap is empty', () => {
    const { items, scored } = buildRankingPayload(['US', 'DE'], new Map());
    assert.equal(scored, 0);
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.overallScore === -1));
  });

  it('returns scored === 0 and does not throw when countryCodes is empty', () => {
    const { items, scored } = buildRankingPayload([], new Map());
    assert.equal(scored, 0);
    assert.equal(items.length, 0);
  });

  it('items are sorted descending — highest score first', () => {
    const scoreMap = new Map([
      ['US', makeScore(50)],
      ['NO', makeScore(85)],
      ['YE', makeScore(22)],
    ]);
    const { items } = buildRankingPayload(['US', 'NO', 'YE'], scoreMap);
    assert.equal(items[0].countryCode, 'NO');
    assert.equal(items[1].countryCode, 'US');
    assert.equal(items[2].countryCode, 'YE');
  });

  it('partial miss: sentinels appear at the bottom, scored count is correct', () => {
    const scoreMap = new Map([
      ['NO', makeScore(82)],
      ['US', makeScore(70)],
    ]);
    const countryCodes = ['NO', 'US', 'YE', 'AF']; // YE and AF are missing
    const { items, scored } = buildRankingPayload(countryCodes, scoreMap);
    assert.equal(scored, 2);
    assert.equal(items.length, 4);
    assert.equal(items[0].countryCode, 'NO');
    assert.equal(items[1].countryCode, 'US');
    // YE and AF both have overallScore -1; sorted alphabetically among themselves
    assert.deepEqual(
      items.slice(2).map((i) => i.countryCode).sort(),
      ['AF', 'YE'],
    );
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('RESILIENCE_RANKING_CACHE_KEY matches server-side key', () => {
    assert.equal(RESILIENCE_RANKING_CACHE_KEY, 'resilience:ranking:v5');
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX matches server-side prefix', () => {
    assert.equal(RESILIENCE_SCORE_CACHE_PREFIX, 'resilience:score:v5:');
  });

  it('RESILIENCE_RANKING_CACHE_TTL_SECONDS is 6 hours', () => {
    assert.equal(RESILIENCE_RANKING_CACHE_TTL_SECONDS, 6 * 60 * 60);
  });
});
