import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { INTERVAL_MIN_SAMPLE, computeScorecard, wilsonInterval } from '../scripts/_forecast-scorecard.mjs';
import { PROJECTION_HORIZONS } from '../scripts/_forecast-resolution.mjs';

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
    // The cohort's base rate is yesCount / count. The synthetic YES (c) must
    // not leak in, or the headline would be compared against the wrong null.
    assert.equal(scorecard.skill.yesCount, 1);
  });

  it('holds entries with no recorded origin out of the headline but keeps them in overall and byGenerationOrigin', () => {
    // Rows written before origin tagging carry no origin, or the resolver's
    // literal 'unknown'. They cannot be attributed to a generator (#5240).
    const absent = resolved({ probability: 0.9, outcome: 'NO' });
    delete absent.generationOrigin;
    const scorecard = computeScorecard({
      a: resolved({ probability: 0.8, outcome: 'YES', generationOrigin: 'legacy_detector' }),
      b: absent,
      c: resolved({ probability: 0.1, outcome: 'YES', generationOrigin: 'unknown' }),
    }, NOW);

    assert.equal(scorecard.overall.count, 3);
    assert.equal(scorecard.skill.count, 1);
    assert.equal(scorecard.skill.yesCount, 1);
    assert.equal(scorecard.skill.excludedScored, 2);
    assert.deepEqual(scorecard.skill.excludedOrigins, ['unknown']);
    assert.equal(scorecard.skill.brier, 0.04);
    const unknownRow = scorecard.byGenerationOrigin.find((row) => row.generationOrigin === 'unknown');
    assert.equal(unknownRow.scored, 2);
  });

  it('breaks the published-origin cohort down by domain, holding out shadow, synthetic and unattributed entries', () => {
    const absent = resolved({ probability: 0.9, outcome: 'NO', domain: 'market' });
    delete absent.generationOrigin;
    const scorecard = computeScorecard({
      a: resolved({ probability: 0.8, outcome: 'YES', domain: 'market', generationOrigin: 'detector' }),
      b: resolved({ probability: 0.4, outcome: 'NO', domain: 'market', generationOrigin: 'detector' }),
      c: resolved({ probability: 0.3, outcome: 'NO', domain: 'conflict', generationOrigin: 'detector' }),
      d: resolved({ probability: 0.1, outcome: 'YES', domain: 'market', generationOrigin: 'bet_engine' }),
      e: resolved({ probability: 0.1, outcome: 'YES', domain: 'market', generationOrigin: 'state_derived' }),
      f: absent,
      g: resolved({ probability: 0.5, outcome: 'VOID', domain: 'market', generationOrigin: 'detector' }),
      h: resolved({ probability: 0.9, outcome: 'NO', domain: 'cyber', generationOrigin: 'bet_engine' }),
    }, NOW, { promoteBetEngine: true });

    assert.deepEqual(scorecard.publishedByDomain, [
      { domain: 'conflict', count: 1, brier: 0.09, yesCount: 0 },
      { domain: 'market', count: 2, brier: 0.1, yesCount: 1 },
    ]);
    assert.equal(scorecard.byDomain.find((row) => row.domain === 'market').scored, 5, 'byDomain still pools every origin');
  });

  it('reports skill.yesCount as 0, not absent, when nothing real in the cohort came true', () => {
    const scorecard = computeScorecard({
      a: resolved({ probability: 0.4, outcome: 'NO', generationOrigin: 'detector' }),
      b: resolved({ probability: 0.9, outcome: 'YES', generationOrigin: 'state_derived' }),
    }, NOW);

    assert.equal(scorecard.skill.count, 1);
    assert.equal(scorecard.skill.yesCount, 0);
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

describe('scorecard uncertainty and maturity denominators (#7072)', () => {
  const deadline = (offsetDays) => NOW + offsetDays * DAY_MS;

  it('matches golden Wilson values, including n=0 and n=1', () => {
    assert.equal(wilsonInterval(0, 0), null, 'n=0 emits no estimate');
    assert.deepEqual(wilsonInterval(0, 1), [0, 0.793451]);
    assert.deepEqual(wilsonInterval(1, 1), [0.206549, 1]);
    assert.deepEqual(wilsonInterval(3, 10), [0.107791, 0.603222]);
  });

  it('reconciles every state against the matured denominator', () => {
    const ledger = {
      yes: resolved({ id: 'yes', outcome: 'YES', deadline: deadline(-3) }),
      no: resolved({ id: 'no', outcome: 'NO', probability: 0.2, deadline: deadline(-3) }),
      // Resolved before its deadline: decided, so matured, never a numerator above its denominator.
      early: resolved({ id: 'early', outcome: 'YES', deadline: deadline(5) }),
      voidJudged: resolved({ id: 'void-j', outcome: 'VOID', deadline: deadline(-4), evidence: { kind: 'judged', reason: 'archive_incomplete' } }),
      voidHard: resolved({ id: 'void-h', outcome: 'VOID', deadline: deadline(-4) }),
      hardPendingMatured: { id: 'hp', status: 'pending', deadline: deadline(-1) },
      hardPendingImmature: { id: 'hi', status: 'pending', deadline: deadline(10) },
      judgePendingMatured: { id: 'jp', status: 'pending-judge', spec: { deadline: deadline(-2) } },
      judgePendingImmature: { id: 'ji', status: 'pending-judge', spec: { deadline: deadline(3) } },
      undated: { id: 'u', status: 'pending' },
      nullDeadline: { id: 'nd', status: 'pending', deadline: null, spec: { deadline: null } },
    };

    const { funnel, totals } = computeScorecard(ledger, NOW);

    assert.equal(totals.entries, 11);
    assert.equal(funnel.matured, 7);
    assert.equal(funnel.immature, 2);
    assert.equal(funnel.maturityUnknown, 2, 'a null deadline is unknown, not epoch 0');
    assert.equal(funnel.matured + funnel.immature + funnel.maturityUnknown, totals.entries, 'no entry leaves the denominator');
    assert.equal(funnel.resolved, 5);
    assert.equal(funnel.scored, 3);
    assert.equal(funnel.pendingHardMatured, 1);
    assert.equal(funnel.pendingJudgeMatured, 1);
    assert.equal(funnel.resolved + funnel.pendingHardMatured + funnel.pendingJudgeMatured, funnel.matured);
    assert.deepEqual(funnel.resolvedOfMatured, { count: 7, successes: 5, rate: 0.714286, ci95: wilsonInterval(5, 7) });
    assert.deepEqual(funnel.scoredOfMatured, { count: 7, successes: 3, rate: 0.428571, ci95: wilsonInterval(3, 7) });
  });

  it('emits no maturity rate when nothing has matured', () => {
    const { funnel } = computeScorecard({ a: { id: 'a', status: 'pending', deadline: deadline(2) } }, NOW);
    assert.equal(funnel.matured, 0);
    assert.equal(funnel.resolvedOfMatured, null);
    assert.equal(funnel.scoredOfMatured, null);
  });

  it('bootstraps mean Brier at the entry level, deterministically', () => {
    const ledger = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [
      `e${i}`,
      resolved({ id: `e${i}`, probability: (i % 10) / 10 + 0.05, outcome: i % 3 === 0 ? 'YES' : 'NO', generationOrigin: i < 30 ? 'detector' : 'state_derived' }),
    ]));

    const a = computeScorecard(ledger, NOW);
    const b = computeScorecard(ledger, NOW);

    assert.deepEqual(a.uncertainty, b.uncertainty, 'seeded: a rerun reproduces every interval');
    const { overallBrier, skillBrier } = a.uncertainty;
    assert.equal(overallBrier.count, 40);
    assert.equal(overallBrier.mean, a.overall.brier);
    assert.ok(overallBrier.ci95[0] < overallBrier.mean && overallBrier.mean < overallBrier.ci95[1], 'the interval brackets the estimate');
    assert.ok(overallBrier.ci95[1] - overallBrier.ci95[0] > 0.01, 'a 40-entry sample is not a point');
    assert.equal(overallBrier.insufficientSample, 40 < INTERVAL_MIN_SAMPLE);
    assert.equal(skillBrier.count, 30, 'the headline interval covers the headline cohort, not every scored entry');
    assert.equal(skillBrier.mean, a.skill.brier);
    assert.equal(skillBrier.insufficientSample, 30 < INTERVAL_MIN_SAMPLE);
  });

  it('flags a small sample and emits no estimate for an empty one', () => {
    const small = computeScorecard({ a: resolved({ probability: 0.8, outcome: 'YES', generationOrigin: 'state_derived' }) }, NOW);
    assert.equal(small.uncertainty.overallBrier.count, 1);
    assert.equal(small.uncertainty.overallBrier.insufficientSample, true);
    assert.equal(small.uncertainty.skillBrier, null, 'an empty headline cohort has no estimate');

    const empty = computeScorecard({ a: resolved({ outcome: 'VOID' }) }, NOW);
    assert.deepEqual(empty.uncertainty, { method: empty.uncertainty.method, overallBrier: null, skillBrier: null });
    assert.ok(!JSON.stringify(empty).includes('NaN'));
  });
});

