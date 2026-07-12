import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { computeScorecard } from '../scripts/_forecast-scorecard.mjs';

const NOW = Date.parse('2026-07-20T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function resolved(overrides) {
  return {
    id: 'fc-default',
    status: 'resolved',
    outcome: 'YES',
    probability: 0.7,
    domain: 'market',
    generationOrigin: 'detector',
    firstSeenAt: NOW - 5 * DAY_MS,
    resolvedAt: NOW - DAY_MS,
    ...overrides,
  };
}

describe('computeScorecard', () => {
  it('computes Brier, log score, coverage, VOID rate, and calibration from resolved entries', () => {
    const ledger = {
      a: resolved({ probability: 0.8, outcome: 'YES', domain: 'market' }),
      b: resolved({ probability: 0.4, outcome: 'NO', domain: 'market' }),
      c: resolved({ probability: 0.7, outcome: 'VOID', domain: 'conflict' }),
      d: { id: 'pending', status: 'pending', probability: 0.55, domain: 'market', firstSeenAt: NOW - DAY_MS },
      e: { id: 'judge', status: 'pending-judge', probability: 0.55, domain: 'political', firstSeenAt: NOW - DAY_MS },
    };

    const scorecard = computeScorecard(ledger, NOW);

    assert.equal(scorecard.generatedAt, NOW);
    assert.equal(scorecard.totals.entries, 5);
    assert.equal(scorecard.totals.resolved, 3);
    assert.equal(scorecard.totals.pending, 1);
    assert.equal(scorecard.totals.pendingJudge, 1);
    assert.equal(scorecard.totals.scored, 2);
    assert.equal(scorecard.totals.void, 1);
    assert.equal(scorecard.totals.voidRate, 0.333333);
    assert.equal(scorecard.totals.publicationCoverage, 0.4);
    assert.equal(scorecard.overall.brier, 0.1);
    assert.equal(scorecard.overall.logScore, 0.366985);

    const market = scorecard.byDomain.find((row) => row.domain === 'market');
    assert.equal(market.scored, 2);
    assert.equal(market.brier, 0.1);

    const bucket = scorecard.calibration.find((row) => row.bucket === '80-90');
    assert.equal(bucket.count, 1);
    assert.equal(bucket.realizedRate, 1);
  });

  it('computes vs-market skill only from anchored scored entries', () => {
    const ledger = {
      a: resolved({
        probability: 0.8,
        outcome: 'YES',
        calibration: { marketPrice: 60 },
      }),
      b: resolved({
        probability: 0.4,
        outcome: 'NO',
        calibration: { marketPrice: 70 },
      }),
      c: resolved({
        probability: 0.7,
        outcome: 'YES',
      }),
    };

    const scorecard = computeScorecard(ledger, NOW);

    assert.equal(scorecard.vsMarketSkill.count, 2);
    assert.equal(scorecard.vsMarketSkill.forecastBrier, 0.1);
    assert.equal(scorecard.vsMarketSkill.marketBrier, 0.325);
    assert.equal(scorecard.vsMarketSkill.brierDelta, 0.225);
  });

  it('reports all-VOID input without NaN accuracy fields', () => {
    const scorecard = computeScorecard({
      a: resolved({ outcome: 'VOID' }),
      b: resolved({ outcome: 'VOID', domain: 'conflict' }),
    }, NOW);

    assert.equal(scorecard.totals.voidRate, 1);
    assert.equal(scorecard.totals.scored, 0);
    assert.ok(!Object.hasOwn(scorecard, 'overall'));
    assert.ok(!JSON.stringify(scorecard).includes('NaN'));
  });

  it('reports a skill block that excludes synthetic and shadow origins from the headline', () => {
    const ledger = {
      // real generator entries — these count toward skill
      a: resolved({ probability: 0.8, outcome: 'YES', generationOrigin: 'detector' }),
      b: resolved({ probability: 0.4, outcome: 'NO', generationOrigin: 'detector' }),
      // synthetic backfill — inflates overall, must be held out of skill
      c: resolved({ probability: 0.9, outcome: 'YES', generationOrigin: 'state_derived' }),
      // shadow bet-engine — scored for evidence but not promoted to the headline
      d: resolved({ probability: 0.2, outcome: 'NO', generationOrigin: 'bet_engine' }),
    };

    const scorecard = computeScorecard(ledger, NOW);

    // overall still counts everything for continuity
    assert.equal(scorecard.overall.count, 4);
    // skill counts only the two real-generator entries
    assert.equal(scorecard.skill.count, 2);
    assert.equal(scorecard.skill.excludedScored, 2);
    assert.deepEqual(scorecard.skill.excludedOrigins, ['bet_engine', 'state_derived']);
    // Brier over the two detector entries only: ((0.8-1)^2 + (0.4-0)^2)/2 = 0.1
    assert.equal(scorecard.skill.brier, 0.1);
  });

  it('always emits skill.excludedOrigins as an array (empty on a healthy scorecard)', () => {
    // No synthetic/shadow origins → excludedOrigins must be [], not omitted, so
    // a typed client (proto `repeated string`) can read .length on this path.
    const scorecard = computeScorecard({
      a: resolved({ probability: 0.8, outcome: 'YES', generationOrigin: 'detector' }),
      b: resolved({ probability: 0.4, outcome: 'NO', generationOrigin: 'detector' }),
    }, NOW);

    assert.equal(scorecard.skill.count, 2);
    assert.equal(scorecard.skill.excludedScored, 0);
    assert.ok(Array.isArray(scorecard.skill.excludedOrigins));
    assert.deepEqual(scorecard.skill.excludedOrigins, []);
  });

  it('surfaces a fully synthetic funnel as skill.count 0 without NaN', () => {
    const scorecard = computeScorecard({
      a: resolved({ probability: 0.9, outcome: 'YES', generationOrigin: 'state_derived' }),
      b: resolved({ probability: 0.3, outcome: 'NO', generationOrigin: 'state_derived' }),
    }, NOW);

    // overall reports data, but skill loudly shows none of it is real skill
    assert.equal(scorecard.overall.count, 2);
    assert.equal(scorecard.skill.count, 0);
    assert.equal(scorecard.skill.excludedScored, 2);
    assert.ok(!Object.hasOwn(scorecard.skill, 'brier'));
    assert.ok(!JSON.stringify(scorecard).includes('NaN'));
  });

  it('omits the skill block entirely when nothing is scored', () => {
    const scorecard = computeScorecard({
      a: resolved({ outcome: 'VOID' }),
    }, NOW);

    assert.ok(!Object.hasOwn(scorecard, 'skill'));
  });

  it('uses resolvedAt for rolling windows and is deterministic', () => {
    const ledger = {
      old: resolved({ probability: 0.9, outcome: 'NO', resolvedAt: NOW - 200 * DAY_MS }),
      fresh: resolved({ probability: 0.9, outcome: 'YES', resolvedAt: NOW - DAY_MS }),
    };

    const a = computeScorecard(ledger, NOW, { rollingWindowDays: 90 });
    const b = computeScorecard(ledger, NOW, { rollingWindowDays: 90 });

    assert.deepEqual(a, b);
    assert.equal(a.totals.scored, 1);
    assert.equal(a.overall.brier, 0.01);
  });
});
