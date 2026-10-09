import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DEFAULT_JUDGED_SLA_MS,
  RESOLVER_CYCLE_MS,
  hardSlaMs,
  slaDueAt,
  DEFAULT_ROLLING_WINDOW_DAYS,
  DEFAULT_SKILL_EXCLUDED_ORIGINS,
  MARKET_SETTLEMENT_FEED,
  SKILL_MIN_FAMILIES,
  SKILL_MIN_OUTCOME_FAMILIES,
  PUBLIC_RECEIPT_FIELDS,
  PUBLIC_RECEIPT_LINKS_SINCE_MS,
  PUBLIC_RECEIPT_LIMIT,
  RECEIPT_SOURCE_FEEDS,
  RECEIPT_SOURCE_LABELS,
  RECEIPT_VOID_REASON_LABELS,
  FAMILY_OUTCOME_FAMILY_LIMIT,
  GO_FORWARD_SINCE,
  GO_FORWARD_MIN_RESOLVED,
  GO_FORWARD_SINCE_MS,
  GO_FORWARD_VOID_SHARE_TARGET,
  FAMILY_OUTCOME_LIMIT,
  PUBLIC_FAMILY_OUTCOME_FIELDS,
  buildFamilyOutcomes,
  buildPublicReceipts,
  computeScorecard,
  hasPreLineageAnchor,
  isWithheldEntry,
  wilsonInterval,
} from '../scripts/_forecast-scorecard.mjs';
import { PROJECTION_HORIZONS } from '../scripts/_forecast-resolution.mjs';
import { selectFitCohort } from '../scripts/_forecast-calibration.mjs';
import { MARKET_SETTLEMENT_FEED as BET_SETTLEMENT_FEED } from '../scripts/_bet-templates-markets.mjs';

const NOW = Date.parse('2026-07-20T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const round6 = (value) => Math.round(value * 1_000_000) / 1_000_000;

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
        calibration: { marketPrice: 60, internalProbability: 0.93, marketBlendedProbability: 0.8 },
      }),
      b: resolved({
        probability: 0.4,
        outcome: 'NO',
        calibration: { marketPrice: 70, internalProbability: 0.2, marketBlendedProbability: 0.4 },
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
      d: resolved({ probability: 0.2, outcome: 'NO', generationOrigin: 'bet_engine', probabilitySource: 'ensemble' }),
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
      d: resolved({ probability: 0.1, outcome: 'YES', domain: 'market', generationOrigin: 'bet_engine', probabilitySource: 'ensemble' }),
      e: resolved({ probability: 0.1, outcome: 'YES', domain: 'market', generationOrigin: 'state_derived' }),
      f: absent,
      g: resolved({ probability: 0.5, outcome: 'VOID', domain: 'market', generationOrigin: 'detector' }),
      h: resolved({ probability: 0.9, outcome: 'NO', domain: 'cyber', generationOrigin: 'bet_engine', probabilitySource: 'ensemble' }),
    }, NOW, { promoteBetEngine: true });

    assert.equal(scorecard.schemaVersion, 2, 'schema 2 marks a seed that carries publishedByDomain');
    assert.deepEqual(scorecard.publishedByDomain, [
      { domain: 'conflict', count: 1, brier: 0.09, yesCount: 0, families: 1, nEff: 1, yesFamilies: 0, noFamilies: 1, referenceBrier: 0, measurable: false },
      { domain: 'market', count: 2, brier: 0.1, yesCount: 1, families: 1, nEff: 1, yesFamilies: 1, noFamilies: 1, referenceBrier: 0.25, measurable: false },
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

describe('market comparisons read only anchors that price the forecast question (#8990, #7071)', () => {
  const preLineage = (overrides) => resolved({
    title: 'Escalation risk: Ukraine',
    calibration: { marketTitle: 'Will Ukraine agree to cede territory to Russia before 2027?', marketPrice: 0.105, drift: 0.283, source: 'polymarket' },
    ...overrides,
  });
  const lineage = (overrides) => resolved({
    title: 'Escalation risk: Iran',
    calibration: { marketTitle: 'Will the U.S. strike Iran by October 20?', marketPrice: 0.3, drift: 0.05, source: 'polymarket', internalProbability: 0.35, marketBlendedProbability: 0.33 },
    ...overrides,
  });
  const marketBet = (overrides) => resolved({
    generationOrigin: 'bet_engine',
    probabilitySource: 'ensemble',
    spec: { kind: 'hard', sourceFeed: BET_SETTLEMENT_FEED },
    calibration: { marketPrice: 13.5, source: 'polymarket' },
    ...overrides,
  });

  it('leaves an anchor the pre-#7071 matcher chose out of vsMarketSkill', () => {
    const scorecard = computeScorecard({
      stale: preLineage({ probability: 0.388, outcome: 'YES' }),
      matched: lineage({ probability: 0.33, outcome: 'NO' }),
      bet: marketBet({ probability: 0.2, outcome: 'NO' }),
    }, NOW);
    assert.equal(scorecard.vsMarketSkill.count, 2);
    assert.equal(scorecard.vsMarketSkill.forecastBrier, round6((0.33 ** 2 + 0.2 ** 2) / 2));
    assert.equal(scorecard.vsMarketSkill.marketBrier, round6((0.3 ** 2 + 0.135 ** 2) / 2));
  });

  it('omits vsMarketSkill when every anchor predates lineage', () => {
    const scorecard = computeScorecard({ stale: preLineage({ probability: 0.388, outcome: 'YES' }) }, NOW);
    assert.ok(!Object.hasOwn(scorecard, 'vsMarketSkill'));
  });

  it('keeps scoring the published probability of a row blended toward a stale anchor', () => {
    const scorecard = computeScorecard({
      stale: preLineage({ probability: 0.388, outcome: 'YES' }),
      clean: resolved({ probability: 0.2, outcome: 'NO' }),
    }, NOW);
    assert.equal(scorecard.skill.count, 2);
    assert.equal(scorecard.skill.brier, round6(((1 - 0.388) ** 2 + 0.2 ** 2) / 2));
  });

  it('leaves a bet anchor that does not settle on the market out of the bet_engine market and deviation skill', () => {
    const scorecard = computeScorecard({
      bet: marketBet({ probability: 0.75, outcome: 'YES', calibration: { marketPrice: 60 } }),
      titled: marketBet({
        probability: 0.75,
        outcome: 'NO',
        spec: { kind: 'judged' },
        calibration: { marketTitle: 'Will the U.S. invade Iran before 2027?', marketPrice: 0.2, source: 'polymarket' },
      }),
    }, NOW);
    assert.equal(scorecard.betEngine.ensembleCount, 2);
    assert.equal(scorecard.betEngine.vsMarketSkill.count, 1);
    assert.equal(scorecard.betEngine.deviationSkill.count, 1);
    assert.equal(scorecard.betEngine.deviationSkill.skill, 0.4);
  });

  it('names the same settlement feed the market bet templates write', () => {
    assert.equal(MARKET_SETTLEMENT_FEED, BET_SETTLEMENT_FEED);
    assert.ok(hasPreLineageAnchor(preLineage()));
    assert.ok(!hasPreLineageAnchor(lineage()));
    assert.ok(!hasPreLineageAnchor(marketBet()));
    assert.ok(!hasPreLineageAnchor(resolved({})));
  });

  it('counts headline rows blended toward a pre-#7071 anchor (#9010)', () => {
    const scorecard = computeScorecard({
      stale: preLineage({ probability: 0.388, outcome: 'YES' }),
      staleExcluded: preLineage({ generationOrigin: 'state_derived', probability: 0.4, outcome: 'NO' }),
      matched: lineage({ probability: 0.33, outcome: 'NO' }),
      bet: marketBet({ probability: 0.2, outcome: 'NO' }),
      clean: resolved({ probability: 0.2, outcome: 'NO' }),
    }, NOW);
    assert.equal(scorecard.skill.count, 3);
    assert.equal(scorecard.skill.preLineageAnchorCount, 1);
    const none = computeScorecard({ clean: resolved({ probability: 0.2, outcome: 'NO' }) }, NOW);
    assert.equal(none.skill.preLineageAnchorCount, 0);
  });

  it('treats a null or blank blend as missing lineage', () => {
    for (const marketBlendedProbability of [null, '', '0.33']) {
      const entry = lineage({ calibration: { ...lineage().calibration, marketBlendedProbability } });
      assert.ok(hasPreLineageAnchor(entry), JSON.stringify(marketBlendedProbability));
    }
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

  it('bootstraps mean Brier by family, deterministically', () => {
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
    assert.equal(overallBrier.insufficientSample, false, '40 distinct families clear the minimum');
    assert.equal(skillBrier.count, 30, 'the headline interval covers the headline cohort, not every scored entry');
    assert.equal(skillBrier.mean, a.skill.brier);
    assert.equal(skillBrier.insufficientSample, false, '30 distinct families meet the minimum');
  });

  it('flags a sample by its families, not its rows (#8990)', () => {
    const ledger = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [
      `r${i}`,
      resolved({ id: `fam-${i % 10}`, probability: 0.3, outcome: i % 4 === 0 ? 'YES' : 'NO' }),
    ]));
    const { skillBrier } = computeScorecard(ledger, NOW).uncertainty;
    assert.equal(skillBrier.count, 60);
    assert.equal(skillBrier.insufficientSample, true, '60 rows from 10 families are a small sample');
    const oneWay = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`o${i}`, resolved({ id: `fam-${i}`, probability: 0.3, outcome: i < 4 ? 'YES' : 'NO' })]));
    const flag = computeScorecard(oneWay, NOW).uncertainty.skillBrier.insufficientSample;
    assert.equal(flag, true, '40 families with 4 YES families miss the outcome minimum; the flag carries the whole rule');
  });

  it('flags a small sample and emits no estimate for an empty one', () => {
    const small = computeScorecard({ a: resolved({ probability: 0.8, outcome: 'YES', generationOrigin: 'state_derived' }) }, NOW);
    assert.equal(small.uncertainty.overallBrier.count, 1);
    assert.equal(small.uncertainty.overallBrier.insufficientSample, true);
    assert.equal(small.uncertainty.skillBrier, null, 'an empty headline cohort has no estimate');

    const empty = computeScorecard({ a: resolved({ outcome: 'VOID' }) }, NOW);
    assert.deepEqual(empty.uncertainty, {
      method: empty.uncertainty.method,
      overallBrier: null,
      skillBrier: null,
      overallLogScore: null,
      skillLogScore: null,
      byDomain: [],
      byGenerationOrigin: [],
      vsMarket: null,
    });
    assert.ok(!JSON.stringify(empty).includes('NaN'));
  });
});

