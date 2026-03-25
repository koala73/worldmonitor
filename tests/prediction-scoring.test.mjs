import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isExcluded,
  isMemeCandidate,
  tagRegions,
  parseYesPrice,
  shouldInclude,
  scoreMarket,
  filterAndScore,
  isExpired,
  EXCLUDE_KEYWORDS,
  MEME_PATTERNS,
  REGION_PATTERNS,
} from '../scripts/_prediction-scoring.mjs';

function market(title, yesPrice, volume, opts = {}) {
  return { title, yesPrice, volume, ...opts };
}

describe('parseYesPrice', () => {
  it('converts 0-1 scale to 0-100', () => {
    assert.equal(parseYesPrice({ outcomePrices: '["0.73","0.27"]' }), 73);
  });

  it('returns null for missing outcomePrices', () => {
    assert.equal(parseYesPrice({}), null);
  });

  it('returns null for empty array', () => {
    assert.equal(parseYesPrice({ outcomePrices: '[]' }), null);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseYesPrice({ outcomePrices: 'not json' }), null);
  });

  it('returns null for NaN values', () => {
    assert.equal(parseYesPrice({ outcomePrices: '["abc"]' }), null);
  });

  it('returns null for out-of-range price > 1', () => {
    assert.equal(parseYesPrice({ outcomePrices: '["1.5"]' }), null);
  });

  it('returns null for negative price', () => {
    assert.equal(parseYesPrice({ outcomePrices: '["-0.1"]' }), null);
  });

  it('handles boundary: 0.0 returns 0', () => {
    assert.equal(parseYesPrice({ outcomePrices: '["0.0"]' }), 0);
  });

  it('handles boundary: 1.0 returns 100', () => {
    assert.equal(parseYesPrice({ outcomePrices: '["1.0"]' }), 100);
  });

  it('rounds to one decimal place', () => {
    assert.equal(parseYesPrice({ outcomePrices: '["0.333"]' }), 33.3);
  });
});

describe('isExcluded', () => {
  it('excludes sports keywords', () => {
    assert.ok(isExcluded('Will the NBA finals go to game 7?'));
    assert.ok(isExcluded('NFL Super Bowl winner'));
  });

  it('excludes entertainment keywords', () => {
    assert.ok(isExcluded('Will a movie gross $1B?'));
    assert.ok(isExcluded('Grammy Award for best album'));
  });

  it('case insensitive', () => {
    assert.ok(isExcluded('NBA PLAYOFFS 2026'));
    assert.ok(isExcluded('nba playoffs 2026'));
  });

  it('passes geopolitical titles', () => {
    assert.ok(!isExcluded('Will the Fed cut rates in March?'));
    assert.ok(!isExcluded('Ukraine ceasefire before July?'));
  });
});

describe('isMemeCandidate', () => {
  it('flags celebrity + low price as meme', () => {
    assert.ok(isMemeCandidate('Will LeBron James become president?', 1));
    assert.ok(isMemeCandidate('Kanye West elected governor?', 3));
  });

  it('does NOT flag celebrity at price >= 15', () => {
    assert.ok(!isMemeCandidate('Will LeBron James become president?', 15));
    assert.ok(!isMemeCandidate('Will LeBron James become president?', 50));
  });

  it('flags novelty patterns at low price', () => {
    assert.ok(isMemeCandidate('Alien disclosure before 2027?', 5));
    assert.ok(isMemeCandidate('UFO confirmed by Pentagon?', 10));
  });

  it('passes serious geopolitical at low price', () => {
    assert.ok(!isMemeCandidate('Will sanctions on Iran be lifted?', 5));
  });
});

