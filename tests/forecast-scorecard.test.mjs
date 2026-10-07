import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_ROLLING_WINDOW_DAYS,
  DEFAULT_SKILL_EXCLUDED_ORIGINS,
  INTERVAL_MIN_SAMPLE,
  PUBLIC_RECEIPT_FIELDS,
  PUBLIC_RECEIPT_LINKS_SINCE_MS,
  PUBLIC_RECEIPT_LIMIT,
  RECEIPT_SOURCE_FEEDS,
  RECEIPT_SOURCE_LABELS,
  RECEIPT_VOID_REASON_LABELS,
  FAMILY_OUTCOME_LIMIT,
  PUBLIC_FAMILY_OUTCOME_FIELDS,
  buildFamilyOutcomes,
  buildPublicReceipts,
  computeScorecard,
  isWithheldEntry,
  wilsonInterval,
} from '../scripts/_forecast-scorecard.mjs';
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

  it('drops withheld state-derived market buckets from every published figure but keeps energy and freight (#5234)', () => {
    const stateDerived = (title, domain, outcome) => resolved({
      title, domain, outcome, probability: 0.6, generationOrigin: 'state_derived',
    });
    const ledger = {
      a: resolved({ probability: 0.8, outcome: 'YES', generationOrigin: 'detector' }),
      b: resolved({ probability: 0.3, outcome: 'VOID', generationOrigin: 'detector' }),
      sov: stateDerived('Sovereign risk repricing from Iran security escalation state', 'market', 'VOID'),
      sovYes: stateDerived('Sovereign risk repricing from Gulf maritime disruption state', 'market', 'YES'),
      fx: stateDerived('FX stress from Americas governance pressure state', 'market', 'VOID'),
      rates: stateDerived('Inflation and rates pressure from Red Sea maritime disruption state', 'market', 'VOID'),
      ratesPending: { ...stateDerived('Inflation and rates pressure from Andes state', 'market'), status: 'pending-judge', outcome: undefined },
      energy: stateDerived('Energy repricing risk from Red Sea maritime disruption state', 'market', 'VOID'),
      freight: stateDerived('Supply chain disruption risk from Red Sea maritime disruption state', 'supply_chain', 'YES'),
    };

    const scorecard = computeScorecard(ledger, NOW);

    assert.equal(scorecard.totals.entries, 4);
    assert.equal(scorecard.totals.resolved, 4);
    assert.equal(scorecard.totals.void, 2);
    assert.equal(scorecard.totals.voidRate, 0.5);
    assert.equal(scorecard.totals.pendingJudge, 0);
    assert.equal(scorecard.overall.count, 2);
    const stateRow = scorecard.byGenerationOrigin.find((row) => row.generationOrigin === 'state_derived');
    assert.equal(stateRow.resolved, 2);
    assert.equal(scorecard.skill.count, 1);
    assert.ok(Object.hasOwn(ledger, 'sov'), 'ledger rows are not deleted');
  });

  it('withholds by stored bucket id first and by title only for legacy rows, including unattributed ones (#5234)', () => {
    const ledger = {
      a: resolved({ outcome: 'YES', generationOrigin: 'detector' }),
      byBucket: resolved({ outcome: 'VOID', generationOrigin: 'state_derived', stateBucketId: 'rates_inflation', title: 'Retitled pressure from Andes state' }),
      energyBucket: resolved({ outcome: 'VOID', generationOrigin: 'state_derived', stateBucketId: 'energy', title: 'FX stress from Andes state' }),
      legacyUnknown: resolved({ outcome: 'VOID', generationOrigin: undefined, title: 'FX stress from Americas governance pressure state' }),
      detectorTitle: resolved({ outcome: 'VOID', generationOrigin: 'detector', title: 'FX stress from a detector' }),
    };

    const scorecard = computeScorecard(ledger, NOW);

    const withheld = Object.fromEntries(Object.entries(ledger).map(([key, entry]) => [key, isWithheldEntry(entry)]));
    assert.deepEqual(withheld, { a: false, byBucket: true, energyBucket: false, legacyUnknown: true, detectorTitle: false });
    assert.equal(scorecard.totals.resolved, 3);
    assert.equal(scorecard.totals.void, 2);
    assert.equal(scorecard.byGenerationOrigin.some((row) => row.generationOrigin === 'unknown'), false);
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

    assert.equal(scorecard.schemaVersion, 2, 'schema 2 marks a seed that carries publishedByDomain');
    assert.deepEqual(scorecard.publishedByDomain, [
      { domain: 'conflict', count: 1, brier: 0.09, yesCount: 0 },
      { domain: 'market', count: 2, brier: 0.1, yesCount: 1 },
    ]);
    assert.equal(scorecard.byDomain.find((row) => row.domain === 'market').scored, 5, 'byDomain still pools every origin');
    // Documented divergence (#8952): promotion adds bet_engine to the headline
    // skill cohort (a, b, c, d, h) but never to the published-domain rows.
    assert.equal(scorecard.skill.count, 5);
    assert.equal(scorecard.publishedByDomain.some((row) => row.domain === 'cyber'), false);
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

describe('public forecast receipts (#5092)', () => {
  // After the publisher-link cutoff, so judged citations may carry a link.
  const NOW = Date.parse('2026-11-01T00:00:00Z');
  const SECRET = 'SECRET-SENTINEL';
  const hardEntry = (overrides = {}) => ({
    id: `commodity:${SECRET}`,
    key: `commodity:${SECRET}@1`,
    status: 'resolved',
    outcome: 'NO',
    domain: 'market',
    title: 'The Brent crude oil price: rise to 104.89 USD/bbl?',
    generationOrigin: 'legacy_detector',
    probability: 0.35,
    generatedAt: NOW - 5 * DAY_MS,
    firstSeenAt: NOW - 5 * DAY_MS,
    resolvedAt: NOW - DAY_MS,
    spec: {
      kind: 'hard',
      metricKey: `market:commodities-bootstrap:v1|price(symbol==${SECRET})`,
      sourceFeed: 'market:commodities-bootstrap:v1',
      question: 'Will the Brent crude oil price rise to at least 104.89 USD/bbl by 2026-10-06?',
    },
    passes: [{ name: 'ensemble_inside_view', probability: 0.35, rationale: SECRET }],
    samples: { count: 1, recent: [{ ts: 1, value: 100.75 }] },
    evidence: { metricValue: 100.75, comparison: SECRET, metricKey: SECRET, resolvedAt: NOW - DAY_MS },
    receiptArchiveKey: `seed-data/${SECRET}.json`,
    receiptArchivedAt: NOW,
    ...overrides,
  });
  const judgedEntry = (overrides = {}) => ({
    id: `fc-conflict-${SECRET}`,
    key: `fc-conflict-${SECRET}@2`,
    status: 'resolved',
    outcome: 'YES',
    domain: 'conflict',
    title: 'Active armed conflict: Nigeria',
    generationOrigin: 'legacy_detector',
    probability: 0.7,
    generatedAt: NOW - 30 * DAY_MS,
    resolvedAt: NOW - 2 * DAY_MS,
    spec: { kind: 'judged', question: 'Within the 30d horizon, did Nigeria see escalated armed conflict?' },
    judgeAttemptLog: [{ attempt: 1, reason: SECRET }],
    evidence: {
      kind: 'judged',
      reason: 'dual_model_agreement',
      judgedBy: [{ provider: SECRET, model: SECRET, outcome: 'YES' }],
      judgments: [{ provider: SECRET, rationale: SECRET, citations: [] }],
      citations: [{
        id: 'N510',
        title: 'Dozens of people abducted in attacks on villages in Nigeria, police say - BBC',
        url: 'https://www.bbc.co.uk/news/world-africa-1',
        publishedAt: NOW - 3 * DAY_MS,
        quote: SECRET,
      }],
      archive: [{ id: 'N1', title: SECRET, url: `https://example.org/${SECRET}` }],
    },
    ...overrides,
  });

  const build = (ledger, ...rest) => buildPublicReceipts(ledger, NOW, ...rest);

  it('publishes only whitelisted members, never rationale, archive, keys or metric paths', () => {
    const receipts = build({ a: hardEntry(), b: judgedEntry() });
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) {
      for (const field of Object.keys(receipt)) {
        assert.ok(PUBLIC_RECEIPT_FIELDS.includes(field), `unlisted receipt field ${field}`);
      }
    }
    assert.doesNotMatch(JSON.stringify(receipts), new RegExp(SECRET));
  });

  it('lists resolved entries newest first, bounded, and skips open ones', () => {
    const ledger = {};
    for (let i = 0; i < PUBLIC_RECEIPT_LIMIT + 5; i++) {
      ledger[`r${i}`] = hardEntry({ resolvedAt: NOW - i * 1000 });
    }
    ledger.open = hardEntry({ status: 'pending', outcome: undefined, resolvedAt: NOW + 1000 });
    const receipts = build(ledger);
    assert.equal(receipts.length, PUBLIC_RECEIPT_LIMIT);
    assert.equal(receipts[0].resolvedAt, NOW);
    for (let i = 1; i < receipts.length; i++) {
      assert.ok(receipts[i - 1].resolvedAt >= receipts[i].resolvedAt, 'newest first');
    }
  });

  it('shapes a hard receipt from the feed vocabulary and the observed value', () => {
    const [receipt] = build([hardEntry()]);
    assert.deepEqual(receipt, {
      question: 'Will the Brent crude oil price rise to at least 104.89 USD/bbl by 2026-10-06?',
      forecastAt: NOW - 5 * DAY_MS,
      probability: 0.35,
      outcome: 'NO',
      resolvedAt: NOW - DAY_MS,
      sourceFeed: 'commodity-prices',
      observedValue: 100.75,
    });
  });

  it('shapes a judged receipt from the agreed citation, https links only', () => {
    const [receipt] = build([judgedEntry()]);
    assert.equal(receipt.sourceFeed, undefined);
    assert.equal(receipt.citationTitle, 'Dozens of people abducted in attacks on villages in Nigeria, police say - BBC');
    assert.equal(receipt.citationUrl, 'https://www.bbc.co.uk/news/world-africa-1');
    for (const url of ['javascript:alert(1)', 'http://plain.example/a', 'https://user:pw@host.example/a', 'not a url']) {
      const [unsafe] = build([judgedEntry({
        evidence: { ...judgedEntry().evidence, citations: [{ title: 'Headline', url }] },
      })]);
      assert.equal(unsafe.citationTitle, 'Headline', 'the cited item title survives without a link');
      assert.equal(unsafe.citationUrl, undefined, `${url} must not be published as a link`);
    }
  });

  it('keeps VOIDs with a fixed-vocabulary reason and no citation', () => {
    const receipts = build([
      judgedEntry({ outcome: 'VOID', evidence: { ...judgedEntry().evidence, reason: 'beyond_archive_horizon' } }),
      hardEntry({ outcome: 'VOID', evidence: { reason: 'no_establishable_metric', metricKey: SECRET } }),
      hardEntry({ outcome: 'VOID', resolvedAt: NOW - 3 * DAY_MS, evidence: { reason: `${SECRET} free text` } }),
    ]);
    assert.deepEqual(receipts.map((receipt) => receipt.voidReason), ['no_establishable_metric', 'beyond_archive_horizon', 'other']);
    assert.equal(receipts[1].citationTitle, undefined, 'a VOID was not settled by any cited item');
    assert.equal(receipts[0].observedValue, undefined);
    for (const receipt of receipts) assert.ok(Object.hasOwn(RECEIPT_VOID_REASON_LABELS, receipt.voidReason));
  });

  it('maps every resolution feed to a public source code, and anything else to other', async () => {
    const { RESOLUTION_FEED_KEYS } = await import('../scripts/_forecast-resolution.mjs');
    for (const feed of RESOLUTION_FEED_KEYS) {
      const code = RECEIPT_SOURCE_FEEDS[feed];
      assert.ok(code && Object.hasOwn(RECEIPT_SOURCE_LABELS, code), `${feed} needs a public source code`);
    }
    for (const sourceFeed of [`internal:${SECRET}:v9`, '__proto__', 'constructor', 'toString']) {
      const [receipt] = build([hardEntry({ spec: { ...hardEntry().spec, sourceFeed } })]);
      assert.equal(receipt.sourceFeed, 'other', `${sourceFeed} is not a public feed`);
    }
  });

  it('lists only the headline cohort, never shadow, synthetic or unattributed entries', () => {
    const receipts = build([
      hardEntry({ generationOrigin: 'bet_engine', resolvedAt: NOW - 1 }),
      hardEntry({ generationOrigin: 'state_derived', resolvedAt: NOW - 2 }),
      hardEntry({ generationOrigin: undefined, resolvedAt: NOW - 3 }),
      hardEntry({ resolvedAt: NOW - 4 }),
    ]);
    assert.deepEqual(receipts.map((receipt) => receipt.resolvedAt), [NOW - 4]);
  });

  it('leaves projection horizon windows out, as every forecast-window reader does', () => {
    const receipts = build([
      hardEntry({ spec: { ...hardEntry().spec, horizon: '7d' }, resolvedAt: NOW - 1 }),
      hardEntry({ resolvedAt: NOW - 2 }),
    ]);
    assert.deepEqual(receipts.map((receipt) => receipt.resolvedAt), [NOW - 2]);
  });

  it('publishes the probability the scorer used, clamped to [0, 1]', () => {
    const receipts = build([hardEntry({ probability: -0.2, resolvedAt: NOW - 1 }), hardEntry({ probability: 1.4, resolvedAt: NOW - 2 })]);
    assert.deepEqual(receipts.map((receipt) => receipt.probability), [0, 1]);
  });

  it('keeps shadow bet-engine entries out even when the headline promotes them', () => {
    assert.equal(build([hardEntry({ generationOrigin: 'bet_engine' })], { promoteBetEngine: true }).length, 0);
    for (const origin of DEFAULT_SKILL_EXCLUDED_ORIGINS) {
      assert.equal(build([hardEntry({ generationOrigin: origin })]).length, 0, `${origin} must not be a receipt`);
    }
  });

  it('lists only entries resolved inside the rolling window', () => {
    const receipts = build([
      hardEntry({ resolvedAt: NOW - 400 * DAY_MS }),
      hardEntry({ resolvedAt: NOW - (DEFAULT_ROLLING_WINDOW_DAYS - 1) * DAY_MS }),
    ]);
    assert.deepEqual(receipts.map((receipt) => receipt.resolvedAt), [NOW - (DEFAULT_ROLLING_WINDOW_DAYS - 1) * DAY_MS]);
  });

  it('drops citation links that could predate the publisher-link gate, keeping the title', async () => {
    const { FORECAST_EVIDENCE_TTL_S } = await import('../scripts/_forecast-evidence-archive.mjs');
    assert.equal(
      PUBLIC_RECEIPT_LINKS_SINCE_MS,
      Date.parse('2026-09-21T16:39:21Z') + FORECAST_EVIDENCE_TTL_S * 1000 + DAY_MS,
      'the cutoff is the #8408 merge plus the evidence archive retention plus a day for the rollout',
    );
    const [early, late] = [PUBLIC_RECEIPT_LINKS_SINCE_MS - 1, PUBLIC_RECEIPT_LINKS_SINCE_MS]
      .map((resolvedAt) => buildPublicReceipts([judgedEntry({ resolvedAt })], NOW)[0]);
    assert.equal(early.citationUrl, undefined);
    assert.equal(early.citationTitle, 'Dozens of people abducted in attacks on villages in Nigeria, police say - BBC');
    assert.equal(late.citationUrl, 'https://www.bbc.co.uk/news/world-africa-1');
  });

  it('stays bounded when every text field is at its worst', () => {
    const long = `<script>${'x'.repeat(5000)}`;
    const ledger = Array.from({ length: 500 }, (_, i) => judgedEntry({
      resolvedAt: NOW - i,
      spec: { kind: 'judged', question: long },
      evidence: { ...judgedEntry().evidence, citations: [{ title: long, url: `https://example.org/${'y'.repeat(5000)}` }] },
    }));
    const receipts = build(ledger);
    const kept = build(Array.from({ length: 500 }, (_, i) => judgedEntry({
      resolvedAt: NOW - i,
      spec: { kind: 'judged', question: long },
      evidence: { ...judgedEntry().evidence, citations: [{ title: long, url: `https://example.org/${'y'.repeat(499 - 'https://example.org/'.length)}` }] },
    })));
    assert.equal(kept[0].citationUrl.length, 499, 'the worst kept link is just under the cap');
    assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= 24_000, `worst case with links is ${Buffer.byteLength(JSON.stringify(kept))} bytes`);
    assert.equal(receipts.length, PUBLIC_RECEIPT_LIMIT);
    assert.ok(receipts[0].question.length <= 240);
    assert.ok(receipts[0].citationTitle.length <= 160);
    assert.equal(receipts[0].citationUrl, undefined, 'an over-long URL is dropped, not truncated into a different link');
    assert.ok(Buffer.byteLength(JSON.stringify(receipts)) <= 16_000);
  });
});

