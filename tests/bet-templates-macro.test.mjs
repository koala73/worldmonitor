import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractFredObservations, MACRO_BET_TEMPLATES, MACRO_FEEDS } from '../scripts/_bet-templates-macro.mjs';
import { generateBets } from '../scripts/_bet-templates.mjs';
import { RESOLUTION_FEED_KEYS } from '../scripts/_forecast-resolution.mjs';
import { FRED_VALUE_SETTLEMENT_MAX_LAG_MS } from '../scripts/_forecast-resolution-eval.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-24T00:00:00Z');

// ── extractFredObservations (#5098 P1 regression) ──────────────────────────

describe('extractFredObservations', () => {
  it('unwraps {series:{observations}} — the primary shape from seed-economy.mjs', () => {
    const feed = {
      data: {
        series: {
          seriesId: 'FEDFUNDS',
          observations: [{ date: '2026-06-01', value: 5.33 }],
        },
      },
    };
    const obs = extractFredObservations(feed);
    assert.ok(Array.isArray(obs));
    assert.equal(obs.length, 1);
    assert.equal(obs[0].value, 5.33);
  });

  it('also handles the flat {observations} shape (legacy / ais-relay)', () => {
    const feed = { observations: [{ date: '2026-06-01', value: 4.5 }] };
    const obs = extractFredObservations(feed);
    assert.ok(Array.isArray(obs));
    assert.equal(obs[0].value, 4.5);
  });

  it('returns null when the feed is empty', () => {
    assert.equal(extractFredObservations(null), null);
    assert.equal(extractFredObservations({}), null);
    assert.equal(extractFredObservations({ data: {} }), null);
  });

  it('returns null when observations is not an array', () => {
    const feed = { data: { series: { seriesId: 'FEDFUNDS', observations: 'bad' } } };
    assert.equal(extractFredObservations(feed), null);
  });
});

// ── MACRO_FEEDS / allowlist parity ─────────────────────────────────────────

describe('MACRO_FEEDS', () => {
  it('lists 4 FRED feed keys', () => {
    assert.equal(MACRO_FEEDS.length, 4);
  });

  it('every MACRO_FEEDS key is in RESOLUTION_FEED_KEYS (exact-match allowlist, KTD4)', () => {
    for (const key of MACRO_FEEDS) {
      assert.ok(
        RESOLUTION_FEED_KEYS.has(key),
        `Expected '${key}' in RESOLUTION_FEED_KEYS but it was missing`,
      );
    }
  });
});

// ── FRED_VALUE_SETTLEMENT_MAX_LAG_MS ─────────────────────────────────────────

describe('FRED_VALUE_SETTLEMENT_MAX_LAG_MS', () => {
  it('is 75 days (monthly obs worst-case lag, KTD4)', () => {
    assert.equal(FRED_VALUE_SETTLEMENT_MAX_LAG_MS, 75 * DAY_MS);
  });
});

// ── generateBets with FRED feeds ──────────────────────────────────────────

function fredFeedFixture(seriesId, latestValue, previousValue = null) {
  const observations = [];
  if (previousValue !== null) {
    observations.push({ date: '2026-05-01', value: previousValue });
  }
  observations.push({ date: '2026-06-01', value: latestValue });
  return {
    data: {
      series: { seriesId, observations },
    },
  };
}