describe('tagRegions', () => {
  it('tags America for US-related titles', () => {
    const regions = tagRegions('Will Trump win the 2028 election?');
    assert.ok(regions.includes('america'));
  });

  it('tags MENA for Middle East titles', () => {
    const regions = tagRegions('Iran nuclear deal revival');
    assert.ok(regions.includes('mena'));
  });

  it('tags multiple regions for multi-region titles', () => {
    const regions = tagRegions('US-China trade war escalation');
    assert.ok(regions.includes('america'));
    assert.ok(regions.includes('asia'));
  });

  it('returns empty for generic titles', () => {
    const regions = tagRegions('Global recession probability');
    assert.deepEqual(regions, []);
  });

  it('tags EU for European titles', () => {
    const regions = tagRegions('ECB rate decision March');
    assert.ok(regions.includes('eu'));
  });

  it('tags latam for Latin America', () => {
    const regions = tagRegions('Venezuela presidential crisis');
    assert.ok(regions.includes('latam'));
  });

  it('tags africa for African titles', () => {
    const regions = tagRegions('Nigeria elections 2027');
    assert.ok(regions.includes('africa'));
  });

  it('word boundary prevents false positives', () => {
    const regions = tagRegions('European summit');
    assert.ok(regions.includes('eu'));
    const regions2 = tagRegions('Euphoria renewed');
    assert.ok(!regions2.includes('eu'));
  });
});

describe('shouldInclude', () => {
  it('excludes near-certain markets (yesPrice < 10)', () => {
    assert.ok(!shouldInclude(market('Test', 5, 100000)));
  });

  it('excludes near-certain markets (yesPrice > 90)', () => {
    assert.ok(!shouldInclude(market('Test', 95, 100000)));
  });

  it('excludes low volume markets', () => {
    assert.ok(!shouldInclude(market('Test', 50, 1000)));
  });

  it('excludes sports markets', () => {
    assert.ok(!shouldInclude(market('NFL Super Bowl winner', 50, 100000)));
  });

  it('excludes meme candidates', () => {
    assert.ok(!shouldInclude(market('Will LeBron become president?', 1, 500000)));
  });

  it('includes good geopolitical market', () => {
    assert.ok(shouldInclude(market('Fed rate cut in June?', 45, 50000)));
  });

  it('relaxed mode allows 5-95 range', () => {
    assert.ok(!shouldInclude(market('Test', 7, 50000)));
    assert.ok(shouldInclude(market('Test', 7, 50000), true));
  });

  it('relaxed mode still enforces volume minimum', () => {
    assert.ok(!shouldInclude(market('Test', 50, 1000), true));
  });
});

describe('scoreMarket', () => {
  it('50% price gets maximum uncertainty (0.6)', () => {
    const score = scoreMarket(market('Test', 50, 1));
    assert.ok(score >= 0.59, `50% market should have uncertainty ~0.6, got ${score}`);
  });

  it('1% price gets near-zero uncertainty', () => {
    const lowScore = scoreMarket(market('Test', 1, 10000));
    const midScore = scoreMarket(market('Test', 50, 10000));
    assert.ok(midScore > lowScore, `50% score (${midScore}) should beat 1% score (${lowScore})`);
  });

  it('higher volume increases score', () => {
    const lowVol = scoreMarket(market('Test', 50, 1000));
    const highVol = scoreMarket(market('Test', 50, 1000000));
    assert.ok(highVol > lowVol, `$1M vol (${highVol}) should beat $1K vol (${lowVol})`);
  });

  it('uncertainty dominates: 50%/$10K beats 10%/$10M', () => {
    const uncertain = scoreMarket(market('Test', 50, 10000));
    const certain = scoreMarket(market('Test', 10, 10000000));
    assert.ok(uncertain > certain,
      `50%/$10K (${uncertain}) should beat 10%/$10M (${certain}) — uncertainty weight 60%`);
  });

  it('score bounded between 0 and 1', () => {
    const s1 = scoreMarket(market('Test', 50, 10000000));
    const s2 = scoreMarket(market('Test', 1, 1));
    assert.ok(s1 >= 0 && s1 <= 1, `score should be 0-1, got ${s1}`);
    assert.ok(s2 >= 0 && s2 <= 1, `score should be 0-1, got ${s2}`);
  });

  it('symmetric: 40% and 60% get same uncertainty', () => {
    const s40 = scoreMarket(market('Test', 40, 10000));
    const s60 = scoreMarket(market('Test', 60, 10000));
    assert.ok(Math.abs(s40 - s60) < 0.001, `40% (${s40}) and 60% (${s60}) should have same score`);
  });
});

