import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { generateBets } from '../scripts/_bet-templates.mjs';
import { isGeopoliticalMarket } from '../scripts/_bet-templates-markets-classify.mjs';
import {
  MARKET_GEO_BET_TEMPLATES, MARKET_GEO_SLOT_COUNT, eligibleGeoMarkets,
} from '../scripts/_bet-templates-markets-geo.mjs';
import {
  MARKET_BET_TEMPLATES, MARKET_FEED, MARKET_SETTLEMENT_FEED, eligibleMarkets,
} from '../scripts/_bet-templates-markets.mjs';
import { parseMetricKey } from '../scripts/_forecast-resolution-eval.mjs';

const NOW = Date.parse('2026-07-28T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function market(overrides = {}) {
  return {
    title: 'Iran leadership change by December 31?',
    yesPrice: 21,
    volume: 21_000_000,
    url: 'https://polymarket.com/event/iran-leadership-change-by',
    endDate: '2026-12-31T00:00:00Z', // ~156d out — inside the 210d geo horizon
    ...overrides,
  };
}

// All markets live in the (mislabeled) geopolitical pool — classification is by
// TITLE, not pool, so the fixtures deliberately mix domains under one pool key.
function feedFixture(markets, overrides = {}) {
  return { geopolitical: markets, tech: [], finance: [], fetchedAt: NOW, ...overrides };
}

