import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DUPLICATE_WINDOW_VOID_REASON,
  FIRST_SEEN_RESCORE_REASON,
  collectUnarchivedReceipts,
  ingestHistory,
  processResolutionCycle,
  processResolutionCycleWithJudges,
} from '../scripts/seed-forecast-resolutions.mjs';
import { buildPublicReceipts, computeScorecard } from '../scripts/_forecast-scorecard.mjs';
import { shapeResolutionFeeds } from '../scripts/_forecast-resolution-eval.mjs';
import { selectFitCohort } from '../scripts/_forecast-calibration.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const T0 = Date.UTC(2026, 6, 15, 0, 4);
const CHOKEPOINT_FEED = 'supply_chain:chokepoints:v4';
const COMMODITY_FEED = 'market:commodities-bootstrap:v1';
const CYBER_FEED = 'cyber:threats-bootstrap:v2';

const noJudges = {
  judgeModels: [
    async () => { throw new Error('no judged row is due in this test'); },
    async () => { throw new Error('no judged row is due in this test'); },
  ],
};

function chokepoint(generatedAt, probability, overrides = {}) {
  const deadline = generatedAt + 7 * DAY_MS;
  return {
    id: 'fc-supply_chain-hormuz',
    domain: 'supply_chain',
    region: 'Strait of Hormuz',
    title: 'Hormuz disruption risk rises',
    probability,
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    generatedAt,
    resolution: {
      kind: 'hard',
      metricKey: `${CHOKEPOINT_FEED}|riskScore(route==Strait of Hormuz)`,
      operator: '>=',
      threshold: 60,
      window: 'at-deadline',
      deadline,
      sourceFeed: CHOKEPOINT_FEED,
    },
    ...overrides,
  };
}

function brent(generatedAt, threshold, baselineValue, probability) {
  return {
    id: 'commodity:BZ=F',
    title: `${threshold >= baselineValue ? 'rise' : 'fall'} to ${threshold}`,
    domain: 'market',
    region: '',
    generationOrigin: 'bet_engine',
    probabilitySource: 'ensemble',
    probability,
    generatedAt,
    resolution: {
      kind: 'hard',
      metricKey: `${COMMODITY_FEED}|price(symbol==BZ=F)`,
      operator: 'crosses',
      threshold,
      baselineValue,
      window: 'at-deadline',
      deadline: generatedAt + 4 * DAY_MS,
      sourceFeed: COMMODITY_FEED,
      question: `Will Brent reach ${threshold} by day ${generatedAt}?`,
    },
  };
}

function judged(generatedAt, id, region, probability) {
  const title = `Sovereign risk repricing from ${region} security escalation state`;
  return {
    id,
    domain: 'market',
    region,
    title,
    probability,
    timeHorizon: '30d',
    generationOrigin: 'state_derived',
    stateBucketId: 'energy',
    generatedAt,
    resolution: {
      kind: 'judged',
      deadline: generatedAt + 30 * DAY_MS,
      question: `Will "${title}" (market, ${region}) resolve YES within its 30d horizon?`,
    },
  };
}

function cyber(generatedAt, threshold, probability) {
  return {
    id: 'fc-cyber-us',
    domain: 'cyber',
    region: 'United States',
    title: 'Cyber threat concentration: United States',
    probability,
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    generatedAt,
    resolution: {
      kind: 'hard',
      metricKey: `${CYBER_FEED}|count(country==United States)`,
      operator: '>=',
      threshold,
      window: 'within-horizon',
      deadline: generatedAt + 7 * DAY_MS,
      sourceFeed: CYBER_FEED,
    },
  };
}

const snap = (generatedAt, predictions) => ({ generatedAt, predictions });
const chokepointFeed = (riskScore) => ({ [CHOKEPOINT_FEED]: { chokepoints: [{ route: 'Strait of Hormuz', riskScore }] } });
const brentFeed = (price, fetchedAt) => shapeResolutionFeeds({ [COMMODITY_FEED]: { _seed: { fetchedAt }, data: { quotes: [{ symbol: 'BZ=F', price }] } } });
const windowsOf = (ledger, id) => Object.values(ledger).filter((entry) => entry.id === id && typeof entry.spec?.horizon !== 'string');