describe('group, log-score and market intervals (#7072)', () => {
  const ledger = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`e${i}`, resolved({
    id: `fam-${i % 40}`,
    domain: i % 2 ? 'market' : 'conflict',
    generationOrigin: i < 60 ? 'detector' : 'state_derived',
    probability: ((i * 7) % 10) / 10 + 0.05,
    outcome: i % 3 === 0 ? 'YES' : 'NO',
    // Every fourth window carries a lineage-backed market anchor.
    ...(i % 4 === 0 && { calibration: { marketPrice: 0.5, marketBlendedProbability: 0.5 } }),
  })]));
  const scorecard = computeScorecard(ledger, NOW);
  const { uncertainty } = scorecard;
  const brackets = ({ mean, ci95 }) => ci95[0] <= mean && mean <= ci95[1];

  it('bootstraps Brier and log score for every domain and origin, matching the point estimates', () => {
    assert.deepEqual(uncertainty.byDomain.map((row) => row.domain), scorecard.byDomain.map((row) => row.domain));
    assert.deepEqual(uncertainty.byGenerationOrigin.map((row) => row.generationOrigin), ['detector', 'state_derived']);
    for (const [rows, published, key] of [[uncertainty.byDomain, scorecard.byDomain, 'domain'], [uncertainty.byGenerationOrigin, scorecard.byGenerationOrigin, 'generationOrigin']]) {
      for (const row of rows) {
        const point = published.find((group) => group[key] === row[key]);
        assert.equal(row.count, point.scored);
        assert.equal(row.brier.mean, point.brier);
        assert.equal(row.logScore.mean, point.logScore);
        assert.ok(brackets(row.brier) && brackets(row.logScore), `${row[key]} intervals bracket the estimate`);
        assert.ok(row.brier.ci95[1] > row.brier.ci95[0]);
      }
    }
  });

  it('flags a group by its families: 20 families per domain miss the minimum of 30', () => {
    assert.deepEqual(uncertainty.byDomain.map((row) => [row.domain, row.families, row.insufficientSample]), [['conflict', 20, true], ['market', 20, true]]);
  });

  it('bootstraps the overall and headline log score', () => {
    assert.equal(uncertainty.overallLogScore.mean, scorecard.overall.logScore);
    assert.equal(uncertainty.skillLogScore.mean, scorecard.skill.logScore);
    assert.equal(uncertainty.skillLogScore.count, scorecard.skill.count);
    assert.ok(brackets(uncertainty.overallLogScore));
  });

  it('pairs WM minus market Brier on the published-origin cohort, holding out state_derived', () => {
    const { vsMarket } = uncertainty;
    // Anchors at i = 0, 4, ..., 56 are detector rows; 60..76 are state_derived.
    assert.equal(vsMarket.cohort, 'published_origin');
    assert.equal(vsMarket.count, 15);
    assert.equal(scorecard.vsMarketSkill.count, 20, 'the public block still pools every origin');
    assert.equal(vsMarket.wmMinusMarketBrier.mean, round6(vsMarket.forecastBrier - vsMarket.marketBrier));
    assert.ok(brackets(vsMarket.wmMinusMarketBrier));
    assert.equal(vsMarket.insufficientSample, true);
  });

  it('resamples the market comparison by family, so repeating every window leaves the interval unchanged', () => {
    const doubled = { ...ledger, ...Object.fromEntries(Object.entries(ledger).map(([key, entry]) => [`${key}-again`, entry])) };
    const again = computeScorecard(doubled, NOW).uncertainty.vsMarket;
    assert.equal(again.count, 2 * uncertainty.vsMarket.count);
    assert.deepEqual(again.wmMinusMarketBrier, uncertainty.vsMarket.wmMinusMarketBrier);
  });

  it('reproduces every interval on a rerun and keeps the public members unchanged', () => {
    assert.deepEqual(computeScorecard(ledger, NOW).uncertainty, uncertainty);
    const { overallBrier, skillBrier } = uncertainty;
    assert.deepEqual(Object.keys(overallBrier), ['count', 'mean', 'ci95', 'insufficientSample']);
    assert.deepEqual(Object.keys(skillBrier), ['count', 'mean', 'ci95', 'insufficientSample']);
  });
});

