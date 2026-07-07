import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isExcluded,
  isMemeCandidate,
  tagRegions,
  parseYesPrice,
  parseKalshiYesPrice,
  selectPricedKalshiMarket,
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

describe('parseKalshiYesPrice', () => {
  it('converts 0-1 dollar scale to 0-100', () => {
    assert.equal(parseKalshiYesPrice({ last_price_dollars: '0.62' }), 62);
  });

  it('returns null for a missing price instead of fabricating 50', () => {
    assert.equal(parseKalshiYesPrice({}), null);
  });

  it('returns null for a non-numeric price instead of fabricating 50', () => {
    assert.equal(parseKalshiYesPrice({ last_price_dollars: 'oops' }), null);
  });

  it('returns null for out-of-range prices', () => {
    assert.equal(parseKalshiYesPrice({ last_price_dollars: '1.50' }), null);
    assert.equal(parseKalshiYesPrice({ last_price_dollars: '-0.10' }), null);
  });

  it('keeps a genuine zero price (filtered downstream, not fabricated)', () => {
    assert.equal(parseKalshiYesPrice({ last_price_dollars: '0' }), 0);
  });

  it('rejects malformed numeric prefixes (whole-string validation)', () => {
    assert.equal(parseKalshiYesPrice({ last_price_dollars: '0.62oops' }), null);
    assert.equal(parseKalshiYesPrice({ last_price_dollars: '0,62' }), null);
  });

  it('accepts plain numbers and whitespace-padded numeric strings', () => {
    assert.equal(parseKalshiYesPrice({ last_price_dollars: 0.62 }), 62);
    assert.equal(parseKalshiYesPrice({ last_price_dollars: ' 0.62 ' }), 62);
  });
});

describe('selectPricedKalshiMarket', () => {
  it('falls back to a lower-volume priced sibling when the top-volume market is unpriced', () => {
    const result = selectPricedKalshiMarket([
      { ticker: 'HIGH', volume_fp: '10000' },
      { ticker: 'VALID', volume_fp: '6000', last_price_dollars: '0.64' },
    ]);
    assert.equal(result.market.ticker, 'VALID');
    assert.equal(result.yesPrice, 64);
  });

  it('picks the highest-volume market among priced ones', () => {
    const result = selectPricedKalshiMarket([
      { ticker: 'A', volume_fp: '6000', last_price_dollars: '0.30' },
      { ticker: 'B', volume_fp: '9000', last_price_dollars: '0.70' },
    ]);
    assert.equal(result.market.ticker, 'B');
    assert.equal(result.yesPrice, 70);
  });

  it('returns null when no market has a readable price', () => {
    assert.equal(selectPricedKalshiMarket([
      { ticker: 'A', volume_fp: '10000' },
      { ticker: 'B', volume_fp: '9000', last_price_dollars: 'oops' },
    ]), null);
    assert.equal(selectPricedKalshiMarket([]), null);
  });
});

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

