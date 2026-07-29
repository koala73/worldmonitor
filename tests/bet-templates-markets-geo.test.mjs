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
import { buildBetsSnapshot } from '../scripts/seed-forecast-bets.mjs';
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

  it('flags NUCLEAR markets only in a weapon/statecraft context', () => {
    for (const title of [
      'Will Iran sign a nuclear deal by December?',
      'North Korea conducts a nuclear test in 2026?',
      'Will Russia issue a nuclear threat over Ukraine?',
      'Nuclear weapons treaty ratified before 2027?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), true, `expected geo: ${title}`);
    }
    // Nuclear-ENERGY markets are a real category and must stay NON-geo.
    for (const title of [
      'Will a new nuclear energy company IPO in 2026?',
      'Nuclear power plant approved in Ohio this year?',
      'Will the nuclear reactor SMR startup raise a Series C?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), false, `expected NON-geo: ${title}`);
    }
  });

  it('flags national / legislative elections but not corporate ones', () => {
    for (const title of [
      'Who wins the 2028 US presidential election?',
      'Will the ruling party lose the parliamentary election?',
      'Republicans win control of the Senate in the midterms?',
      'Will there be a runoff in the French presidential election?',
      'Which party controls the House after the general election?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), true, `expected geo: ${title}`);
    }
    for (const title of [
      'Will the board election reinstate the former CEO?',
      'Union election at the Detroit plant passes?',
      'Baseball Hall of Fame election results announced?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), false, `expected NON-geo: ${title}`);
    }
  });

  it('flags national head-of-state / head-of-government markets', () => {
    for (const title of [
      'Will Zohran Mamdani become President of the United States before 2029?',
      'Who will be the next Prime Minister of Romania?',
      'Will the incumbent win as POTUS in 2028?',
      'Next Supreme Leader of Iran named by December?',
      'Who will be the next president of France?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), true, `expected geo: ${title}`);
    }
    // Corporate leadership must NOT fire (no country qualifier).
    for (const title of [
      'Will Jane Doe become President of Acme Corp this year?',
      'Vice President of Sales departs before Q4?',
      'Who will be the next president of OpenAI?',
      'Will Acme Corp have a leadership change this year?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), false, `expected NON-geo: ${title}`);
    }
  });

  it('flags weak terms only with a high-salience actor co-occurrence', () => {
    for (const title of [
      'Iran leadership change by December 31?',
      'New US sanctions on Venezuela before September?',
      'Will there be a war between two NATO members?',
      'US obtains Iranian enriched uranium by December 31', // enrich is strong; uranium+iran also weak+actor
    ]) {
      assert.equal(isGeopoliticalMarket(title), true, `expected geo: ${title}`);
    }
    for (const title of [
      'Will Acme Corp have a leadership change this year?',
      'Highest-paid occupation in the US this year?',
      'Will a uranium miner IPO in 2026?',
      'Retail price war intensifies this quarter?',
      'Will the SEC issue new sanctions on crypto firms?',
    ]) {
      assert.equal(isGeopoliticalMarket(title), false, `expected NON-geo: ${title}`);
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
      'Will the Russia stock market ETF recover this year?', // bare country, no conflict term
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
      // Strong geo term (coup) so each row is eligible; volume ascending → reverse sort.
      title: `Coup attempt scenario ${i}?`,
      url: `https://polymarket.com/event/coup-${i}`,
      volume: 1_000_000 + i,
    }));
    const bets = generateBets(MARKET_GEO_BET_TEMPLATES, { [MARKET_FEED]: feedFixture(many) }, NOW);
    assert.equal(bets.length, MARKET_GEO_SLOT_COUNT); // capped, extras dropped
    // Highest volumes win: coup-(N+1) ... coup-(N - SLOT + 2) after reverse volume sort.
    const expected = Array.from({ length: MARKET_GEO_SLOT_COUNT }, (_, i) => `coup-${MARKET_GEO_SLOT_COUNT + 1 - i}`);
    assert.deepEqual(bets.map((b) => b.marketSlug), expected);
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

describe('geopolitical bets reach the seeder snapshot end-to-end', () => {
  it('buildBetsSnapshot emits a geopolitical-domain bet from the market feed', () => {
    const geo = market(); // Iran leadership change, Dec-31, $21M — inside 210d
    const snapshot = buildBetsSnapshot({ [MARKET_FEED]: feedFixture([geo]) }, NOW);
    const geoBet = snapshot.predictions.find((b) => b.domain === 'geopolitical');
    assert.ok(geoBet, 'expected a geopolitical bet in the snapshot');
    assert.equal(geoBet.id, 'market:iran-leadership-change-by');
    assert.equal(geoBet.generationOrigin, 'bet_engine');
    assert.equal(geoBet.resolution.sourceFeed, MARKET_SETTLEMENT_FEED);
    assert.ok(Number.isFinite(geoBet.probability), 'carries a base-rate probability (Stage A)');
  });
});