describe('evaluation corpus: SLA, VOID by reason and latency across both lanes (#7072)', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const at = (offsetDays) => NOW + offsetDays * DAY_MS;
  const judged = { kind: 'judged' };
  // A live point read: due 1 day 1 hour after the deadline, sealed by the next run.
  const LIVE = { kind: 'hard', metricKey: 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)', window: 'at-deadline', threshold: 50 };
  // Monthly FRED publishes weeks after its month ends.
  const FRED_MONTHLY = { kind: 'hard', metricKey: 'economic:fred:v1:CPIAUCSL:0|value(series==CPIAUCSL)', window: 'at-deadline', threshold: 3 };
  const live = (overrides) => resolved({ spec: LIVE, ...overrides });
  const ledger = {
    hardOnTime: live({ id: 'h1', deadline: at(-5), resolvedAt: at(-4.5) }),
    hardLate: live({ id: 'h2', outcome: 'NO', probability: 0.2, deadline: at(-10), resolvedAt: at(-7) }),
    hardVoid: live({ id: 'h3', outcome: 'VOID', deadline: at(-6), resolvedAt: at(-5), evidence: { reason: 'feed_unavailable' } }),
    // Within the 5-day level stamped when it opened, late under its feed's own.
    hardStamped: live({ id: 'h4', deadline: at(-10), resolvedAt: at(-6), sla: { lane: 'hard', ms: 5 * DAY_MS } }),
    // A stamp from the other lane does not apply.
    hardForeignStamp: live({ id: 'h5', deadline: at(-20), resolvedAt: at(-17), sla: { lane: 'judged', ms: 5 * DAY_MS } }),
    // 50 days after its deadline is on time for a monthly FRED read.
    fredOnTime: resolved({ id: 'h6', spec: FRED_MONTHLY, deadline: at(-60), resolvedAt: at(-10) }),
    fredWaiting: { id: 'h7', generationOrigin: 'detector', status: 'pending', spec: FRED_MONTHLY, deadline: at(-30) },
    hardUndated: resolved({ id: 'h8' }),
    hardPendingPast: { id: 'h9', generationOrigin: 'detector', status: 'pending', spec: LIVE, deadline: at(-3) },
    hardPendingDue: { id: 'h10', generationOrigin: 'detector', status: 'pending', spec: LIVE, deadline: at(-1) },
    hardImmature: { id: 'h11', generationOrigin: 'detector', status: 'pending', spec: LIVE, deadline: at(1) },
    // 54h after the deadline: inside 18h + 2 days, outside 2 days alone.
    judgedOnTime: resolved({ id: 'j1', spec: judged, deadline: at(-4), resolvedAt: at(-4) + 54 * HOUR_MS }),
    judgedLateVoid: resolved({ id: 'j2', spec: judged, outcome: 'VOID', deadline: at(-6), resolvedAt: at(-6) + 18 * HOUR_MS + 3 * DAY_MS, evidence: { kind: 'judged', reason: 'all_judges_void' } }),
    judgedPendingPast: { id: 'j3', generationOrigin: 'detector', status: 'pending-judge', spec: { ...judged, deadline: at(-4) } },
    // Due 6h from now with the grace, 12h ago without it.
    judgedPendingInGrace: { id: 'j4', generationOrigin: 'detector', status: 'pending-judge', spec: { ...judged, deadline: at(-2.5) } },
    // A late shadow bet stays out of the published counts.
    shadowLate: live({ id: 'b1', generationOrigin: 'bet_engine', outcome: 'VOID', deadline: at(-10), resolvedAt: at(-2), evidence: { reason: 'late_read' } }),
  };

  it('holds each hard window to its own feed\'s settlement bound plus one resolver cycle', () => {
    const CYCLE = DAY_MS + HOUR_MS;
    const spec = (metricKey, window = 'at-deadline') => ({ kind: 'hard', metricKey, window, threshold: 1 });
    assert.equal(RESOLVER_CYCLE_MS, CYCLE, 'one daily run plus an hour of start jitter');
    assert.equal(hardSlaMs(LIVE), 2 * CYCLE);
    assert.equal(hardSlaMs(FRED_MONTHLY), 75 * DAY_MS + CYCLE);
    assert.equal(hardSlaMs(spec('energy:eia-petroleum:v1|value(series==WCRSTUS1)')), 14 * DAY_MS + CYCLE);
    assert.equal(hardSlaMs(spec('prediction:markets-resolution:v1|yesPrice(slug==x)', 'at-endDate')), 14 * DAY_MS + CYCLE);
    assert.equal(hardSlaMs(spec('intelligence:gpsjam:v2|hexCount(region==x)')), 3 * DAY_MS + 7 * HOUR_MS + CYCLE);
    assert.equal(hardSlaMs(spec('conflict:ucdp-events:v1|count(country==Syria)', 'within-horizon')), 24 * DAY_MS + CYCLE);
    assert.equal(hardSlaMs(spec('conflict:ucdp-events:v1|count(country==Syria)')), 2 * CYCLE, 'an at-deadline count on a live feed takes the live-read VOID first');
    assert.equal(hardSlaMs(undefined), CYCLE, 'an unreadable spec VOIDs on the first run');
    assert.equal(hardSlaMs({ ...LIVE, window: 'within-horizon' }), CYCLE, 'a within-horizon read resolves on the first run');
    assert.equal(hardSlaMs({ ...LIVE, window: 'rolling' }), CYCLE, 'an unsupported window VOIDs on the first run');
    assert.equal(hardSlaMs({ ...LIVE, threshold: undefined }), CYCLE, 'a missing threshold VOIDs on the first run');
  });

  it('counts a window sealed by a run that started a few minutes late as on time', () => {
    const within = { ...LIVE, window: 'within-horizon' };
    const entry = resolved({ id: 'w1', spec: within, deadline: at(-3), resolvedAt: at(-3) + DAY_MS + 3 * 60 * 1000 });
    assert.equal(computeScorecard({ entry }, NOW).corpus.byLane.hard.resolvedWithinSlaCount, 1);
    assert.equal(slaDueAt(entry), at(-3) + RESOLVER_CYCLE_MS);
  });

  it('counts terminal states inside and outside the service level in each lane, published origins only', () => {
    const { corpus } = computeScorecard(ledger, NOW);
    assert.equal(corpus.cohort, 'published_origin');
    assert.equal(corpus.judgedSlaMs, 2 * DAY_MS);
    const { latency: hardLatency, ...hard } = corpus.byLane.hard;
    const { latency: judgedLatency, ...judgedLane } = corpus.byLane.judged;
    assert.deepEqual(hard, { resolved: 7, resolvedWithinSlaCount: 4, scoredWithinSlaCount: 3, voidWithinSlaCount: 1, resolvedLateCount: 2, slaUnmeasurable: 1, pendingPastSlaCount: 1 });
    assert.deepEqual(judgedLane, { resolved: 2, resolvedWithinSlaCount: 1, scoredWithinSlaCount: 1, voidWithinSlaCount: 0, resolvedLateCount: 1, slaUnmeasurable: 0, pendingPastSlaCount: 1 });
    assert.equal(corpus.resolvedCount, 9);
    assert.equal(corpus.resolvedWithinSlaCount, 5);
    assert.equal(corpus.scoredWithinSlaCount, 4);
    assert.equal(corpus.voidWithinSlaCount, 1);
    assert.equal(corpus.resolvedLateCount, 3);
    assert.equal(corpus.slaUnmeasurable, 1);
    assert.equal(corpus.pendingPastSlaCount, 2);
    assert.deepEqual(hardLatency, { count: 6, medianMs: 3 * DAY_MS, p90Ms: 50 * DAY_MS }, '0.5d, 1d, 3d, 3d, 4d, 50d');
    assert.deepEqual(judgedLatency, { count: 2, medianMs: 54 * HOUR_MS, p90Ms: 90 * HOUR_MS });
  });

  it('repeats the counts per origin, so a shadow bet never mixes into the published figures', () => {
    const { corpus, totals } = computeScorecard(ledger, NOW);
    assert.deepEqual(corpus.byGenerationOrigin.map((row) => row.generationOrigin), ['bet_engine', 'detector']);
    const [bets, detector] = corpus.byGenerationOrigin;
    assert.equal(bets.resolvedCount, 1);
    assert.equal(bets.resolvedLateCount, 1);
    assert.deepEqual(bets.voidByReason, { late_read: 1 });
    const { generationOrigin: _origin, ...detectorCounts } = detector;
    const { resolvedCount, resolvedWithinSlaCount, scoredWithinSlaCount, voidWithinSlaCount, resolvedLateCount, slaUnmeasurable, pendingPastSlaCount, voidByReason, byLane } = corpus;
    assert.deepEqual(detectorCounts, { resolvedCount, resolvedWithinSlaCount, scoredWithinSlaCount, voidWithinSlaCount, resolvedLateCount, slaUnmeasurable, pendingPastSlaCount, voidByReason, byLane });
    assert.equal(corpus.byGenerationOrigin.reduce((sum, row) => sum + row.resolvedCount, 0), totals.resolved, 'every resolved window is in one origin');
  });

  it('reports VOID by reason across both lanes, keys sorted', () => {
    const { corpus, judgedLane } = computeScorecard(ledger, NOW);
    assert.deepEqual(Object.entries(corpus.voidByReason), [['all_judges_void', 1], ['feed_unavailable', 1]]);
    assert.deepEqual(judgedLane.voidByReason, { all_judges_void: 1 }, 'the judged lane alone misses the hard VOID');
  });

  it('leaves the registration counts null when no history was read, and carries them when the seeder passes them', () => {
    const bare = computeScorecard(ledger, NOW).corpus;
    assert.equal(bare.publishedCount, null);
    assert.equal(bare.ledgerRegisteredCount, null);
    assert.equal(bare.registrationCoverage, null);
    assert.ok(!Object.hasOwn(bare, 'unregisteredByReason'));
    const registration = {
      publishedCount: 4, ledgerRegisteredCount: 3, registrationCoverage: 0.75, registeredLedgerWindows: 2,
      unregisteredByReason: { no_resolution_spec: 1 }, historySnapshots: 2, historyFrom: at(-2), historyTo: at(-1),
    };
    const { corpus } = computeScorecard(ledger, NOW, { registration });
    for (const [field, value] of Object.entries(registration)) assert.deepEqual(corpus[field], value, field);
  });

  it('stays deterministic and never NaN', () => {
    assert.equal(JSON.stringify(computeScorecard(ledger, NOW).corpus), JSON.stringify(computeScorecard(ledger, NOW).corpus));
    assert.ok(!JSON.stringify(computeScorecard({}, NOW).corpus).includes('NaN'));
  });

  it('documents the service levels and corpus fields in both languages', () => {
    assert.equal(RESOLVER_CYCLE_MS, DAY_MS + 60 * 60 * 1000, 'the docs say one daily run plus an hour');
    assert.equal(DEFAULT_JUDGED_SLA_MS, 2 * DAY_MS, 'the docs say 2 days');
    for (const path of ['docs/panels/forecast.mdx', 'docs/zh/panels/forecast.mdx']) {
      const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      for (const term of ['hardResolutionBoundMs', 'RESOLVER_CYCLE_MS', 'DEFAULT_JUDGED_SLA_MS', 'scoredWithinSlaCount', 'voidWithinSlaCount', 'byGenerationOrigin', 'registrationCoverage', 'resolvedWithinSlaCount', 'voidByReason', 'emissionHash', 'receiptHash', 'emission_snapshot_required', 'wmMinusMarketBrier', 'skillLogScore', 'slaScope', 'registrationScope', '| 76 ', '| 15 ']) {
        assert.ok(text.includes(term), `${path} names ${term}`);
      }
    }
  });
});