describe('isGeopoliticalMarket', () => {
  it('flags unambiguous conflict / statecraft markets', () => {
    for (const title of [
      'US obtains Iranian enriched uranium by December 31',
      'Iran agrees to surrender enriched uranium stockpile by Dec 31',
      'Iran coup attempt by December 31?',
      'Iran leadership change by December 31?',
      'Israel x Iran ceasefire continues through August?',
      'Will Russia and Ukraine reach a ceasefire in 2026?',
      'Will NATO invoke Article 5 this year?',
      'New US sanctions on Venezuela before September?',
      'Will there be a war between two NATO members?',
      'Ballistic missile launch over Japan by year end?',
      'Hamas releases remaining hostages by August?',
      'Gaza reconstruction deal signed in 2026?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), true, `expected geo: ${title}`);
    }
  });

  it('does NOT flag company / crypto / macro markets (precision guards)', () => {
    for (const title of [
      'Will Alibaba have the best Chinese AI model at the end of July 2026?', // "chinese" must not fire
      'Will NVIDIA be the largest company in the world by market cap on July 31?',
      'Will Bitcoin reach $67,500 in July?',
      'Will no Fed rate cuts happen in 2026?',
      'Will the S&P 500 strike a new all-time high?', // "strike" alone must not fire
      'Will TSMC report record revenue this quarter?', // Taiwan proxy, but no conflict term
      'Company X board election result?', // "election" alone must not fire
      'Will oil prices rise to $90 forward this year?', // "forward" must not trip \bwar\b
    ]) {
      assert.equal(isGeopoliticalMarket(title), false, `expected NON-geo: ${title}`);
    }
  });

  it('handles empty / nullish titles', () => {
    assert.equal(isGeopoliticalMarket(''), false);
    assert.equal(isGeopoliticalMarket(null), false);
    assert.equal(isGeopoliticalMarket(undefined), false);
  });
});

describe('eligibleGeoMarkets', () => {
  it('includes long-dated geopolitical markets the general 45d family cannot reach', () => {
    const out = eligibleGeoMarkets(feedFixture([market()]), NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, 'iran-leadership-change-by');
  });

  it('excludes non-geopolitical markets even inside the horizon and volume floor', () => {
    const nonGeo = market({ title: 'Will Bitcoin reach $67,500 in July?', url: 'https://polymarket.com/event/btc-67500', endDate: new Date(NOW + 30 * DAY_MS).toISOString() });
    assert.equal(eligibleGeoMarkets(feedFixture([nonGeo]), NOW).length, 0);
  });

  it('excludes multi-year lottery lines beyond the 210d cap', () => {
    const farOut = market({ endDate: '2028-01-01T00:00:00Z' });
    assert.equal(eligibleGeoMarkets(feedFixture([farOut]), NOW).length, 0);
  });

  it('still admits short-dated geopolitical lines (2d min lead)', () => {
    const soon = market({ title: 'Israel x Iran ceasefire holds through July 31?', url: 'https://polymarket.com/event/israel-iran-ceasefire', endDate: new Date(NOW + 3 * DAY_MS).toISOString() });
    const out = eligibleGeoMarkets(feedFixture([soon]), NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, 'israel-iran-ceasefire');
  });

  it('enforces the liquidity floor and sorts by volume', () => {
    const thin = market({ title: 'Minor coup rumor market', url: 'https://polymarket.com/event/thin-coup', volume: 10_000 });
    const big = market({ title: 'Iran nuclear deal by December?', url: 'https://polymarket.com/event/iran-nuclear-deal', volume: 5_000_000 });
    const bigger = market({ title: 'Russia Ukraine ceasefire by December?', url: 'https://polymarket.com/event/ru-ua-ceasefire', volume: 9_000_000 });
    const out = eligibleGeoMarkets(feedFixture([thin, big, bigger]), NOW);
    assert.deepEqual(out.map((m) => m.slug), ['ru-ua-ceasefire', 'iran-nuclear-deal']);
  });
});

describe('geo slot templates', () => {
  it('generates a geopolitical bet with a slug-keyed settlement spec and 0.9 value score', () => {
    const bets = generateBets(MARKET_GEO_BET_TEMPLATES, { [MARKET_FEED]: feedFixture([market()]) }, NOW);
    assert.equal(bets.length, 1);
    const bet = bets[0];
    assert.equal(bet.domain, 'geopolitical');
    assert.equal(bet.id, 'market:iran-leadership-change-by');
    assert.equal(bet.userValueScore, 0.9);
    assert.equal(bet.marketSlug, 'iran-leadership-change-by');
    assert.equal(bet.calibration.marketPrice, 21);
    assert.equal(bet.resolution.sourceFeed, MARKET_SETTLEMENT_FEED);
    const parsed = parseMetricKey(bet.resolution.metricKey);
    assert.equal(parsed.feedKey, MARKET_SETTLEMENT_FEED);
    assert.equal(parsed.fn, 'yesPrice');
    assert.equal(parsed.field, 'slug');
    assert.equal(parsed.value, 'iran-leadership-change-by');
  });

  it('binds slot i to the i-th eligible geo market and caps at the slate size', () => {
    const many = Array.from({ length: MARKET_GEO_SLOT_COUNT + 2 }, (_, i) => market({
      title: `Sanctions escalation scenario ${i}?`,
      url: `https://polymarket.com/event/sanctions-${i}`,
      volume: 1_000_000 + i, // ascending → reverse of volume sort
    }));
    const bets = generateBets(MARKET_GEO_BET_TEMPLATES, { [MARKET_FEED]: feedFixture(many) }, NOW);
    assert.equal(bets.length, MARKET_GEO_SLOT_COUNT); // capped, extras dropped
  });
});

describe('geo / general partition is exhaustive and disjoint', () => {
  it('routes each market to exactly one family with no slug collision', () => {
    const geo = market({ title: 'Iran coup by December?', url: 'https://polymarket.com/event/iran-coup', endDate: new Date(NOW + 20 * DAY_MS).toISOString() });
    const general = market({ title: 'Will NVIDIA be the largest company on July 31?', url: 'https://polymarket.com/event/nvidia-largest', endDate: new Date(NOW + 20 * DAY_MS).toISOString() });
    const feed = { [MARKET_FEED]: feedFixture([geo, general]) };

    const geoBets = generateBets(MARKET_GEO_BET_TEMPLATES, feed, NOW);
    const generalBets = generateBets(MARKET_BET_TEMPLATES, feed, NOW);
    assert.deepEqual(geoBets.map((b) => b.marketSlug), ['iran-coup']);
    assert.deepEqual(generalBets.map((b) => b.marketSlug), ['nvidia-largest']);

    const geoIds = new Set(geoBets.map((b) => b.id));
    assert.ok(generalBets.every((b) => !geoIds.has(b.id)), 'general and geo id namespaces must be disjoint');
  });

  it('general family drops a geopolitical market even inside its 45d window', () => {
    const geoSoon = market({ title: 'NATO Article 5 invoked before September?', url: 'https://polymarket.com/event/nato-a5', endDate: new Date(NOW + 15 * DAY_MS).toISOString() });
    assert.equal(eligibleMarkets(feedFixture([geoSoon]), NOW).length, 0);
    assert.equal(eligibleGeoMarkets(feedFixture([geoSoon]), NOW).length, 1);
  });
});