describe('scoreMarket (conviction-weighted, post-#3735)', () => {
  it('50% price gets minimum conviction — only volume contributes', () => {
    // p=50 → conviction=0; score collapses to vol_term * 0.5.
    const score = scoreMarket(market('Test', 50, 1));
    assert.ok(score < 0.1, `coin-flip market at $1 volume should score near 0, got ${score}`);
  });

  it('high-conviction market outranks coin-flip at equal volume (#3735)', () => {
    // The motivating example from the audit: "Iran strike: 88% YES" should
    // surface above "Fed rate cut: 51%" when volumes are comparable.
    const highConviction = scoreMarket(market('Iran military action', 88, 100000));
    const coinFlip = scoreMarket(market('Fed rate cut', 51, 100000));
    assert.ok(highConviction > coinFlip,
      `88%/$100K (${highConviction}) should outrank 51%/$100K (${coinFlip})`);
  });

  it('higher volume increases score at equal conviction', () => {
    const lowVol = scoreMarket(market('Test', 70, 1000));
    const highVol = scoreMarket(market('Test', 70, 1000000));
    assert.ok(highVol > lowVol, `$1M vol (${highVol}) should beat $1K vol (${lowVol})`);
  });

  it('within-band conviction beats coin-flip even on lower volume', () => {
    // The previous formula buried this case (1% < 50% by uncertainty).
    // After flip: 85% conviction at $10K beats 50% coin-flip at $10M as long
    // as conviction's contribution exceeds the volume gap.
    const convicted = scoreMarket(market('Convicted', 85, 100000));
    const coinFlip = scoreMarket(market('Coin flip', 50, 10000000));
    assert.ok(convicted > coinFlip,
      `85%/$100K (${convicted}) should outrank 50%/$10M (${coinFlip}) — conviction signal beats volume`);
  });

  it('score bounded between 0 and 1', () => {
    const s1 = scoreMarket(market('Test', 90, 10000000));
    const s2 = scoreMarket(market('Test', 50, 1));
    assert.ok(s1 >= 0 && s1 <= 1, `score should be 0-1, got ${s1}`);
    assert.ok(s2 >= 0 && s2 <= 1, `score should be 0-1, got ${s2}`);
  });

  it('symmetric around 50%: 40% and 60% get the same score', () => {
    const s40 = scoreMarket(market('Test', 40, 10000));
    const s60 = scoreMarket(market('Test', 60, 10000));
    assert.ok(Math.abs(s40 - s60) < 0.001, `40% (${s40}) and 60% (${s60}) should have same score`);
  });

  it('symmetric around 50%: 20% and 80% get the same score', () => {
    const s20 = scoreMarket(market('Test', 20, 10000));
    const s80 = scoreMarket(market('Test', 80, 10000));
    assert.ok(Math.abs(s20 - s80) < 0.001, `20% (${s20}) and 80% (${s80}) should have same score`);
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

  it('sorts by composite score (highest conviction first, post-#3735)', () => {
    // Conviction ordering at equal volume: 85% (Δ35) > 65% (Δ15) > 48% (Δ2)
    const candidates = [
      market('Market A (high conviction)', 85, 100000, { endDate: '2099-01-01' }),
      market('Market B (coin flip)', 48, 100000, { endDate: '2099-01-01' }),
      market('Market C (mid)', 65, 100000, { endDate: '2099-01-01' }),
    ];
    const result = filterAndScore(candidates, null);
    assert.equal(result[0].title, 'Market A (high conviction)');
    assert.equal(result[1].title, 'Market C (mid)');
    assert.equal(result[2].title, 'Market B (coin flip)');
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

  it('LeBron meme market is dropped by filterAndScore, never reaches the analyst', () => {
    // Direct scoreMarket comparison is meaningless after #3735 — a 1% meme
    // would score high on conviction. The real guarantee is that shouldInclude
    // + isMemeCandidate prune it before it ever reaches the ranker.
    const meme = market('Will LeBron James win?', 1, 500000, { endDate: '2099-01-01' });
    const real = market('Will the Fed cut rates?', 48, 50000, { endDate: '2099-01-01' });
    const result = filterAndScore([meme, real], null);
    assert.ok(!result.some(m => m.title.includes('LeBron')),
      `LeBron meme must not reach the analyst output: ${result.map(m => m.title).join(', ')}`);
    assert.ok(result.some(m => m.title.includes('Fed')),
      'Genuine market should be present');
  });

  // Companion to the filterAndScore drop-through test above. Adversarial review
  // of #3785 noted that the filterAndScore test passes because the price floor
  // (yesPrice < 10 strict / < 5 relaxed) catches the LeBron market BEFORE the
  // meme regex ever runs — so loosening the price floor would silently neuter
  // the meme-detection guarantee. This isolated test pins the meme detector
  // itself: at the maximum price where isMemeCandidate's short-circuit still
  // allows the regex to fire (yesPrice=14, one below the `>= 15` cutoff), the
  // meme is correctly flagged. If someone moves or removes the short-circuit
  // or drops the regex patterns, this test fails — independent of the price
  // floor in shouldInclude.
  it('isMemeCandidate detects LeBron meme up to its yesPrice<15 short-circuit boundary', () => {
    assert.ok(
      isMemeCandidate('Will LeBron James become president?', 14),
      'meme regex must still fire at yesPrice=14 (one below the >=15 short-circuit)',
    );
    // Documented behavior, NOT a bug we are asserting away: at yesPrice >= 15
    // the meme detector deliberately short-circuits to false (assumption:
    // genuine market activity will not push an obvious meme above 15%). If
    // this short-circuit is ever revisited, see #3735 follow-up.
    assert.ok(
      !isMemeCandidate('Will LeBron James become president?', 15),
      'isMemeCandidate intentionally short-circuits at yesPrice >= 15',
    );
  });

  it('high-volume 99% market excluded by shouldInclude', () => {
    const m = market('Will the sun rise tomorrow?', 99, 10000000);
    assert.ok(!shouldInclude(m), '99% market excluded regardless of volume');
  });
});