describe('ghost windows (#8990 item 4)', () => {
  const history = [snap(T0, [chokepoint(T0, 0.2)]), snap(T0 + DAY_MS, [chokepoint(T0 + DAY_MS, 0.3)]), snap(T0 + 6 * DAY_MS, [chokepoint(T0 + 6 * DAY_MS, 0.4)])];

  it('never reopens a resolved window from the emissions it already absorbed', async () => {
    let ledger = (await processResolutionCycleWithJudges({}, history, chokepointFeed(40), [], T0 + 6 * DAY_MS + HOUR_MS, noJudges)).ledger;
    ledger = (await processResolutionCycleWithJudges(ledger, history, chokepointFeed(70), [], T0 + 7 * DAY_MS + HOUR_MS, noJudges)).ledger;
    assert.deepEqual(windowsOf(ledger, 'fc-supply_chain-hormuz').map((entry) => [entry.status, entry.outcome]), [['resolved', 'YES']]);

    const again = await processResolutionCycleWithJudges(ledger, history, chokepointFeed(10), [], T0 + 7 * DAY_MS + 2 * HOUR_MS, noJudges);
    assert.equal(windowsOf(again.ledger, 'fc-supply_chain-hormuz').length, 1, 'an absorbed emission must not open a back-dated window');
    assert.equal(again.scorecard.totals.scored, 1);
  });

  it('re-ingesting the same history any number of times yields the same ledger', () => {
    const open = processResolutionCycle({}, history, chokepointFeed(40), T0 + 6 * DAY_MS + HOUR_MS).ledger;
    const resolved = processResolutionCycle(open, history, chokepointFeed(70), T0 + 7 * DAY_MS + HOUR_MS).ledger;
    let ledger = resolved;
    for (let run = 1; run <= 4; run += 1) ledger = ingestHistory(ledger, history, T0 + 7 * DAY_MS + HOUR_MS + run * HOUR_MS);
    assert.deepEqual(ledger, resolved);
  });

  it('does not open a window whose deadline passed before the resolver first saw it', async () => {
    const late = await processResolutionCycleWithJudges({}, [snap(T0, [chokepoint(T0, 0.2)])], chokepointFeed(70), [], T0 + 8 * DAY_MS, noJudges);
    assert.deepEqual(late.ledger, {});
    const due = await processResolutionCycleWithJudges({}, [snap(T0, [chokepoint(T0, 0.2)])], chokepointFeed(70), [], T0 + 7 * DAY_MS, noJudges);
    assert.equal(windowsOf(due.ledger, 'fc-supply_chain-hormuz').length, 1, 'a window due exactly now is still read on time');
  });

  it('reproduces the Brent ghost: a re-read 13 days later grades nothing new', () => {
    const snaps = [snap(T0, [brent(T0, 87.43, 85.3, 0.4)]), snap(T0 + 5 * HOUR_MS, [brent(T0 + 5 * HOUR_MS, 87.43, 85.48, 0.45)])];
    let ledger = processResolutionCycle({}, snaps, brentFeed(85.3, T0 + 6 * HOUR_MS), T0 + 6 * HOUR_MS).ledger;
    for (let day = 1; day <= 4; day += 1) {
      const now = T0 + day * DAY_MS + 6 * HOUR_MS;
      ledger = processResolutionCycle(ledger, snaps, brentFeed(day === 4 ? 88.1 : 85, now), now).ledger;
    }
    const late = T0 + 13 * DAY_MS + 6 * HOUR_MS;
    const after = processResolutionCycle(ledger, snaps, brentFeed(78.68, late), late);
    assert.deepEqual(windowsOf(after.ledger, 'commodity:BZ=F').map((entry) => [entry.outcome, entry.evidence?.metricValue]), [['YES', 88.1]]);
  });
});

describe('scored probability (#8990 item 5)', () => {
  it('scores the probability published at the window\'s first emission and keeps the last sighting for audit', async () => {
    const anchor = { marketTitle: 'Hormuz market', marketPrice: 0.3, marketBlendedProbability: 0.2, drift: 0, source: 'polymarket' };
    const history = [
      snap(T0, [chokepoint(T0, 0.2, { calibration: anchor })]),
      snap(T0 + 3 * DAY_MS, [chokepoint(T0 + 3 * DAY_MS, 0.9, { calibration: null })]),
    ];
    let ledger = (await processResolutionCycleWithJudges({}, history, chokepointFeed(40), [], T0 + 3 * DAY_MS + HOUR_MS, noJudges)).ledger;
    const result = await processResolutionCycleWithJudges(ledger, history, chokepointFeed(30), [], T0 + 7 * DAY_MS + HOUR_MS, noJudges);
    const [row] = windowsOf(result.ledger, 'fc-supply_chain-hormuz');
    assert.equal(row.outcome, 'NO');
    assert.equal(row.probability, 0.2);
    assert.equal(row.firstSeenProbability, 0.2);
    assert.equal(row.lastSeenProbability, 0.9);
    assert.deepEqual(row.calibration, anchor, 'the market anchor stays paired with the scored probability');
    assert.equal(result.scorecard.overall.brier, 0.04);
  });

  it('states the first-emission rule in the scorecard methodology', () => {
    const { methodology } = computeScorecard({}, T0);
    assert.match(methodology, /probability published when the window opened/);
    assert.doesNotMatch(methodology, /published at the time/);
  });
});