describe('Phase-2 betEngine slice + promotion flag (#5525 U14)', () => {
  function betEngineEntry(overrides) {
    return resolved({
      generationOrigin: 'bet_engine',
      probabilitySource: 'ensemble',
      spec: { kind: 'hard', sourceFeed: BET_SETTLEMENT_FEED },
      ...overrides,
    });
  }

  it('leaves windows that opened on the base-rate placeholder out of every count (#8990)', () => {
    const scorecard = computeScorecard({
      a: betEngineEntry({ probability: 0.8, outcome: 'YES', baselineProbability: 0.4, calibration: { marketPrice: 60 } }),
      b: betEngineEntry({ probability: 0.4, outcome: 'NO', baselineProbability: 0.4, probabilitySource: 'base_rate', calibration: { marketPrice: 70 } }),
      c: betEngineEntry({ probability: 0.3, outcome: 'NO', baselineProbability: 0.4, probabilitySource: undefined, calibration: { marketPrice: 70 } }),
      d: betEngineEntry({ probability: 0.2, outcome: 'NO', baselineProbability: 0.4, probabilitySource: 'ensemble_partial', calibration: { marketPrice: 70 } }),
    }, NOW);
    assert.equal(scorecard.betEngine.count, 2, 'a placeholder window was never a question');
    assert.equal(scorecard.totals.entries, 2);
    assert.equal(scorecard.betEngine.ensembleCount, 2);
    assert.equal(scorecard.betEngine.vsBaseRate.count, 2);
    assert.equal(scorecard.betEngine.vsMarketSkill.count, 2);
    assert.equal(scorecard.betEngine.deviationSkill.count, 2);
  });

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
    assert.equal(scorecard.projections.minSample, SKILL_MIN_FAMILIES);
    assert.deepEqual(scorecard.projections.byHorizon, [
      { horizon: 'h24', registered: 1, matured: 0, resolved: 0, scored: 0, families: 0, yes: 0, no: 0, unobserved: 0, void: 0, realizedRate: null, brier: null, insufficientSample: true },
      { horizon: 'd7', registered: 4, matured: 4, resolved: 4, scored: 2, families: 1, yes: 1, no: 1, unobserved: 1, void: 1, realizedRate: { count: 2, successes: 1, rate: 0.5, ci95: wilsonInterval(1, 2) }, brier: null, insufficientSample: true },
      { horizon: 'd30', registered: 1, matured: 1, resolved: 0, scored: 0, families: 0, yes: 0, no: 0, unobserved: 0, void: 0, realizedRate: null, brier: null, insufficientSample: true },
    ]);
  });

  it('reports the realized rate with a Wilson interval over scored windows only, beside the family count', () => {
    const ledger = {
      y1: horizonRow('d30', { id: 'fc-a', key: 'fc-a@1@d30', outcome: 'YES' }),
      y2: horizonRow('d30', { id: 'fc-a', key: 'fc-a@2@d30', outcome: 'YES' }),
      y3: horizonRow('d30', { id: 'fc-b', key: 'fc-b@1@d30', outcome: 'YES' }),
      n1: horizonRow('d30', { id: 'fc-c', key: 'fc-c@1@d30', outcome: 'NO' }),
      u1: horizonRow('d30', { id: 'fc-d', key: 'fc-d@1@d30', outcome: 'UNOBSERVED' }),
      v1: horizonRow('d30', { id: 'fc-e', key: 'fc-e@1@d30', outcome: 'VOID' }),
    };
    const d30 = computeScorecard(ledger, NOW).projections.byHorizon.find((row) => row.horizon === 'd30');
    assert.equal(d30.scored, 4);
    assert.equal(d30.families, 3, 'two windows of fc-a are one family');
    assert.deepEqual(d30.realizedRate, { count: 4, successes: 3, rate: 0.75, ci95: wilsonInterval(3, 4) });
    assert.ok(d30.realizedRate.ci95[0] < 0.75 && d30.realizedRate.ci95[1] > 0.75);
  });

  it('slices every horizon by domain, never pooling one domain into another', () => {
    const ledger = {
      s1: horizonRow('d7', { id: 'fc-s', key: 'fc-s@1@d7', domain: 'supply_chain', outcome: 'YES' }),
      s2: horizonRow('h24', { id: 'fc-s', key: 'fc-s@1@h24', domain: 'supply_chain', outcome: 'NO' }),
      c1: horizonRow('d7', { id: 'fc-c', key: 'fc-c@1@d7', domain: 'conflict', outcome: 'NO' }),
      c2: horizonRow('d7', { id: 'fc-c2', key: 'fc-c2@1@d7', domain: 'conflict', outcome: 'UNOBSERVED' }),
    };
    const { byDomain, byHorizon } = computeScorecard(ledger, NOW).projections;
    assert.deepEqual(byDomain.map((slice) => slice.domain), ['conflict', 'supply_chain']);
    const cell = (domain, horizon) => byDomain.find((slice) => slice.domain === domain).byHorizon.find((row) => row.horizon === horizon);
    assert.deepEqual(byDomain[0].byHorizon.map((row) => row.horizon), Object.keys(PROJECTION_HORIZONS));
    assert.deepEqual([cell('conflict', 'd7').registered, cell('conflict', 'd7').scored, cell('conflict', 'd7').yes, cell('conflict', 'd7').unobserved], [2, 1, 0, 1]);
    assert.deepEqual([cell('supply_chain', 'd7').scored, cell('supply_chain', 'd7').yes], [1, 1]);
    assert.deepEqual([cell('supply_chain', 'h24').scored, cell('supply_chain', 'h24').no], [1, 1]);
    assert.equal(cell('conflict', 'h24').registered, 0);
    assert.equal(byHorizon.find((row) => row.horizon === 'd7').registered, 3, 'the pooled row still counts every domain');
  });

  it('reports each projection-curve version apart, with unstamped windows in their own slice', () => {
    const ledger = {
      a: horizonRow('d7', { id: 'fc-a', key: 'fc-a@1@d7', projectionCurvesVersion: 1, outcome: 'YES' }),
      b: horizonRow('d7', { id: 'fc-b', key: 'fc-b@1@d7', projectionCurvesVersion: 2, outcome: 'NO' }),
      c: horizonRow('d7', { id: 'fc-c', key: 'fc-c@1@d7', projectionCurvesVersion: 2, outcome: 'NO' }),
      d: horizonRow('d7', { id: 'fc-d', key: 'fc-d@1@d7', outcome: 'YES' }),
    };
    const { byCurvesVersion } = computeScorecard(ledger, NOW).projections;
    assert.deepEqual(byCurvesVersion.map((slice) => slice.curvesVersion), [null, 1, 2]);
    const d7 = (version) => byCurvesVersion.find((slice) => slice.curvesVersion === version).byHorizon.find((row) => row.horizon === 'd7');
    assert.deepEqual([d7(null).scored, d7(null).yes], [1, 1]);
    assert.deepEqual([d7(1).scored, d7(1).yes], [1, 1]);
    assert.deepEqual([d7(2).scored, d7(2).no], [2, 2]);
  });

  it('no forecast reader takes parent lineage from a horizon row (#7075 review 2)', () => {
    const parent = (overrides) => resolved({
      generationOrigin: 'legacy_detector',
      calibration: { marketPrice: 0.4, internalProbability: 0.5, marketBlendedProbability: 0.45, marketTitle: 'Hormuz closure', source: 'polymarket' },
      baselineProbability: 0.3,
      probabilitySource: 'ensemble',
      marketSlug: 'hormuz-closure',
      ...overrides,
    });
    const forecasts = {
      a: parent({ id: 'fc-a', key: 'fc-a@1', probability: 0.8, outcome: 'YES' }),
      b: parent({ id: 'fc-b', key: 'fc-b@1', probability: 0.3, outcome: 'NO' }),
      // An open window of the horizon row's forecast, so its family is listed.
      open: parent({ id: 'fc-h', key: 'fc-h@2', status: 'pending', outcome: undefined, resolvedAt: undefined, lastSeenAt: NOW - DAY_MS }),
    };
    const withHorizon = {
      ...forecasts,
      h: horizonRow('d7', {
        generationOrigin: 'legacy_detector',
        calibration: { marketPrice: 0.99, internalProbability: 0.5, marketBlendedProbability: 0.9, marketTitle: 'Hormuz closure', source: 'polymarket' },
        baselineProbability: 0.99,
        probabilitySource: 'ensemble',
        marketSlug: 'hormuz-closure',
        probability: 0.1,
        outcome: 'YES',
        title: 'Hormuz disruption risk rises',
        generatedAt: NOW - 9 * DAY_MS,
      }),
    };
    assert.equal(buildPublicReceipts({ h: { ...withHorizon.h, spec: { ...withHorizon.h.spec, horizon: undefined } } }, NOW).length, 1, 'the fixture is receipt-shaped');
    const strip = ({ generatedAt: _g, projections: _p, ...rest }) => rest;
    assert.deepEqual(strip(computeScorecard(withHorizon, NOW)), strip(computeScorecard(forecasts, NOW)));
    assert.deepEqual(buildPublicReceipts(withHorizon, NOW), buildPublicReceipts(forecasts, NOW));
    assert.deepEqual(buildFamilyOutcomes(withHorizon, NOW), buildFamilyOutcomes(forecasts, NOW));
    assert.deepEqual(selectFitCohort(withHorizon, NOW), selectFitCohort(forecasts, NOW));
  });

  it('reports no slices on an empty ledger', () => {
    const { byDomain, byCurvesVersion } = computeScorecard({}, NOW).projections;
    assert.deepEqual(byDomain, []);
    assert.deepEqual(byCurvesVersion, []);
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

    const below = d7(SKILL_MIN_FAMILIES - 1);
    assert.equal(below.scored, SKILL_MIN_FAMILIES - 1);
    assert.equal(below.brier, null);
    assert.equal(below.insufficientSample, true);

    const at = d7(SKILL_MIN_FAMILIES);
    assert.equal(at.insufficientSample, false);
    assert.equal(at.brier.count, SKILL_MIN_FAMILIES);
    assert.equal(at.brier.mean, 0.25);
    assert.ok(at.brier.ci95);
  });

  it('counts a horizon sample in families, so repeated windows of one forecast do not unlock its Brier (#8990)', () => {
    const ledger = Object.fromEntries(Array.from({ length: 2 * SKILL_MIN_FAMILIES }, (_, i) => [
      `h${i}`,
      horizonRow('d7', { id: `fc-${i % 3}`, key: `fc-${i % 3}@${i}@d7`, probability: 0.5, outcome: i % 2 ? 'YES' : 'NO' }),
    ]));
    const d7 = computeScorecard(ledger, NOW).projections.byHorizon.find((row) => row.horizon === 'd7');
    assert.equal(d7.scored, 2 * SKILL_MIN_FAMILIES);
    assert.equal(d7.brier, null);
    assert.equal(d7.insufficientSample, true);
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

  it('puts the later window first when one cycle resolves two windows at the same instant', () => {
    const at = NOW - DAY_MS;
    const ledger = [
      open('fam'),
      { ...win('fam', at, 'NO'), key: 'fam@1', deadline: NOW - 3 * DAY_MS },
      { ...win('fam', at, 'YES'), key: 'fam@2', deadline: NOW - 2 * DAY_MS },
    ];
    assert.deepEqual(buildFamilyOutcomes(ledger, NOW).map((row) => row.outcome), ['YES', 'NO']);
  });

  it('keeps the five newest windows of a family, newest first', () => {
    assert.equal(FAMILY_OUTCOME_LIMIT, 5);
    assert.deepEqual([...PUBLIC_FAMILY_OUTCOME_FIELDS], ['forecastId', 'outcome', 'voidReason']);
    const newestFirst = ['YES', 'NO', 'NO', 'VOID', 'YES', 'NO', 'YES', 'YES'];
    const ledger = [
      open('fam'),
      ...newestFirst.map((outcome, i) => win('fam', NOW - (i + 1) * DAY_MS, outcome, { evidence: { reason: 'judge_disagreement' } })),
    ].reverse();
    assert.deepEqual(buildFamilyOutcomes(ledger, NOW), [
      { forecastId: 'fam', outcome: 'YES' },
      { forecastId: 'fam', outcome: 'NO' },
      { forecastId: 'fam', outcome: 'NO' },
      { forecastId: 'fam', outcome: 'VOID', voidReason: 'judge_disagreement' },
      { forecastId: 'fam', outcome: 'YES' },
    ]);
  });

  it('names the withheld seal instead of folding it into other', () => {
    const ledger = [open('fam'), win('fam', NOW - DAY_MS, 'VOID', { evidence: { reason: 'withheld_unpublished' } })];
    assert.deepEqual(buildFamilyOutcomes(ledger, NOW), [{ forecastId: 'fam', outcome: 'VOID', voidReason: 'withheld_unpublished' }]);
  });

  it('checks the origin of every window, not only the open one', () => {
    const ledger = [
      open('fam'),
      win('fam', NOW - DAY_MS, 'NO', { generationOrigin: undefined }),
      win('fam', NOW - 2 * DAY_MS, 'YES', { generationOrigin: 'unknown' }),
      win('fam', NOW - 3 * DAY_MS, 'NO', { generationOrigin: 'bet_engine' }),
      win('fam', NOW - 4 * DAY_MS, 'VOID', { generationOrigin: 'state_derived', evidence: { reason: 'other' } }),
      win('fam', NOW - 5 * DAY_MS, 'YES'),
    ];
    assert.deepEqual(buildFamilyOutcomes(ledger, NOW), [{ forecastId: 'fam', outcome: 'YES' }]);
  });

  it(`keeps the ${FAMILY_OUTCOME_FAMILY_LIMIT} most recently published families`, () => {
    const total = FAMILY_OUTCOME_FAMILY_LIMIT + 6;
    const id = (i) => `fam-${String(i).padStart(2, '0')}`;
    const ledger = Array.from({ length: total }, (_, i) => [
      open(id(i), { lastSeenAt: NOW - (total - i) * 60_000 }),
      win(id(i), NOW - DAY_MS, 'YES'),
    ]).flat();
    const kept = new Set(buildFamilyOutcomes(ledger, NOW).map((row) => row.forecastId));
    assert.deepEqual([...kept].sort(), Array.from({ length: FAMILY_OUTCOME_FAMILY_LIMIT }, (_, i) => id(i + 6)));
  });

  it('stays inside its byte budget for a worst-case ledger', () => {
    const families = 400;
    const ledger = Array.from({ length: families }, (_, f) => {
      const id = `fc-infrastructure-${f.toString(16).padStart(8, '0')}`;
      return [
        open(id, { lastSeenAt: NOW - f }),
        ...Array.from({ length: 30 }, (_, w) => win(id, NOW - (w + 1) * 3_600_000, 'VOID', { evidence: { reason: 'count_source_window_not_retained' } })),
      ];
    }).flat();
    const rows = buildFamilyOutcomes(ledger, NOW);
    assert.equal(rows.length, FAMILY_OUTCOME_FAMILY_LIMIT * FAMILY_OUTCOME_LIMIT);
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    console.log(`familyOutcomes worst case: ${bytes} bytes`);
    assert.ok(bytes <= 14_000, `${bytes} bytes`);
  });
});