describe('Phase-2 betEngine slice + promotion flag (#5525 U14)', () => {
  function betEngineEntry(overrides) {
    return resolved({ generationOrigin: 'bet_engine', ...overrides });
  }

  it('exposes a bet_engine-scoped slice with calibration + brier, isolated from legacy', () => {
    const scorecard = computeScorecard({
      // legacy entry WITH marketPrice — must NOT leak into the slice's vsMarketSkill
      a: resolved({ probability: 0.9, outcome: 'YES', calibration: { marketPrice: 80 } }),
      b: betEngineEntry({ probability: 0.8, outcome: 'YES', calibration: { marketPrice: 60 } }),
      c: betEngineEntry({ probability: 0.4, outcome: 'NO', calibration: { marketPrice: 70 } }),
    }, NOW);

    assert.ok(scorecard.betEngine);
    assert.equal(scorecard.betEngine.count, 2);
    assert.equal(scorecard.betEngine.brier, 0.1); // ((0.8-1)^2 + (0.4-0)^2)/2
    assert.equal(scorecard.betEngine.vsMarketSkill.count, 2); // legacy 'a' excluded
    const filled = scorecard.betEngine.calibration.filter((b) => b.count > 0);
    assert.equal(filled.length, 2); // 40-50 and 80-90 deciles
  });

  it('omits the slice when nothing bet_engine is scored', () => {
    const scorecard = computeScorecard({ a: resolved({ probability: 0.8, outcome: 'YES' }) }, NOW);
    assert.ok(!Object.hasOwn(scorecard, 'betEngine'));
  });

  it('computes ensemble-vs-base-rate skill from persisted baselineProbability only', () => {
    const scorecard = computeScorecard({
      a: betEngineEntry({ probability: 0.8, outcome: 'YES', baselineProbability: 0.4 }),
      b: betEngineEntry({ probability: 0.3, outcome: 'NO', baselineProbability: 0.4 }),
      c: betEngineEntry({ probability: 0.6, outcome: 'YES' }), // no baseline → excluded
    }, NOW);
    const vsBase = scorecard.betEngine.vsBaseRate;
    assert.equal(vsBase.count, 2);
    // ensemble brier: ((0.8-1)^2 + (0.3-0)^2)/2 = 0.065; baseline: ((0.4-1)^2+(0.4-0)^2)/2 = 0.26
    assert.equal(vsBase.forecastBrier, 0.065);
    assert.equal(vsBase.baselineBrier, 0.26);
    assert.equal(vsBase.brierDelta, 0.195); // positive = ensemble beats the base rate
  });

  it('deviation skill is positive when deviations point toward outcomes, negative for noise', () => {
    const toward = computeScorecard({
      a: betEngineEntry({ probability: 0.75, outcome: 'YES', calibration: { marketPrice: 60 } }), // dev + → YES
      b: betEngineEntry({ probability: 0.45, outcome: 'NO', calibration: { marketPrice: 60 } }),  // dev − → NO
    }, NOW);
    assert.ok(toward.betEngine.deviationSkill.skill > 0, `expected positive, got ${toward.betEngine.deviationSkill.skill}`);

    const noise = computeScorecard({
      a: betEngineEntry({ probability: 0.75, outcome: 'NO', calibration: { marketPrice: 60 } }),  // dev + → NO
      b: betEngineEntry({ probability: 0.45, outcome: 'YES', calibration: { marketPrice: 60 } }), // dev − → YES
    }, NOW);
    assert.ok(noise.betEngine.deviationSkill.skill < 0, `expected negative, got ${noise.betEngine.deviationSkill.skill}`);
  });

  it('small deviations inside the band are excluded from deviation skill', () => {
    const scorecard = computeScorecard({
      a: betEngineEntry({ probability: 0.62, outcome: 'YES', calibration: { marketPrice: 60 } }), // |dev| 0.02 <= band
    }, NOW);
    assert.ok(!scorecard.betEngine.deviationSkill);
  });

  it('promoteBetEngine flag is the only promotion path into the skill headline', () => {
    const ledger = {
      a: resolved({ probability: 0.8, outcome: 'YES' }),
      b: betEngineEntry({ probability: 0.2, outcome: 'NO' }),
    };
    const off = computeScorecard(ledger, NOW);
    assert.equal(off.skill.count, 1); // bet_engine excluded (default)
    assert.deepEqual(off.skill.excludedOrigins, ['bet_engine']);
    const on = computeScorecard(ledger, NOW, { promoteBetEngine: true });
    assert.equal(on.skill.count, 2); // promoted
    assert.deepEqual(on.skill.excludedOrigins, []);
  });
});