describe('one window per question (#8990 item 11)', () => {
  it('opens a window per bet question instead of absorbing a new threshold or direction', () => {
    const snaps = [
      snap(T0, [brent(T0, 87.43, 85.3, 0.4)]),
      snap(T0 + 5 * HOUR_MS, [brent(T0 + 5 * HOUR_MS, 87.62, 85.48, 0.35)]),
      snap(T0 + DAY_MS, [brent(T0 + DAY_MS, 82.36, 84.45, 0.6)]),
      snap(T0 + 2 * DAY_MS, [brent(T0 + 2 * DAY_MS, 87.43, 85.3, 0.1)]),
    ];
    const ledger = ingestHistory({}, snaps, T0 + 2 * DAY_MS + HOUR_MS);
    const rows = windowsOf(ledger, 'commodity:BZ=F').sort((a, b) => a.generatedAt - b.generatedAt);
    assert.deepEqual(rows.map((entry) => [entry.spec.threshold, entry.probability]), [[87.43, 0.4], [87.62, 0.35], [82.36, 0.6]]);
    assert.equal(rows[0].lastSeenProbability, 0.1, 'the repeated question joins its own window');
  });

  it('keeps one window for a detector that re-derives its threshold every run', () => {
    const runs = [0, 1, 2, 3].map((hour) => chokepoint(T0 + hour * HOUR_MS, 0.2 + hour / 10, {}));
    runs.forEach((fc, index) => { fc.resolution = { ...fc.resolution, threshold: 60 + index }; });
    const ledger = ingestHistory({}, runs.map((fc) => snap(fc.generatedAt, [fc])), T0 + 4 * HOUR_MS);
    assert.deepEqual(windowsOf(ledger, 'fc-supply_chain-hormuz').map((entry) => [entry.spec.threshold, entry.probability, entry.lastSeenProbability]), [[60, 0.2, 0.5]]);
  });

  it('treats the same threshold reached from the other side as a different question', () => {
    const rise = brent(T0, 87, 85, 0.4);
    const fall = brent(T0 + HOUR_MS, 87, 89, 0.7);
    const ledger = ingestHistory({}, [snap(T0, [rise]), snap(T0 + HOUR_MS, [fall])], T0 + 2 * HOUR_MS);
    assert.deepEqual(windowsOf(ledger, 'commodity:BZ=F').map((entry) => entry.probability).sort(), [0.4, 0.7]);
  });

  it('separates a hard question asked of another region under the same id', () => {
    const gulf = chokepoint(T0, 0.3);
    const redSea = chokepoint(T0 + HOUR_MS, 0.6, { region: 'Red Sea' });
    const ledger = ingestHistory({}, [snap(T0, [gulf]), snap(T0 + HOUR_MS, [redSea])], T0 + 2 * HOUR_MS);
    assert.deepEqual(windowsOf(ledger, 'fc-supply_chain-hormuz').map((entry) => [entry.region, entry.probability]).sort(), [['Red Sea', 0.6], ['Strait of Hormuz', 0.3]]);
  });

  it('separates judged questions that share an id across regions', async () => {
    const snaps = [
      snap(T0, [judged(T0, 'fc-market-0061b975', 'Iran', 0.6)]),
      snap(T0 + DAY_MS, [judged(T0 + DAY_MS, 'fc-market-0061b975', 'Afghanistan', 0.3)]),
      snap(T0 + 2 * DAY_MS, [judged(T0 + 2 * DAY_MS, 'fc-market-0061b975', 'Iran', 0.9)]),
    ];
    const { ledger } = await processResolutionCycleWithJudges({}, snaps, {}, [], T0 + 2 * DAY_MS + HOUR_MS, noJudges);
    const rows = windowsOf(ledger, 'fc-market-0061b975').sort((a, b) => a.generatedAt - b.generatedAt);
    assert.deepEqual(rows.map((entry) => [entry.region, entry.probability, entry.status]), [['Iran', 0.6, 'pending-judge'], ['Afghanistan', 0.3, 'pending-judge']]);
  });

  it('keys a second question with the same deadline apart from the first', () => {
    const iran = judged(T0, 'fc-market-0061b975', 'Iran', 0.6);
    const syria = { ...judged(T0, 'fc-market-0061b975', 'Syria', 0.2) };
    const ledger = ingestHistory({}, [snap(T0, [iran]), snap(T0, [syria])], T0 + HOUR_MS);
    const rows = windowsOf(ledger, 'fc-market-0061b975');
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((entry) => entry.key)).size, 2);
    for (const row of rows) assert.equal(ledger[row.key], row);
  });

  it('absorbs every threshold of a count migrated to the judges into one window, open or resolved', () => {
    const migrated = ingestHistory({}, [snap(T0, [cyber(T0, 47, 0.5)])], T0 + HOUR_MS);
    assert.equal(windowsOf(migrated, 'fc-cyber-us')[0].spec.kind, 'judged');
    const open = ingestHistory(migrated, [snap(T0, [cyber(T0, 47, 0.5)]), snap(T0 + DAY_MS, [cyber(T0 + DAY_MS, 41, 0.3)])], T0 + DAY_MS + HOUR_MS);
    assert.deepEqual(windowsOf(open, 'fc-cyber-us').map((entry) => [entry.spec.kind, entry.probability]), [['judged', 0.5]]);

    const [row] = windowsOf(open, 'fc-cyber-us');
    const resolvedHard = { [row.key]: { ...row, status: 'resolved', outcome: 'VOID', spec: cyber(T0, 47, 0.5).resolution } };
    const again = ingestHistory(resolvedHard, [snap(T0, [cyber(T0, 47, 0.5)]), snap(T0 + DAY_MS, [cyber(T0 + DAY_MS, 41, 0.3)])], T0 + DAY_MS + 2 * HOUR_MS);
    assert.equal(windowsOf(again, 'fc-cyber-us').length, 1);
  });
});

