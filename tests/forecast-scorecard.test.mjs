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