describe('buildFamilyOutcomes (#5092 card chips)', () => {
  const win = (id, resolvedAt, outcome, extra = {}) => ({
    id, key: `${id}@${resolvedAt}`, status: 'resolved', outcome, resolvedAt, deadline: resolvedAt,
    probability: 0.6, domain: 'conflict', generationOrigin: 'legacy_detector', ...extra,
  });
  const open = (id, extra = {}) => ({
    id, key: `${id}@open`, status: 'pending', probability: 0.6, domain: 'conflict',
    generationOrigin: 'legacy_detector', deadline: NOW + 5 * DAY_MS, ...extra,
  });

  it('lists the newest resolved windows of each live published family, newest first', () => {
    const ledger = [
      open('fam-a'),
      win('fam-a', NOW - 3 * DAY_MS, 'NO'),
      win('fam-a', NOW - DAY_MS, 'YES'),
      win('fam-a', NOW - 2 * DAY_MS, 'VOID', { evidence: { reason: 'no_archive_evidence' } }),
      open('fam-b', { status: 'pending-judge' }),
      win('fam-b', NOW - DAY_MS, 'VOID', { evidence: { reason: 'raw internal reason' } }),
    ];
    assert.deepEqual(buildFamilyOutcomes(ledger, NOW), [
      { forecastId: 'fam-a', outcome: 'YES' },
      { forecastId: 'fam-a', outcome: 'VOID', voidReason: 'no_archive_evidence' },
      { forecastId: 'fam-a', outcome: 'NO' },
      { forecastId: 'fam-b', outcome: 'VOID', voidReason: 'other' },
    ]);
  });

  it('keeps out families with no open window, unpublished origins, horizon children and windows outside the rolling window', () => {
    const ledger = [
      win('closed', NOW - DAY_MS, 'YES'),
      open('shadow', { generationOrigin: 'bet_engine' }),
      win('shadow', NOW - DAY_MS, 'YES', { generationOrigin: 'bet_engine' }),
      open('synthetic', { generationOrigin: 'state_derived' }),
      win('synthetic', NOW - DAY_MS, 'NO', { generationOrigin: 'state_derived' }),
      open('fam'),
      win('fam', NOW - DAY_MS, 'YES', { parentKey: 'fam@x', spec: { horizon: '24h' } }),
      win('fam', NOW - (DEFAULT_ROLLING_WINDOW_DAYS + 1) * DAY_MS, 'NO'),
    ];
    assert.deepEqual(buildFamilyOutcomes(ledger, NOW), []);
  });

  it(`caps each family at ${5} windows`, () => {
    assert.equal(FAMILY_OUTCOME_LIMIT, 5);
    assert.deepEqual([...PUBLIC_FAMILY_OUTCOME_FIELDS], ['forecastId', 'outcome', 'voidReason']);
    const ledger = [open('fam'), ...Array.from({ length: 8 }, (_, i) => win('fam', NOW - (i + 1) * DAY_MS, 'NO'))];
    assert.equal(buildFamilyOutcomes(ledger, NOW).length, 5);
  });
});