describe('isExpired', () => {
  it('returns false for null/undefined', () => {
    assert.ok(!isExpired(null));
    assert.ok(!isExpired(undefined));
  });

  it('returns true for past date', () => {
    assert.ok(isExpired('2020-01-01T00:00:00Z'));
  });

  it('returns false for future date', () => {
    assert.ok(!isExpired('2099-01-01T00:00:00Z'));
  });

  it('returns false for invalid date string', () => {
    assert.ok(!isExpired('not-a-date'));
  });
});

describe('filterAndScore', () => {
  function genMarkets(n, overrides = {}) {
    return Array.from({ length: n }, (_, i) => ({
      title: `Market ${i} about the Federal Reserve`,
      yesPrice: 30 + (i % 40),
      volume: 10000 + i * 1000,
      endDate: '2099-01-01T00:00:00Z',
      tags: ['economy'],
      ...overrides,
    }));
  }

  it('filters expired markets', () => {
    const candidates = [
      market('Fed rate cut?', 50, 50000, { endDate: '2020-01-01T00:00:00Z' }),
      market('ECB rate decision', 45, 50000, { endDate: '2099-01-01T00:00:00Z' }),
    ];
    const result = filterAndScore(candidates, null);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'ECB rate decision');
  });

  it('applies tag filter', () => {
    const candidates = [
      market('AI regulation', 50, 50000, { tags: ['tech'], endDate: '2099-01-01' }),
      market('Fed rate cut', 50, 50000, { tags: ['economy'], endDate: '2099-01-01' }),
    ];
    const result = filterAndScore(candidates, m => m.tags?.includes('tech'));
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'AI regulation');
  });

  it('sorts by composite score (most uncertain first)', () => {
    const candidates = [
      market('Market A (certain)', 85, 100000, { endDate: '2099-01-01' }),
      market('Market B (uncertain)', 48, 100000, { endDate: '2099-01-01' }),
      market('Market C (mid)', 65, 100000, { endDate: '2099-01-01' }),
    ];
    const result = filterAndScore(candidates, null);
    assert.equal(result[0].title, 'Market B (uncertain)');
  });

  it('respects limit parameter', () => {
    const candidates = genMarkets(30);
    const result = filterAndScore(candidates, null, 10);
    assert.equal(result.length, 10);
  });

  it('adds regions to output markets', () => {
    const candidates = [
      market('Will Trump win?', 50, 50000, { endDate: '2099-01-01' }),
    ];
    const result = filterAndScore(candidates, null);
    assert.ok(result[0].regions.includes('america'));
  });

  it('relaxes price bounds when < 15 markets pass strict filter', () => {
    const candidates = [
      market('Market at 7%', 7, 50000, { endDate: '2099-01-01' }),
      market('Market at 93%', 93, 50000, { endDate: '2099-01-01' }),
    ];
    const result = filterAndScore(candidates, null);
    assert.equal(result.length, 2, 'relaxed mode should include 7% and 93% markets');
  });

  it('strict filter rejects 7% and 93% when enough markets exist', () => {
    const good = genMarkets(20);
    const edge = [
      market('Edge at 7%', 7, 50000, { endDate: '2099-01-01' }),
    ];
    const result = filterAndScore([...good, ...edge], null);
    assert.ok(!result.some(m => m.title === 'Edge at 7%'),
      'strict filter should exclude 7% when enough markets');
  });
});

describe('regression: meme market surfacing', () => {
  it('LeBron presidential market at 1% is excluded', () => {
    const m = market('Will LeBron James win the 2028 US Presidential Election?', 1, 393000);
    assert.ok(!shouldInclude(m), 'LeBron 1% market should be excluded (meme + near-certain)');
    assert.ok(isMemeCandidate(m.title, m.yesPrice), 'should be flagged as meme');
  });

  it('LeBron market scores lower than genuine uncertain market', () => {
    const meme = scoreMarket(market('Will LeBron James win?', 1, 500000));
    const real = scoreMarket(market('Will the Fed cut rates?', 48, 50000));
    assert.ok(real > meme, `Real market (${real}) should score higher than meme (${meme})`);
  });

  it('high-volume 99% market excluded by shouldInclude', () => {
    const m = market('Will the sun rise tomorrow?', 99, 10000000);
    assert.ok(!shouldInclude(m), '99% market excluded regardless of volume');
  });
});