describe('skill against the cohort base rate (#8990 item 10)', () => {
  // `families` forecast ids with `rowsPer` windows each; family i resolves YES
  // when yes(i) is true and is forecast at p(i).
  function familyLedger({ families, rowsPer = 1, yes, p = () => 0.3, origin = 'detector', domain = 'market', prefix = 'fam' }) {
    const ledger = {};
    for (let i = 0; i < families; i += 1) {
      for (let r = 0; r < rowsPer; r += 1) {
        ledger[`${prefix}-${i}-${r}`] = resolved({
          id: `${prefix}-${i}`, probability: p(i), outcome: yes(i) ? 'YES' : 'NO', generationOrigin: origin, domain,
        });
      }
    }
    return ledger;
  }

  it('scores BSS = 1 - Brier / p(1-p), with the reference from the headline rows alone', () => {
    const ledger = {
      ...familyLedger({ families: 40, yes: (i) => i < 10 }),
      // An excluded origin with a different base rate must not move the reference.
      ...familyLedger({ families: 40, yes: () => true, origin: 'state_derived', prefix: 'synthetic' }),
    };
    const { skill } = computeScorecard(ledger, NOW);
    assert.equal(skill.count, 40);
    assert.equal(skill.yesCount, 10);
    assert.equal(skill.brier, 0.19, '10 x 0.49 + 30 x 0.09 over 40');
    assert.equal(skill.referenceBrier, 0.1875, 'base rate 0.25, so 0.25 x 0.75');
    assert.equal(skill.bss, round6(1 - 0.19 / 0.1875));
  });

  it('reports rows, families and Kish effective n side by side', () => {
    const ledger = {
      ...familyLedger({ families: 1, rowsPer: 6, yes: () => true, prefix: 'big' }),
      ...familyLedger({ families: 6, rowsPer: 1, yes: (i) => i % 2 === 0, prefix: 'small' }),
    };
    const { skill } = computeScorecard(ledger, NOW);
    assert.equal(skill.count, 12);
    assert.equal(skill.families, 7);
    assert.equal(skill.nEff, round6(12 ** 2 / (6 ** 2 + 6)), '(sum of family sizes)^2 / sum of squares');
    assert.equal(skill.yesFamilies, 4);
    assert.equal(skill.noFamilies, 3);
  });

  it(`calls the headline measurable only from ${SKILL_MIN_FAMILIES} families with ${SKILL_MIN_OUTCOME_FAMILIES} YES and ${SKILL_MIN_OUTCOME_FAMILIES} NO families`, () => {
    const measurable = (options) => computeScorecard(familyLedger(options), NOW).skill.measurable;
    const half = (i) => i % 2 === 0;
    assert.equal(measurable({ families: SKILL_MIN_FAMILIES, yes: half }), true);
    assert.equal(measurable({ families: SKILL_MIN_FAMILIES - 1, yes: half }), false);
    assert.equal(measurable({ families: SKILL_MIN_FAMILIES - 1, rowsPer: 20, yes: half }), false, 'rows never stand in for families');
    assert.equal(measurable({ families: SKILL_MIN_FAMILIES, yes: (i) => i < SKILL_MIN_OUTCOME_FAMILIES }), true);
    assert.equal(measurable({ families: SKILL_MIN_FAMILIES, yes: (i) => i < SKILL_MIN_OUTCOME_FAMILIES - 1 }), false, 'too few YES families');
    assert.equal(measurable({ families: SKILL_MIN_FAMILIES, yes: (i) => i >= SKILL_MIN_OUTCOME_FAMILIES - 1 }), false, 'too few NO families');
  });

  it('counts a family with both outcomes as a YES family and as a NO family', () => {
    // 25 one-way families plus 5 mixed ones: the minority side reaches 5 only through the mixed families.
    const mixed = (oneWay) => {
      const ledger = familyLedger({ families: 25, yes: () => oneWay === 'YES', prefix: 'oneway' });
      for (let i = 0; i < 5; i += 1) {
        ledger[`mixed-${i}-yes`] = resolved({ id: `mixed-${i}`, probability: 0.4, outcome: 'YES' });
        ledger[`mixed-${i}-no`] = resolved({ id: `mixed-${i}`, probability: 0.4, outcome: 'NO' });
      }
      return computeScorecard(ledger, NOW);
    };
    const mostlyYes = mixed('YES');
    assert.equal(mostlyYes.skill.families, 30);
    assert.equal(mostlyYes.skill.yesFamilies, 30);
    assert.equal(mostlyYes.skill.noFamilies, 5);
    assert.equal(mostlyYes.skill.measurable, true);
    assert.equal(mostlyYes.uncertainty.skillBrier.insufficientSample, false, 'the interval flag counts mixed families on both sides too');
    const mostlyNo = mixed('NO');
    assert.equal(mostlyNo.skill.yesFamilies, 5);
    assert.equal(mostlyNo.skill.measurable, true);
    assert.equal(mostlyNo.uncertainty.skillBrier.insufficientSample, false);
  });

  it('bootstraps BSS by whole family, so repeating every family leaves the interval unchanged', () => {
    const options = { families: 40, yes: (i) => i % 3 === 0, p: (i) => (i % 10) / 10 + 0.05 };
    const once = computeScorecard(familyLedger(options), NOW);
    const repeated = computeScorecard(familyLedger({ ...options, rowsPer: 5 }), NOW);
    assert.equal(repeated.skill.count, 5 * once.skill.count);
    assert.equal(repeated.skill.families, once.skill.families);
    assert.equal(repeated.skill.bss, once.skill.bss);
    assert.ok(once.skill.bssCi95[0] < once.skill.bss && once.skill.bss < once.skill.bssCi95[1], 'the interval brackets the estimate');
    assert.deepEqual(repeated.skill.bssCi95, once.skill.bssCi95, 'a row bootstrap would narrow it five-fold');
    assert.deepEqual(repeated.uncertainty.skillBrier.ci95, once.uncertainty.skillBrier.ci95);
    assert.deepEqual(computeScorecard(familyLedger(options), NOW).skill.bssCi95, once.skill.bssCi95, 'seeded');
  });

  it('withholds the BSS interval when more than 5% of family draws hold no minority outcome', () => {
    // 9 families, 2 of them NO: a draw misses both with probability (7/9)^9, about 10%.
    const sparse = computeScorecard(familyLedger({ families: 9, yes: (i) => i >= 2 }), NOW).skill;
    assert.ok(Number.isFinite(sparse.bss));
    assert.equal('bssCi95' in sparse, false);
    // 40 families, 10 NO: a draw misses them all with probability (30/40)^40, under 0.01%.
    const dense = computeScorecard(familyLedger({ families: 40, yes: (i) => i >= 10 }), NOW).skill;
    assert.equal(dense.bssCi95.length, 2);
  });

  it('leaves BSS undefined, never NaN, when every outcome went one way', () => {
    const { skill } = computeScorecard(familyLedger({ families: 35, yes: () => false }), NOW);
    assert.equal(skill.referenceBrier, 0);
    assert.equal(skill.bss, null);
    assert.equal('bssCi95' in skill, false);
    assert.equal(skill.measurable, false);
    assert.ok(!JSON.stringify(skill).includes('NaN'));
  });

  it('publishes a domain BSS only where the domain meets the family and outcome minimums', () => {
    const half = (i) => i % 2 === 0;
    const ledger = {
      ...familyLedger({ families: SKILL_MIN_FAMILIES, yes: half, domain: 'conflict', prefix: 'c' }),
      ...familyLedger({ families: SKILL_MIN_FAMILIES - 1, rowsPer: 3, yes: half, domain: 'cyber', prefix: 'y' }),
      ...familyLedger({ families: SKILL_MIN_FAMILIES, yes: () => false, domain: 'political', prefix: 'p' }),
    };
    const rows = Object.fromEntries(computeScorecard(ledger, NOW).publishedByDomain.map((row) => [row.domain, row]));

    assert.equal(rows.conflict.measurable, true);
    assert.equal(rows.conflict.referenceBrier, 0.25);
    assert.equal(rows.conflict.bss, round6(1 - rows.conflict.brier / 0.25));
    assert.equal(rows.conflict.bssCi95.length, 2);

    assert.equal(rows.cyber.count, 3 * (SKILL_MIN_FAMILIES - 1));
    assert.equal(rows.cyber.families, SKILL_MIN_FAMILIES - 1);
    assert.equal(rows.cyber.measurable, false);
    assert.equal('bss' in rows.cyber, false, 'no domain BSS below the family minimum');
    assert.equal('bssCi95' in rows.cyber, false);

    assert.equal(rows.political.measurable, false, 'no YES outcome, no reference to beat');
    assert.equal('bss' in rows.political, false);
  });
});