describe('projection horizon lane (#7075)', () => {
  function horizonRow(horizon, overrides = {}) {
    const deadline = overrides.deadline ?? NOW - 2 * DAY_MS;
    return resolved({
      id: 'fc-h',
      key: `fc-h@1@${horizon}`,
      parentKey: 'fc-h@1',
      timeHorizon: PROJECTION_HORIZONS[horizon],
      domain: 'supply_chain',
      deadline,
      spec: { kind: 'hard', horizon, semantics: 'point_in_time', window: 'at-deadline', deadline },
      ...overrides,
    });
  }
  const pendingRow = (horizon, deadline) => horizonRow(horizon, { status: 'pending', outcome: undefined, resolvedAt: undefined, deadline });

  it('keeps horizon rows out of every forecast metric and reports them in their own section', () => {
    const ledger = {
      a: resolved({ probability: 0.8, outcome: 'YES' }),
      b: resolved({ probability: 0.4, outcome: 'NO' }),
      h1: horizonRow('d7', { probability: 0.9, outcome: 'YES' }),
      h2: horizonRow('d7', { probability: 0.2, outcome: 'NO' }),
      h3: horizonRow('d7', { probability: 0.5, outcome: 'UNOBSERVED' }),
      h4: horizonRow('d7', { probability: 0.5, outcome: 'VOID' }),
      h5: pendingRow('h24', NOW + DAY_MS),
      h6: pendingRow('d30', NOW - DAY_MS),
    };
    const scorecard = computeScorecard(ledger, NOW);
    assert.equal(scorecard.totals.entries, 2);
    assert.equal(scorecard.totals.scored, 2);
    assert.equal(scorecard.overall.brier, 0.1);
    assert.equal(scorecard.skill.count, 2);
    assert.equal(scorecard.funnel.matured, 2);
    assert.equal(scorecard.uncertainty.overallBrier.count, 2);
    assert.deepEqual(scorecard.byDomain.map((row) => row.domain), ['market']);

    assert.equal(scorecard.projections.semantics, 'point_in_time');
    assert.equal(scorecard.projections.minSample, INTERVAL_MIN_SAMPLE);
    assert.deepEqual(scorecard.projections.byHorizon, [
      { horizon: 'h24', registered: 1, matured: 0, resolved: 0, scored: 0, yes: 0, no: 0, unobserved: 0, void: 0, brier: null, insufficientSample: true },
      { horizon: 'd7', registered: 4, matured: 4, resolved: 4, scored: 2, yes: 1, no: 1, unobserved: 1, void: 1, brier: null, insufficientSample: true },
      { horizon: 'd30', registered: 1, matured: 1, resolved: 0, scored: 0, yes: 0, no: 0, unobserved: 0, void: 0, brier: null, insufficientSample: true },
    ]);
  });

  it('reports the section with zero rows on an empty ledger, in the builder order', () => {
    const { byHorizon } = computeScorecard({}, NOW).projections;
    assert.deepEqual(byHorizon.map((row) => row.horizon), Object.keys(PROJECTION_HORIZONS));
    assert.ok(byHorizon.every((row) => row.registered === 0 && row.brier === null));
  });

  it('reports a horizon Brier only once that horizon reaches the minimum sample', () => {
    const rows = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [
      `h${i}`,
      horizonRow('d7', { id: `fc-${i}`, key: `fc-${i}@1@d7`, probability: 0.5, outcome: i % 2 ? 'YES' : 'NO' }),
    ]));
    const d7 = (count) => computeScorecard(rows(count), NOW).projections.byHorizon.find((row) => row.horizon === 'd7');

    const below = d7(INTERVAL_MIN_SAMPLE - 1);
    assert.equal(below.scored, INTERVAL_MIN_SAMPLE - 1);
    assert.equal(below.brier, null);
    assert.equal(below.insufficientSample, true);

    const at = d7(INTERVAL_MIN_SAMPLE);
    assert.equal(at.insufficientSample, false);
    assert.equal(at.brier.count, INTERVAL_MIN_SAMPLE);
    assert.equal(at.brier.mean, 0.25);
    assert.ok(at.brier.ci95);
  });
});