describe('generateBets with MACRO_BET_TEMPLATES', () => {
  it('generates at least one FEDFUNDS bet when feed is valid', () => {
    const feedsByKey = {
      'economic:fred:v1:FEDFUNDS:0': fredFeedFixture('FEDFUNDS', 5.33, 5.25),
    };
    const bets = generateBets(MACRO_BET_TEMPLATES, feedsByKey, NOW);
    const fredBets = bets.filter((b) => b.id?.includes('fedfunds'));
    assert.ok(fredBets.length > 0, 'Expected at least one FEDFUNDS bet');
    const bet = fredBets[0];
    assert.equal(bet.domain, 'macro');
    assert.equal(bet.resolution.kind, 'hard');
    assert.equal(bet.resolution.sourceFeed, 'economic:fred:v1:FEDFUNDS:0');
    assert.ok(
      bet.resolution.metricKey.includes('economic:fred:v1:FEDFUNDS:0|value(series==FEDFUNDS)'),
      `Unexpected metricKey: ${bet.resolution.metricKey}`,
    );
  });

  it('generates no bets when the feed has the {series:{observations}} shape missing', () => {
    // Simulates the #5098 bug: feed without the observations path.
    const feedsByKey = {
      'economic:fred:v1:FEDFUNDS:0': { data: { fred_series: { FEDFUNDS: 5.33 } } },
    };
    const bets = generateBets(MACRO_BET_TEMPLATES, feedsByKey, NOW);
    const fredBets = bets.filter((b) => b.id?.includes('fedfunds'));
    assert.equal(fredBets.length, 0);
  });

  it('sets window=at-deadline for monthly FRED series', () => {
    const feedsByKey = {
      'economic:fred:v1:UNRATE:0': fredFeedFixture('UNRATE', 4.1, 4.2),
    };
    const bets = generateBets(MACRO_BET_TEMPLATES, feedsByKey, NOW);
    const bet = bets.find((b) => b.id?.includes('unrate'));
    assert.ok(bet, 'Expected UNRATE bet');
    assert.equal(bet.resolution.window, 'at-deadline');
  });

  it('deadline is within 75 days for monthly series (FEDFUNDS)', () => {
    const feedsByKey = {
      'economic:fred:v1:FEDFUNDS:0': fredFeedFixture('FEDFUNDS', 5.33, 5.25),
    };
    const bets = generateBets(MACRO_BET_TEMPLATES, feedsByKey, NOW);
    const bet = bets.find((b) => b.id?.includes('fedfunds'));
    assert.ok(bet);
    const horizonMs = bet.resolution.deadline - NOW;
    // Monthly horizon is 45d (MONTHLY_HORIZON_MS in _bet-templates-macro.mjs)
    assert.ok(horizonMs > 0 && horizonMs <= 50 * DAY_MS, `Horizon ${horizonMs / DAY_MS}d out of range`);
  });

  it('DGS10 deadline is within 14 days (daily series)', () => {
    const feedsByKey = {
      'economic:fred:v1:DGS10:0': fredFeedFixture('DGS10', 4.28, 4.20),
    };
    const bets = generateBets(MACRO_BET_TEMPLATES, feedsByKey, NOW);
    const bet = bets.find((b) => b.id?.includes('dgs10'));
    assert.ok(bet, 'Expected DGS10 bet');
    const horizonMs = bet.resolution.deadline - NOW;
    assert.ok(horizonMs > 0 && horizonMs <= 14 * DAY_MS + DAY_MS, `Horizon ${horizonMs / DAY_MS}d out of range for daily series`);
  });

  it('generates no CPIAUCSL bet when feed is absent', () => {
    const feedsByKey = {};
    const bets = generateBets(MACRO_BET_TEMPLATES, feedsByKey, NOW);
    const cpi = bets.filter((b) => b.id?.includes('cpiaucsl'));
    assert.equal(cpi.length, 0);
  });

  it('threshold direction matches the latest move direction', () => {
    // Rising rate: threshold should be higher than baseline.
    const feedsByKey = {
      'economic:fred:v1:FEDFUNDS:0': fredFeedFixture('FEDFUNDS', 5.50, 5.25), // rising
    };
    const bets = generateBets(MACRO_BET_TEMPLATES, feedsByKey, NOW);
    const bet = bets.find((b) => b.id?.includes('fedfunds'));
    assert.ok(bet);
    assert.ok(bet.resolution.threshold >= bet.resolution.baselineValue,
      `Expected threshold ${bet.resolution.threshold} >= baseline ${bet.resolution.baselineValue} for rising rate`);
  });
});