describe('existing ledger correction (#8990)', () => {
  const D = 7 * DAY_MS;
  const spec = chokepoint(T0, 0.2).resolution;
  const base = (generatedAt, extra) => ({
    id: 'fc-supply_chain-hormuz',
    key: `fc-supply_chain-hormuz@${generatedAt + D}`,
    domain: 'supply_chain',
    region: 'Strait of Hormuz',
    title: 'Hormuz disruption risk rises',
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    spec: { ...spec, deadline: generatedAt + D },
    generatedAt,
    deadline: generatedAt + D,
    firstSeenAt: generatedAt,
    lastSeenAt: generatedAt,
    samples: { count: 0, recent: [] },
    ...extra,
  });
  const keeper = base(T0, { status: 'resolved', outcome: 'YES', probability: 0.6, firstSeenProbability: 0.2, probabilitySource: 'ensemble', calibration: { marketPrice: 0.5 }, resolvedAt: T0 + D + HOUR_MS, evidence: { metricValue: 70 } });
  const ghostResolved = base(T0 + DAY_MS, { status: 'resolved', outcome: 'NO', probability: 0.3, firstSeenProbability: 0.3, resolvedAt: T0 + D + 2 * HOUR_MS, evidence: { metricValue: 10 } });
  const ghostPending = base(T0 + 6 * DAY_MS, { status: 'pending', probability: 0.4, firstSeenProbability: 0.4 });
  const ghostHorizon = { ...base(T0 + DAY_MS, {}), key: `${ghostResolved.key}@h24`, parentKey: ghostResolved.key, status: 'pending', probability: 0.5, firstSeenProbability: 0.5, spec: { ...spec, horizon: 'h24', deadline: T0 + 2 * DAY_MS } };
  const otherQuestion = base(T0 + 2 * DAY_MS, { region: 'Red Sea', spec: { ...spec, metricKey: `${CHOKEPOINT_FEED}|riskScore(route==Bab el-Mandeb)`, deadline: T0 + 2 * DAY_MS + D }, status: 'resolved', outcome: 'NO', probability: 0.25, firstSeenProbability: 0.25, resolvedAt: T0 + 9 * DAY_MS, evidence: { metricValue: 65 } });
  const legacy = Object.fromEntries([keeper, ghostResolved, ghostPending, ghostHorizon, otherQuestion].map((entry) => [entry.key, entry]));
  const NOW = T0 + 9 * DAY_MS + HOUR_MS;

  it('voids duplicate windows, rescores last-seen probabilities, and leaves other questions scored', async () => {
    const { ledger, scorecard } = await processResolutionCycleWithJudges(legacy, [], {}, [], NOW, noJudges);

    const kept = ledger[keeper.key];
    assert.equal(kept.outcome, 'YES');
    assert.equal(kept.probability, 0.2);
    assert.equal(kept.rescore.reason, FIRST_SEEN_RESCORE_REASON);
    assert.equal(kept.rescore.supersededProbability, 0.6);
    assert.deepEqual(kept.rescore.superseded, { probabilitySource: 'ensemble', calibration: { marketPrice: 0.5 } });
    assert.equal('calibration' in kept, false);
    assert.equal('probabilitySource' in kept, false);

    for (const ghost of [ghostResolved, ghostPending, ghostHorizon]) {
      const row = ledger[ghost.key];
      assert.equal(row.status, 'resolved', ghost.key);
      assert.equal(row.outcome, 'VOID', ghost.key);
      assert.equal(row.evidence.reason, DUPLICATE_WINDOW_VOID_REASON, ghost.key);
      assert.equal(row.duplicateOf, keeper.key, ghost.key);
    }
    assert.equal(ledger[ghostResolved.key].evidence.supersededOutcome, 'NO');
    assert.deepEqual(ledger[ghostResolved.key].evidence.supersededEvidence, { metricValue: 10 });
    assert.equal(ledger[ghostPending.key].evidence.supersededStatus, 'pending');

    assert.equal(ledger[otherQuestion.key].outcome, 'NO', 'another route is a different question, not a duplicate');
    assert.equal(scorecard.totals.scored, 2);
    assert.equal(scorecard.totals.entries, 2, 'duplicate windows are not questions and leave every count');
    assert.equal(buildPublicReceipts(ledger, NOW).length, 2);
  });

  it('is idempotent across runs and leaves rows the earlier fix already voided at their reason', async () => {
    const enveloped = { ...ghostResolved, outcome: 'VOID', evidence: { reason: 'resolver_envelope_bug', voidedAt: T0 } };
    const start = { ...legacy, [ghostResolved.key]: enveloped };
    const once = (await processResolutionCycleWithJudges(start, [], {}, [], NOW, noJudges)).ledger;
    assert.equal(once[ghostResolved.key].evidence.reason, 'resolver_envelope_bug');
    assert.equal(once[ghostResolved.key].duplicateOf, keeper.key);
    const twice = (await processResolutionCycleWithJudges(once, [], {}, [], NOW + DAY_MS, noJudges)).ledger;
    assert.deepEqual(twice, once);
  });

  it('lets an emission a voided duplicate once absorbed open its own window', () => {
    const late = chokepoint(T0 + 7 * DAY_MS + 30 * 60 * 1000, 0.45);
    const ledger = ingestHistory(legacy, [snap(late.generatedAt, [late])], late.generatedAt + HOUR_MS);
    const opened = windowsOf(ledger, 'fc-supply_chain-hormuz').filter((entry) => entry.generatedAt === late.generatedAt);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].status, 'pending');
  });

  it('re-archives corrected receipts so R2 holds the corrected row before pruning', () => {
    const archived = Object.fromEntries(Object.values(legacy).map((entry) => [entry.key, entry.status === 'resolved' ? { ...entry, receiptArchivedAt: T0 + D + 3 * HOUR_MS } : entry]));
    const ledger = ingestHistory(archived, [], NOW);
    const pending = collectUnarchivedReceipts(ledger).map((receipt) => receipt.key).sort();
    assert.deepEqual(pending, [keeper.key, ghostResolved.key, ghostPending.key, ghostHorizon.key].sort());
    assert.equal(ledger[otherQuestion.key].receiptArchivedAt, T0 + D + 3 * HOUR_MS, 'an untouched row stays archived');
  });

  it('moves fields a later sighting wrote even when the probability matches the first emission', () => {
    const sameProbability = base(T0, { status: 'resolved', outcome: 'NO', probability: 0.2, firstSeenProbability: 0.2, lastSeenAt: T0 + 3 * DAY_MS, calibration: { marketPrice: 0.9 }, resolvedAt: T0 + D + HOUR_MS, evidence: { metricValue: 10 } });
    const ledger = ingestHistory({ [sameProbability.key]: sameProbability }, [], NOW);
    const row = ledger[sameProbability.key];
    assert.equal(row.probability, 0.2);
    assert.equal('calibration' in row, false);
    assert.deepEqual(row.rescore.superseded, { calibration: { marketPrice: 0.9 } });
    assert.deepEqual(ingestHistory(ledger, [], NOW + DAY_MS), ledger);
  });

  it('keeps rescored rows out of the calibration fit', () => {
    const ledger = ingestHistory(legacy, [], NOW);
    const cohortKeys = selectFitCohort(ledger, NOW).map((entry) => entry.key);
    assert.equal(cohortKeys.includes(keeper.key), false, 'the restored first-seen probability has no recorded raw value');
    assert.equal(cohortKeys.includes(otherQuestion.key), true);
  });
});

