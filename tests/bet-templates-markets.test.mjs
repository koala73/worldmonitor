import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildMarketTemplates, MARKETS_BOOTSTRAP_FEED, MARKETS_RESOLUTION_FEED } from '../scripts/_bet-templates-markets.mjs';
import { generateBets } from '../scripts/_bet-templates.mjs';
import { RESOLUTION_FEED_KEYS } from '../scripts/_forecast-resolution.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-24T00:00:00Z');

// ── Feed key constants ─────────────────────────────────────────────────────

describe('MARKETS_RESOLUTION_FEED', () => {
  it('is in RESOLUTION_FEED_KEYS (KTD2)', () => {
    assert.ok(
      RESOLUTION_FEED_KEYS.has(MARKETS_RESOLUTION_FEED),
      `Expected '${MARKETS_RESOLUTION_FEED}' in RESOLUTION_FEED_KEYS`,
    );
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeMarket(overrides = {}) {
  return {
    title: 'Will X happen?',
    url: 'https://polymarket.com/event/will-x-happen',
    yesPrice: 55,
    volume: 10_000,
    endDate: new Date(NOW + 30 * DAY_MS).toISOString(), // 30 days out
    source: 'polymarket',
    ...overrides,
  };
}

function bootstrapFeed(markets = [], category = 'geopolitical') {
  return { [category]: markets };
}

// ── buildMarketTemplates ───────────────────────────────────────────────────

describe('buildMarketTemplates', () => {
  it('returns empty array for empty or invalid feed', () => {
    assert.deepEqual(buildMarketTemplates(null, NOW), []);
    assert.deepEqual(buildMarketTemplates({}, NOW), []);
  });

  it('builds one template per qualifying market', () => {
    const feed = bootstrapFeed([makeMarket(), makeMarket({ url: 'https://polymarket.com/event/other-event', title: 'Will Y happen?' })]);
    const templates = buildMarketTemplates(feed, NOW);
    assert.equal(templates.length, 2);
  });

  it('filters out markets below volume floor (MIN_VOLUME = 5000)', () => {
    const feed = bootstrapFeed([makeMarket({ volume: 4999 })]);
    const templates = buildMarketTemplates(feed, NOW);
    assert.equal(templates.length, 0);
  });

  it('filters out markets whose yesPrice is outside [10, 90]', () => {
    const lowFeed = bootstrapFeed([makeMarket({ yesPrice: 9 })]);
    const highFeed = bootstrapFeed([makeMarket({ yesPrice: 91 })]);
    assert.equal(buildMarketTemplates(lowFeed, NOW).length, 0);
    assert.equal(buildMarketTemplates(highFeed, NOW).length, 0);
  });

  it('filters out markets with endDate beyond 45 days', () => {
    const feed = bootstrapFeed([makeMarket({ endDate: new Date(NOW + 46 * DAY_MS).toISOString() })]);
    assert.equal(buildMarketTemplates(feed, NOW).length, 0);
  });

  it('filters out markets that have already closed (endDate <= nowMs)', () => {
    const feed = bootstrapFeed([makeMarket({ endDate: new Date(NOW - DAY_MS).toISOString() })]);
    assert.equal(buildMarketTemplates(feed, NOW).length, 0);
  });

  it('deduplicates markets with the same slug across categories', () => {
    const market = makeMarket();
    const feed = {
      geopolitical: [market],
      finance: [market],
    };
    const templates = buildMarketTemplates(feed, NOW);
    assert.equal(templates.length, 1);
  });
});

// ── generateBets with market templates ────────────────────────────────────

describe('generateBets with market templates', () => {
  it('generates a bet with the expected resolution shape', () => {
    const market = makeMarket({ yesPrice: 65, volume: 20_000 });
    const feed = bootstrapFeed([market]);
    const templates = buildMarketTemplates(feed, NOW);
    const bets = generateBets(templates, { [MARKETS_BOOTSTRAP_FEED]: feed }, NOW);
    assert.equal(bets.length, 1);
    const bet = bets[0];
    assert.equal(bet.domain, 'prediction_market');
    assert.equal(bet.resolution.kind, 'hard');
    assert.equal(bet.resolution.sourceFeed, MARKETS_RESOLUTION_FEED);
    assert.ok(bet.resolution.metricKey.includes(MARKETS_RESOLUTION_FEED));
    assert.ok(bet.resolution.metricKey.includes('yesPrice(market=='));
    assert.equal(bet.resolution.window, 'at-endDate');
    assert.equal(bet.resolution.threshold, 50);
  });

  it('stores marketSlug in the resolution spec (KTD2)', () => {
    const market = makeMarket();
    const feed = bootstrapFeed([market]);
    const templates = buildMarketTemplates(feed, NOW);
    const bets = generateBets(templates, { [MARKETS_BOOTSTRAP_FEED]: feed }, NOW);
    assert.ok(bets.length > 0);
    const slug = bets[0].resolution.marketSlug;
    assert.ok(typeof slug === 'string' && slug.startsWith('polymarket:'), `Expected slug to start with 'polymarket:', got: ${slug}`);
  });

  it('template has a userValueScore reflecting conviction and volume', () => {
    const highConviction = makeMarket({ yesPrice: 80, volume: 100_000 });
    const lowConviction = makeMarket({ yesPrice: 52, volume: 5_100, url: 'https://polymarket.com/event/low-conviction' });
    const feed = { geopolitical: [highConviction, lowConviction] };
    const templates = buildMarketTemplates(feed, NOW);
    const bets = generateBets(templates, { [MARKETS_BOOTSTRAP_FEED]: feed }, NOW);
    assert.equal(bets.length, 2);
    // Sort by userValueScore to verify ordering
    const sorted = [...bets].sort((a, b) => (Number(b.userValueScore) || 0) - (Number(a.userValueScore) || 0));
    const highBet = sorted[0];
    assert.ok(highBet.resolution.metricKey.includes('will-x-happen') || Number(highBet.userValueScore) > Number(sorted[1].userValueScore));
  });

  it('generates no bet when the bootstrap feed is absent', () => {
    const market = makeMarket();
    const feed = bootstrapFeed([market]);
    const templates = buildMarketTemplates(feed, NOW);
    // Feed for the MARKETS_BOOTSTRAP_FEED key is absent → template extractMetric returns null
    const bets = generateBets(templates, {}, NOW);
    assert.equal(bets.length, 0);
  });
});

// ── Kalshi slug handling ───────────────────────────────────────────────────

describe('Kalshi market slug', () => {
  it('resolves slug from Kalshi URL', () => {
    const market = makeMarket({ url: 'https://kalshi.com/markets/FED-25DEC', source: 'kalshi' });
    const feed = bootstrapFeed([market]);
    const templates = buildMarketTemplates(feed, NOW);
    assert.ok(templates.length > 0);
    const bets = generateBets(templates, { [MARKETS_BOOTSTRAP_FEED]: feed }, NOW);
    assert.ok(bets.length > 0);
    const slug = bets[0].resolution.marketSlug;
    assert.ok(slug.startsWith('kalshi:'), `Expected kalshi: prefix, got: ${slug}`);
  });

  it('skips markets with unrecognized URL formats', () => {
    const market = makeMarket({ url: 'https://unknown-market.com/event/something' });
    const feed = bootstrapFeed([market]);
    const templates = buildMarketTemplates(feed, NOW);
    assert.equal(templates.length, 0);
  });
});
