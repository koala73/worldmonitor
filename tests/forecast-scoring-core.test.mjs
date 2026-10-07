import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DUPLICATE_WINDOW_VOID_REASON,
  FIRST_SEEN_RESCORE_REASON,
  RECEIPT_REARCHIVE_PER_RUN,
  __setCountFeedAvailableForTests,
  appendR2Receipts,
  collectUnarchivedReceipts,
  markReceiptsArchived,
  pruneArchivedTerminalEntries,
  receiptNeedsRearchive,
  ingestHistory,
  processResolutionCycle,
  processResolutionCycleWithJudges,
} from '../scripts/seed-forecast-resolutions.mjs';
import { buildFamilyOutcomes, buildPublicReceipts, computeScorecard } from '../scripts/_forecast-scorecard.mjs';
import { shapeResolutionFeeds } from '../scripts/_forecast-resolution-eval.mjs';
import { selectFitCohort } from '../scripts/_forecast-calibration.mjs';
import { CONFLICT_COUNT_SOURCE_FEED } from '../scripts/_forecast-resolution.mjs';

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

  it('treats a stored row without its own key field by its ledger key', () => {
    const open = processResolutionCycle({}, history, chokepointFeed(40), T0 + 6 * DAY_MS + HOUR_MS).ledger;
    const resolved = processResolutionCycle(open, history, chokepointFeed(70), T0 + 7 * DAY_MS + HOUR_MS).ledger;
    const keyless = Object.fromEntries(Object.entries(resolved).map(([key, { key: _key, ...entry }]) => [key, entry]));
    const ledger = ingestHistory(keyless, history, T0 + 7 * DAY_MS + 2 * HOUR_MS);
    assert.deepEqual(Object.keys(ledger), Object.keys(resolved));
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

  it('keeps one window when a count feed comes back after its rows moved to the judges', () => {
    const conflict = (generatedAt, threshold, probability) => ({
      id: 'fc-conflict-sd',
      domain: 'conflict',
      region: 'Sudan',
      title: 'Escalation risk: Sudan',
      probability,
      timeHorizon: '7d',
      generationOrigin: 'legacy_detector',
      generatedAt,
      resolution: { kind: 'hard', metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Sudan)`, operator: '>=', threshold, window: 'within-horizon', deadline: generatedAt + 7 * DAY_MS, sourceFeed: CONFLICT_COUNT_SOURCE_FEED },
    });
    const migrated = ingestHistory({}, [snap(T0, [conflict(T0, 12, 0.4)])], T0 + HOUR_MS);
    assert.equal(windowsOf(migrated, 'fc-conflict-sd')[0].spec.kind, 'judged');
    __setCountFeedAvailableForTests(CONFLICT_COUNT_SOURCE_FEED, true);
    try {
      const ledger = ingestHistory(migrated, [snap(T0 + DAY_MS, [conflict(T0 + DAY_MS, 15, 0.6)])], T0 + DAY_MS + HOUR_MS);
      assert.deepEqual(windowsOf(ledger, 'fc-conflict-sd').map((entry) => [entry.spec.kind, entry.probability, entry.lastSeenProbability]), [['judged', 0.4, 0.6]]);
    } finally {
      __setCountFeedAvailableForTests(CONFLICT_COUNT_SOURCE_FEED, undefined);
    }
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
  // A history read that holds none of these rows' emissions, as the
  // resolver's first ingest of a run would be for rows past the 8-day read.
  const HISTORY = [snap(NOW, [])];

  it('voids duplicate windows, rescores last-seen probabilities, and leaves other questions scored', async () => {
    const { ledger, scorecard } = await processResolutionCycleWithJudges(ingestHistory(legacy, HISTORY, NOW), [], {}, [], NOW, noJudges);

    const kept = ledger[keeper.key];
    assert.equal(kept.outcome, 'YES');
    assert.equal(kept.probability, 0.2);
    assert.equal(kept.rescore.reason, FIRST_SEEN_RESCORE_REASON);
    assert.equal(kept.rescore.supersededProbability, 0.6);
    assert.deepEqual(kept.rescore.superseded, { probabilitySource: 'ensemble', calibration: { marketPrice: 0.5 } });
    assert.equal('calibration' in kept, false);
    assert.equal(kept.probabilitySource, 'ensemble', 'a first emission that was not the base rate keeps its provenance');

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
    const once = (await processResolutionCycleWithJudges(ingestHistory(start, HISTORY, NOW), [], {}, [], NOW, noJudges)).ledger;
    assert.equal(once[ghostResolved.key].evidence.reason, 'resolver_envelope_bug');
    assert.equal(once[ghostResolved.key].duplicateOf, keeper.key);
    const twice = (await processResolutionCycleWithJudges(ingestHistory(once, HISTORY, NOW + DAY_MS), [], {}, [], NOW + DAY_MS, noJudges)).ledger;
    assert.deepEqual(twice, once);
  });

  it('opens a question\'s window from its earliest emission even when a later snapshot carries it', () => {
    const early = brent(T0 + DAY_MS, 110.01, 115, 0.5);
    const late = brent(T0 + 3 * DAY_MS, 110.01, 115, 0.6);
    const ledger = ingestHistory({}, [snap(T0 + 3 * DAY_MS, [late]), snap(T0 + 4 * DAY_MS, [early])], T0 + 4 * DAY_MS + HOUR_MS);
    assert.deepEqual(Object.keys(ledger), [`commodity:BZ=F@${T0 + 5 * DAY_MS}`], 'no voided duplicate is minted for the later emission');
  });

  it('converges in one run when a newly opened window precedes an existing one of its question', () => {
    const OCT_2 = T0 + 2 * DAY_MS;
    const OCT_5 = T0 + 5 * DAY_MS;
    const earlier = ingestHistory({}, [snap(T0, [brent(T0, 136.47, 120, 0.3)])], T0)[`commodity:BZ=F@${T0 + 4 * DAY_MS}`];
    const later = ingestHistory({}, [snap(OCT_5, [brent(OCT_5, 110.01, 115, 0.6)])], OCT_5)[`commodity:BZ=F@${OCT_5 + 4 * DAY_MS}`];
    const history = [snap(T0, [brent(T0, 136.47, 120, 0.3)]), snap(OCT_2, [brent(OCT_2, 110.01, 115, 0.5)]), snap(OCT_5, [brent(OCT_5, 110.01, 115, 0.6)])];
    const once = ingestHistory({ [earlier.key]: earlier, [later.key]: later }, history, OCT_5 + HOUR_MS);
    assert.equal(once[later.key].duplicateOf, `commodity:BZ=F@${OCT_2 + 4 * DAY_MS}`);
    assert.deepEqual(ingestHistory(once, history, OCT_5 + 2 * HOUR_MS), once);
  });

  it('lets an emission a voided duplicate once absorbed open its own window', () => {
    const late = chokepoint(T0 + 7 * DAY_MS + 30 * 60 * 1000, 0.45);
    const ledger = ingestHistory(legacy, [snap(late.generatedAt, [late])], late.generatedAt + HOUR_MS);
    const opened = windowsOf(ledger, 'fc-supply_chain-hormuz').filter((entry) => entry.generatedAt === late.generatedAt);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].status, 'pending');
  });

  it('flags corrected rows whose R2 receipt predates the correction, and only those', () => {
    const archived = Object.fromEntries(Object.values(legacy).map((entry) => [entry.key, entry.status === 'resolved' ? { ...entry, receiptArchivedAt: T0 + D + 3 * HOUR_MS } : entry]));
    const ledger = ingestHistory(archived, HISTORY, NOW);
    const stale = Object.values(ledger).filter(receiptNeedsRearchive).map((entry) => entry.key).sort();
    assert.deepEqual(stale, [keeper.key, ghostResolved.key].sort());
    assert.equal(ledger[keeper.key].receiptArchivedAt, T0 + D + 3 * HOUR_MS, 'the old archive stamp stays until the rewrite lands');
    assert.deepEqual(collectUnarchivedReceipts(ledger).map((receipt) => receipt.key).sort(), [keeper.key, ghostResolved.key, ghostPending.key, ghostHorizon.key].sort());
  });

  it('moves only the market anchor of a row the old code re-sighted without moving its probability', () => {
    const sameProbability = base(T0, { status: 'resolved', outcome: 'NO', probability: 0.2, firstSeenProbability: 0.2, lastSeenAt: T0 + 3 * DAY_MS, probabilitySource: 'ensemble', baselineProbability: 0.4, passes: [{ probability: 0.2 }], calibration: { marketPrice: 0.9 }, resolvedAt: T0 + D + HOUR_MS, evidence: { metricValue: 10 } });
    const ledger = ingestHistory({ [sameProbability.key]: sameProbability }, HISTORY, NOW);
    const row = ledger[sameProbability.key];
    assert.equal(row.probability, 0.2);
    assert.equal('calibration' in row, false);
    assert.deepEqual(row.rescore.superseded, { calibration: { marketPrice: 0.9 } });
    assert.equal(row.probabilitySource, 'ensemble');
    assert.equal(row.baselineProbability, 0.4);
    assert.deepEqual(row.passes, [{ probability: 0.2 }]);
    assert.deepEqual(ingestHistory(ledger, [], NOW + DAY_MS), ledger);
  });

  it('labels a window that opened on the base-rate placeholder and keeps its base rate', () => {
    const placeholder = base(T0, { generationOrigin: 'bet_engine', status: 'resolved', outcome: 'NO', probability: 0.7, firstSeenProbability: 0.4, baselineProbability: 0.4, probabilitySource: 'ensemble', passes: [{ probability: 0.7 }], resolvedAt: T0 + D + HOUR_MS, evidence: { metricValue: 10 } });
    const ledger = ingestHistory({ [placeholder.key]: placeholder }, HISTORY, NOW);
    const row = ledger[placeholder.key];
    assert.equal(row.probability, 0.4);
    assert.equal(row.probabilitySource, 'base_rate');
    assert.equal(row.baselineProbability, 0.4);
    assert.equal('passes' in row, false);
    assert.deepEqual(row.rescore.superseded, { passes: [{ probability: 0.7 }], probabilitySource: 'ensemble' });
  });

  it('restores a window\'s opening fields from its first emission when history still holds it', () => {
    const generatedAt = T0;
    const opening = { ...brent(generatedAt, 87.43, 85.3, 0.4), baselineProbability: 0.4, probabilitySource: 'ensemble', passes: [{ probability: 0.4 }], calibration: { marketPrice: 55 } };
    const resolvedRow = {
      ...ingestHistory({}, [snap(generatedAt, [opening])], generatedAt)[`commodity:BZ=F@${generatedAt + 4 * DAY_MS}`],
      status: 'resolved', outcome: 'YES', resolvedAt: generatedAt + 4 * DAY_MS + HOUR_MS, evidence: { metricValue: 88 },
      probability: 0.7, passes: [{ probability: 0.7 }], calibration: { marketPrice: 71 }, lastSeenAt: generatedAt + DAY_MS,
    };
    const ledger = ingestHistory({ [resolvedRow.key]: resolvedRow }, [snap(generatedAt, [opening])], generatedAt + 5 * DAY_MS);
    const row = ledger[resolvedRow.key];
    assert.equal(row.probability, 0.4);
    assert.equal(row.probabilitySource, 'ensemble', 'an ensemble that landed on the base rate is still an ensemble');
    assert.deepEqual(row.passes, [{ probability: 0.4 }]);
    assert.deepEqual(row.calibration, { marketPrice: 55 });
    assert.equal(row.rescore.restoredFromHistory, true);
    assert.deepEqual(row.rescore.superseded, { passes: [{ probability: 0.7 }], calibration: { marketPrice: 71 } });
    assert.deepEqual(ingestHistory(ledger, [snap(generatedAt, [opening])], generatedAt + 6 * DAY_MS), ledger);
  });

  it('leaves a row the fixed code re-sighted untouched', () => {
    const current = base(T0, { status: 'resolved', outcome: 'NO', probability: 0.2, firstSeenProbability: 0.2, lastSeenAt: T0 + 3 * DAY_MS, lastSeenProbability: 0.5, calibration: { marketPrice: 0.9 }, resolvedAt: T0 + D + HOUR_MS, evidence: { metricValue: 10 } });
    const ledger = ingestHistory({ [current.key]: current }, HISTORY, NOW);
    assert.deepEqual(ledger[current.key], current);
  });

  describe('the production run shape: history ingest, then the cycle with no history', () => {
    const generatedAt = T0;
    const anchor = { marketPrice: 55, source: 'polymarket' };
    const opening = { ...brent(generatedAt, 87.43, 85.3, 0.4), baselineProbability: 0.4, probabilitySource: 'ensemble', calibration: anchor };
    const confirmedRow = () => ({
      ...ingestHistory({}, [snap(generatedAt, [opening])], generatedAt)[`commodity:BZ=F@${generatedAt + 4 * DAY_MS}`],
      status: 'resolved', outcome: 'YES', resolvedAt: generatedAt + 4 * DAY_MS + HOUR_MS, evidence: { metricValue: 88 },
      lastSeenAt: generatedAt + DAY_MS,
    });

    it('keeps a market anchor that history confirmed through both calls (#8992 R1)', async () => {
      const row = confirmedRow();
      const pre = ingestHistory({ [row.key]: row }, [snap(generatedAt, [opening])], generatedAt + 5 * DAY_MS);
      const { ledger } = await processResolutionCycleWithJudges(pre, [], {}, [], generatedAt + 5 * DAY_MS, noJudges);
      assert.deepEqual(ledger[row.key].calibration, anchor);
      assert.equal('rescore' in ledger[row.key], false);
      const { openingVerifiedAt: _stamp, ...rest } = ledger[row.key];
      assert.deepEqual(rest, row);
    });

    it('keeps a confirmed row once its first emission has left the history read', () => {
      const row = confirmedRow();
      const confirmed = ingestHistory({ [row.key]: row }, [snap(generatedAt, [opening])], generatedAt + 5 * DAY_MS);
      const later = ingestHistory(confirmed, [snap(generatedAt + 9 * DAY_MS, [])], generatedAt + 9 * DAY_MS);
      assert.deepEqual(later[row.key].calibration, anchor);
      assert.equal('rescore' in later[row.key], false);
    });

    it('never rescores in a call that read no history', () => {
      const row = { ...confirmedRow(), probability: 0.7 };
      const ledger = ingestHistory({ [row.key]: row }, [], generatedAt + 5 * DAY_MS);
      assert.deepEqual(ledger[row.key], row);
    });
  });

  it('never rescores a VOID row', () => {
    const voided = base(T0, { status: 'resolved', outcome: 'VOID', probability: 0.7, firstSeenProbability: 0.4, resolvedAt: T0 + D + HOUR_MS, evidence: { reason: 'no_establishable_metric' } });
    const ledger = ingestHistory({ [voided.key]: voided }, HISTORY, NOW);
    assert.equal(ledger[voided.key].probability, 0.7);
    assert.equal('rescore' in ledger[voided.key], false);
  });

  it('leaves duplicates out of the card chips', () => {
    const open = base(T0 + 8 * DAY_MS, { status: 'pending', probability: 0.3, firstSeenProbability: 0.3, lastSeenAt: NOW });
    const ledger = ingestHistory({ ...legacy, [open.key]: open }, HISTORY, NOW);
    const chips = buildFamilyOutcomes(ledger, NOW);
    assert.ok(chips.length > 0);
    assert.equal(chips.some((chip) => chip.outcome === 'VOID'), false, 'the voided ghost is no earlier outcome of the family');
  });

  it('keeps rescored rows out of the calibration fit', () => {
    const ledger = ingestHistory(legacy, HISTORY, NOW);
    const cohortKeys = selectFitCohort(ledger, NOW).map((entry) => entry.key);
    assert.equal(cohortKeys.includes(keeper.key), false, 'the restored first-seen probability has no recorded raw value');
    assert.equal(cohortKeys.includes(otherQuestion.key), true);
  });
});

describe('bounded receipt re-archive (#8990, #8989)', () => {
  const R2_ENV = {
    CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'id',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    CLOUDFLARE_R2_BUCKET: 'bucket',
    CLOUDFLARE_R2_FORECAST_RESOLUTION_PREFIX: 'receipts',
  };
  const R2_WRITE_MS = 450;
  const FETCH_PHASE_MS = 150_000;
  const RUN_WORK_MS = 60_000;
  const ARCHIVED_AT = T0 + 8 * DAY_MS;

  function envelopeRow(index) {
    const generatedAt = T0 + index * 60_000;
    return {
      id: `fc-cyber-${index}`,
      key: `fc-cyber-${index}@${generatedAt + 7 * DAY_MS}`,
      domain: 'cyber',
      region: `Country ${index}`,
      title: `Cyber threat concentration: Country ${index}`,
      generationOrigin: 'legacy_detector',
      spec: { ...cyber(generatedAt, 5, 0.3).resolution, metricKey: `${CYBER_FEED}|count(country==Country ${index})` },
      generatedAt,
      deadline: generatedAt + 7 * DAY_MS,
      firstSeenAt: generatedAt,
      lastSeenAt: generatedAt,
      probability: 0.3,
      firstSeenProbability: 0.3,
      status: 'resolved',
      outcome: 'NO',
      resolvedAt: generatedAt + 7 * DAY_MS + HOUR_MS,
      evidence: { metricValue: 0 },
      receiptArchivedAt: ARCHIVED_AT,
      samples: { count: 0, recent: [] },
    };
  }

  it('rewrites at most the per-run cap inside the fetch budget and drains 600 corrections over later runs', async () => {
    let ledger = Object.fromEntries(Array.from({ length: 600 }, (_, index) => envelopeRow(index)).map((entry) => [entry.key, entry]));
    let now = T0 + 20 * DAY_MS;
    const runs = [];
    for (let run = 0; run < 20; run += 1) {
      ledger = processResolutionCycle(ledger, [], {}, now).ledger;
      let elapsedMs = 0;
      const queued = collectUnarchivedReceipts(ledger);
      const archived = await appendR2Receipts(queued, { env: R2_ENV, putObject: async () => { elapsedMs += R2_WRITE_MS; } });
      markReceiptsArchived(ledger, archived, now + 1);
      runs.push({ queued: queued.length, elapsedMs });
      if (!Object.values(ledger).some(receiptNeedsRearchive)) break;
      now += DAY_MS;
    }
    assert.ok(runs.every((run) => run.queued <= RECEIPT_REARCHIVE_PER_RUN));
    assert.ok(runs.every((run) => run.elapsedMs + RUN_WORK_MS <= FETCH_PHASE_MS), `slowest run ${Math.max(...runs.map((run) => run.elapsedMs))} ms`);
    assert.equal(runs.length, Math.ceil(600 / RECEIPT_REARCHIVE_PER_RUN), 'the backlog drains one cap per run');
    assert.equal(runs.reduce((sum, run) => sum + run.queued, 0), 600);
    assert.ok(Object.values(ledger).every((entry) => entry.evidence.reason === 'resolver_envelope_bug' && entry.receiptArchivedAt > entry.evidence.voidedAt));
  });

  it('voids envelope-bug rows before the correction, so none is rescored and then voided', () => {
    const row = { ...envelopeRow(0), probability: 0.5 };
    const ledger = ingestHistory({ [row.key]: row }, [snap(T0 + 20 * DAY_MS, [])], T0 + 20 * DAY_MS);
    assert.equal(ledger[row.key].evidence.reason, 'resolver_envelope_bug');
    assert.equal('rescore' in ledger[row.key], false);
  });

  it('never prunes a row whose corrected receipt has not been rewritten', () => {
    const corrected = ingestHistory({ a: envelopeRow(0), b: envelopeRow(1) }, [], T0 + 20 * DAY_MS);
    const [first] = Object.keys(corrected).sort();
    markReceiptsArchived(corrected, [{ key: first }], T0 + 20 * DAY_MS + 1);
    const pruned = pruneArchivedTerminalEntries(corrected, T0 + 400 * DAY_MS);
    assert.deepEqual(Object.keys(pruned), Object.keys(corrected).filter((key) => key !== first));
  });
});

describe('market-settlement bets (#8990)', () => {
  const SLUG = 'gemini-4pt0-released-by-june-30-2026';
  const ID = `market:${SLUG}`;
  const SETTLEMENT = 'prediction:markets-resolution:v1';
  const SEP_9 = Date.parse('2026-09-09T05:01:27Z');
  const VENUE_CLOSE = Date.parse('2026-10-01T03:59:00Z');
  const SYNTHETIC_CLOSE = Date.parse('2026-11-01T03:59:00Z');

  function settlementBet(generatedAt, deadline, probability, title) {
    return {
      id: ID,
      marketSlug: SLUG,
      marketSource: 'polymarket',
      domain: 'market',
      title,
      generationOrigin: 'bet_engine',
      probabilitySource: 'ensemble',
      baselineProbability: 0.4,
      probability,
      generatedAt,
      resolution: { kind: 'hard', metricKey: `${SETTLEMENT}|yesPrice(slug==${SLUG})`, operator: 'crosses', threshold: 50, baselineValue: 12.5, window: 'at-deadline', deadline, sourceFeed: SETTLEMENT, question: title },
    };
  }

  it('tracks the venue close on a pending window and never reopens the market after it moved before the emission', () => {
    let ledger = ingestHistory({}, [snap(SEP_9, [settlementBet(SEP_9, VENUE_CLOSE + 30 * DAY_MS, 0.25, 'Gemini 4.0 released by September 30, 2026?')])], SEP_9);
    const [opened] = windowsOf(ledger, ID);
    ledger = ingestHistory(ledger, [snap(SEP_9 + DAY_MS, [settlementBet(SEP_9 + DAY_MS, VENUE_CLOSE, 0.3, 'Gemini 4.0 released by September 30, 2026?')])], SEP_9 + DAY_MS);
    assert.equal(ledger[opened.key].deadline, VENUE_CLOSE, 'a pending settlement window follows the venue endDate');
    assert.equal(ledger[opened.key].spec.deadline, VENUE_CLOSE);

    Object.assign(ledger[opened.key], { status: 'resolved', outcome: 'NO', resolvedAt: VENUE_CLOSE + DAY_MS });
    const afterClose = Date.parse('2026-10-06T05:00:00Z');
    const reemitted = ingestHistory(ledger, [snap(afterClose, [settlementBet(afterClose, SYNTHETIC_CLOSE, 0.65, 'Gemini 4.0 released by October 31, 2026?')])], afterClose + HOUR_MS);
    assert.deepEqual(windowsOf(reemitted, ID).map((entry) => entry.key), [opened.key], 'the settled market is not scored again');
  });

  it('voids an existing window that reopened a market after its close', () => {
    const OCT_1 = Date.parse('2026-10-01T05:01:07Z');
    const first = ingestHistory({}, [snap(SEP_9, [settlementBet(SEP_9, VENUE_CLOSE, 0.25, 'Gemini 4.0 released by September 30, 2026?')])], SEP_9);
    const [keeper] = windowsOf(first, ID);
    const reopenedKey = `${ID}@${SYNTHETIC_CLOSE}`;
    const legacyLedger = {
      [keeper.key]: { ...keeper, status: 'resolved', outcome: 'NO', resolvedAt: Date.parse('2026-10-02T05:00:00Z'), evidence: { metricValue: 0 } },
      [reopenedKey]: { ...keeper, key: reopenedKey, generatedAt: OCT_1, firstSeenAt: OCT_1, lastSeenAt: OCT_1, probability: 0.4, firstSeenProbability: 0.4, deadline: VENUE_CLOSE, status: 'resolved', outcome: 'NO', resolvedAt: Date.parse('2026-10-03T05:00:00Z'), evidence: { metricValue: 0 } },
    };
    const ledger = ingestHistory(legacyLedger, [], Date.parse('2026-10-07T12:00:00Z'));
    assert.equal(ledger[reopenedKey].outcome, 'VOID');
    assert.equal(ledger[reopenedKey].duplicateOf, keeper.key);
    assert.equal(ledger[keeper.key].outcome, 'NO');
  });
});