describe('go-forward VOID share KPI (#4930)', () => {
  const AFTER = Date.parse('2026-10-20T06:00:00Z');
  const OPENED_BEFORE = GO_FORWARD_SINCE_MS - 1;
  const opened = (at, overrides) => resolved({ firstSeenAt: at, generatedAt: at, resolvedAt: AFTER - DAY_MS, ...overrides });
  const many = (count, voids) => Array.from({ length: count }, (_, i) => opened(GO_FORWARD_SINCE_MS + DAY_MS, {
    id: `m${i}`, outcome: i < voids ? 'VOID' : i % 2 ? 'YES' : 'NO', evidence: i < voids ? { reason: 'all_judges_void' } : {},
  }));

  it('counts only windows first seen on or after the boundary', () => {
    const scorecard = computeScorecard([
      opened(OPENED_BEFORE, { id: 'old', outcome: 'VOID', evidence: { reason: 'judged_old_selection' } }),
      opened(GO_FORWARD_SINCE_MS, { id: 'edge', outcome: 'VOID', evidence: { reason: 'all_judges_void' } }),
      opened(GO_FORWARD_SINCE_MS + DAY_MS, { id: 'yes', outcome: 'YES' }),
      opened(GO_FORWARD_SINCE_MS + DAY_MS, { id: 'no', outcome: 'NO' }),
      opened(GO_FORWARD_SINCE_MS + DAY_MS, { id: 'void-2', outcome: 'VOID', evidence: { reason: 'late_read' } }),
      { id: 'open', status: 'pending', probability: 0.4, firstSeenAt: GO_FORWARD_SINCE_MS + DAY_MS },
    ], AFTER);

    assert.equal(GO_FORWARD_SINCE, '2026-10-08');
    assert.equal(GO_FORWARD_SINCE_MS, Date.parse('2026-10-08T00:00:00Z'));
    assert.equal(scorecard.totals.void, 3, 'the rolling totals still count the pre-boundary void');
    assert.deepEqual(scorecard.goForward, {
      since: '2026-10-08',
      target: GO_FORWARD_VOID_SHARE_TARGET,
      minResolved: GO_FORWARD_MIN_RESOLVED,
      windowTruncated: false,
      rollingWindowDays: DEFAULT_ROLLING_WINDOW_DAYS,
      entries: 5,
      resolved: 4,
      void: 2,
      voidShare: 0.5,
      voidShareCi95: wilsonInterval(2, 4),
      voidByReason: { all_judges_void: 1, late_read: 1 },
    });
  });

  it('leaves unpublished shadow bets out and keeps published state-derived rows (#5525)', () => {
    const rows = [
      opened(GO_FORWARD_SINCE_MS, { id: 'bet', generationOrigin: 'bet_engine', probabilitySource: 'ensemble', outcome: 'YES' }),
      opened(GO_FORWARD_SINCE_MS, { id: 'bet-2', generationOrigin: 'bet_engine', probabilitySource: 'ensemble', outcome: 'NO' }),
      opened(GO_FORWARD_SINCE_MS, { id: 'energy', generationOrigin: 'state_derived', domain: 'energy', outcome: 'VOID' }),
      opened(GO_FORWARD_SINCE_MS, { id: 'detector', outcome: 'NO' }),
    ];
    const held = computeScorecard(rows, AFTER).goForward;
    assert.equal(held.resolved, 2);
    assert.equal(held.void, 1);
    const promoted = computeScorecard(rows, AFTER, { promoteBetEngine: true }).goForward;
    assert.equal(promoted.resolved, 4, 'a promoted bet is published, so it counts');
  });

  it('compares with the target only from the minimum sample', () => {
    assert.equal(GO_FORWARD_MIN_RESOLVED, 30);
    const enough = computeScorecard(many(30, 4), AFTER).methodology;
    assert.match(enough, /Since 8 October 2026, 4 of 30 resolved published forecasts were void \(13\.3%, 95% interval 5\.3% to 29\.7%\); the target is under 15%\./);
    assert.match(enough, /This counts published forecasts first issued on or after that date, so it leaves out unpublished shadow bets and the voids relabelled in the issue #8990 audit\./);
    const few = computeScorecard(many(29, 1), AFTER).methodology;
    assert.match(few, /Since 8 October 2026, 1 of 29 resolved published forecasts was void \(3\.4%, 95% interval 0\.6% to 17\.2%\)\. That is too few to compare with the target of under 15%, which needs at least 30 resolved\. Judged forecasts resolve days after hard ones and have voided more often, so early readings run low\./);
    assert.doesNotMatch(few, /the target is under 15%/);
  });

  it('places a window by generatedAt when it has no first sighting', () => {
    const row = opened(GO_FORWARD_SINCE_MS + DAY_MS, { outcome: 'VOID' });
    delete row.firstSeenAt;
    const undated = opened(GO_FORWARD_SINCE_MS + DAY_MS, { id: 'undated', outcome: 'VOID' });
    delete undated.firstSeenAt;
    delete undated.generatedAt;
    const { goForward } = computeScorecard([row, undated], AFTER);
    assert.equal(goForward.resolved, 1);
    assert.deepEqual(goForward.voidByReason, { unknown: 1 });
  });

  it('says none resolved yet instead of a 0% share', () => {
    const scorecard = computeScorecard([
      opened(OPENED_BEFORE, { outcome: 'VOID' }),
      { id: 'open', status: 'pending-judge', probability: 0.4, firstSeenAt: GO_FORWARD_SINCE_MS + DAY_MS },
    ], AFTER);
    assert.equal(scorecard.goForward.resolved, 0);
    assert.equal(scorecard.goForward.voidShare, null);
    assert.equal(scorecard.goForward.voidShareCi95, null);
    assert.match(scorecard.methodology, /Since 8 October 2026, no published forecast has resolved yet, so there is no void share to compare with the target of under 15%\./);
    assert.doesNotMatch(scorecard.methodology, /0\.0%/);
  });

  it('uses the singular for one resolved forecast', () => {
    const { methodology } = computeScorecard([opened(GO_FORWARD_SINCE_MS, { outcome: 'NO' })], AFTER);
    assert.match(methodology, /Since 8 October 2026, 0 of 1 resolved published forecast was void \(0\.0%, 95% interval 0\.0% to 79\.3%\)/);
  });

  it('names the rolling window once the boundary is older than it', () => {
    const later = GO_FORWARD_SINCE_MS + (DEFAULT_ROLLING_WINDOW_DAYS + 1) * DAY_MS;
    const scorecard = computeScorecard([opened(later - DAY_MS, { outcome: 'VOID', resolvedAt: later })], later);
    assert.equal(scorecard.goForward.windowTruncated, true);
    assert.match(scorecard.methodology, new RegExp(`In the last ${DEFAULT_ROLLING_WINDOW_DAYS} days, 1 of 1 resolved published forecast was void .* first issued on or after 8 October 2026,`));
  });

  it('adds no note before the boundary', () => {
    const scorecard = computeScorecard([], GO_FORWARD_SINCE_MS - 1);
    assert.doesNotMatch(scorecard.methodology, /8 October 2026/);
    assert.equal(scorecard.goForward.entries, 0);
  });
});

describe('spec-origin follow-through slice (#7067)', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const GPS = 'intelligence:gpsjam:v2';
  const hard = (overrides) => resolved({ spec: { kind: 'hard', sourceFeed: GPS, metricKey: `${GPS}|hexCount(region==Red Sea)` }, deadline: NOW - 3 * DAY_MS, ...overrides });
  const downgraded = (overrides) => resolved({
    specOrigin: 'hard_downgraded_unextractable',
    spec: { kind: 'judged', question: 'q', specOrigin: 'hard_downgraded_unextractable', originalFamily: 'gps', originalSourceFeed: GPS },
    deadline: NOW - 6 * DAY_MS,
    ...overrides,
  });

  it('files rows by origin and family, keeps the legacy hard path beside the downgrade, and drops the #5334 baseline', () => {
    const ledger = {
      legacyYes: hard({ id: 'l1', resolvedAt: NOW - 3 * DAY_MS + 2 * HOUR_MS }),
      legacyVoid: hard({ id: 'l2', outcome: 'VOID', resolvedAt: NOW - 3 * DAY_MS + 4 * HOUR_MS }),
      gatedHard: hard({ id: 'g1', specOrigin: 'hard', outcome: 'NO', probability: 0.3, resolvedAt: NOW - 3 * DAY_MS + 6 * HOUR_MS }),
      downOnTime: downgraded({ id: 'd1', resolvedAt: NOW - 6 * DAY_MS + DAY_MS }),
      // Past deadline + 18h grace + 2d SLA: scored, but not within SLA.
      downLate: downgraded({ id: 'd2', outcome: 'NO', probability: 0.2, resolvedAt: NOW - 6 * DAY_MS + 3 * DAY_MS }),
      downPending: { id: 'd3', status: 'pending-judge', specOrigin: 'hard_downgraded_unextractable', domain: 'conflict', spec: { kind: 'judged', originalFamily: 'prediction_market', originalSourceFeed: 'prediction:markets-bootstrap:v1' }, deadline: NOW + DAY_MS },
      judgedNative: { id: 'j1', status: 'pending-judge', domain: 'political', spec: { kind: 'judged', question: 'q' }, deadline: NOW + DAY_MS },
      infraBaseline: hard({ id: 'i1', outcome: 'VOID', domain: 'infrastructure', spec: { kind: 'hard', sourceFeed: 'infra:outages:v1' } }),
    };
    const { specOrigins } = computeScorecard(ledger, NOW);
    assert.equal(specOrigins.excludedInfrastructureBaseline, 1);
    assert.deepEqual(Object.keys(specOrigins.byOrigin).sort(), ['hard', 'hard_downgraded_unextractable', 'legacy']);
    assert.deepEqual(specOrigins.byOrigin.legacy.gps, {
      entries: 2, resolved: 2, scored: 1, void: 1, pending: 0, pendingJudge: 0, scoredWithinSla: 1, scoredWithinSlaRate: 0.5, medianLatencyHours: 3,
    });
    assert.deepEqual(Object.keys(specOrigins.byOrigin.legacy).sort(), ['gps', 'judged:political']);
    assert.equal(specOrigins.byOrigin.hard.gps.scored, 1);
    assert.deepEqual(specOrigins.byOrigin.hard_downgraded_unextractable.gps, {
      entries: 2, resolved: 2, scored: 2, void: 0, pending: 0, pendingJudge: 0, scoredWithinSla: 1, scoredWithinSlaRate: 0.5, medianLatencyHours: 48,
    });
    assert.equal(specOrigins.byOrigin.hard_downgraded_unextractable.prediction_market.pendingJudge, 1);
    assert.equal(specOrigins.byOrigin.hard_downgraded_unextractable.prediction_market.scoredWithinSlaRate, null);
  });

  it('keys rows by the dispatch family, not the feed namespace, and leaves bets out', () => {
    const row = (id, spec, extra = {}) => resolved({ id, spec: { kind: 'hard', ...spec }, deadline: NOW - 3 * DAY_MS, ...extra });
    const ledger = {
      shipping: row('s', { sourceFeed: 'supply_chain:shipping:v2' }),
      commodity: row('c', { sourceFeed: 'market:commodities-bootstrap:v1' }),
      eer: row('e', { sourceFeed: 'economic:bis:eer:v1' }),
      chokepoint: row('k', { sourceFeed: 'supply_chain:chokepoints:v4' }),
      unlisted: row('u', { sourceFeed: 'intelligence:other:v1' }),
      gated: row('g', { sourceFeed: 'supply_chain:chokepoints:v4', specOrigin: 'hard', specFamily: 'market' }, { specOrigin: 'hard' }),
      bet: row('b', { sourceFeed: 'prediction:markets-resolution:v1' }, { generationOrigin: 'bet_engine', probabilitySource: 'ensemble' }),
    };
    const { specOrigins } = computeScorecard(ledger, NOW);
    assert.deepEqual(
      Object.fromEntries(Object.entries(specOrigins.byOrigin.legacy).map(([family, counts]) => [family, counts.entries])),
      { market: 3, supply_chain: 1, 'feed:intelligence:other:v1': 1 },
    );
    assert.equal(specOrigins.byOrigin.hard.market.entries, 1);
    assert.equal(specOrigins.excludedBetEngine, 1);
  });

  it('stays off the public scorecard contract', async () => {
    const { SCORECARD_DECLARED_FIELDS } = await import('../scripts/build-accuracy-page.mjs');
    for (const field of ['specOrigins', 'withheldAtEmission']) assert.ok(!SCORECARD_DECLARED_FIELDS.includes(field), field);
  });
});
