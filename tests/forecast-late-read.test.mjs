import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  __setCountFeedAvailableForTests,
  collectUnarchivedReceipts,
  ingestHistory,
  processResolutionCycleWithJudges,
  receiptNeedsRearchive,
} from '../scripts/seed-forecast-resolutions.mjs';
import { RECEIPT_VOID_REASON_LABELS, buildPublicReceipts } from '../scripts/_forecast-scorecard.mjs';
import { shapeResolutionFeeds } from '../scripts/_forecast-resolution-eval.mjs';
import { CONFLICT_COUNT_SOURCE_FEED } from '../scripts/_forecast-resolution.mjs';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const COMMODITY_FEED = 'market:commodities-bootstrap:v1';
const EIA_FEED = 'energy:eia-petroleum:v1';
const SETTLEMENT_FEED = 'prediction:markets-resolution:v1';
const BRENT = `${COMMODITY_FEED}|price(symbol==BZ=F)`;

const noJudges = {
  judgeModels: [
    async () => { throw new Error('no judged row is due in this test'); },
    async () => { throw new Error('no judged row is due in this test'); },
  ],
};

// The resolver's production call shape (buildLedgerForRun): an ingest that
// reads history, then the cycle, whose own ingest passes no history.
async function run(ledger, history, feeds, nowMs) {
  return processResolutionCycleWithJudges(ingestHistory(ledger, history, nowMs), [], feeds, [], nowMs, noJudges);
}

const snap = (generatedAt, predictions) => ({ generatedAt, predictions });
const at = (iso) => Date.parse(iso);

function bet(generatedAt, deadline, resolution, overrides = {}) {
  return {
    id: `bet:${resolution.metricKey}`,
    title: resolution.question,
    domain: 'market',
    region: '',
    generationOrigin: 'bet_engine',
    probabilitySource: 'ensemble',
    probability: 0.4,
    generatedAt,
    resolution: { kind: 'hard', operator: 'crosses', window: 'at-deadline', deadline, ...resolution },
    ...overrides,
  };
}

const brentBet = (generatedAt, deadline) => bet(generatedAt, deadline, {
  metricKey: BRENT, sourceFeed: COMMODITY_FEED, threshold: 90.3, baselineValue: 88.1,
  question: 'Will the Brent crude oil price rise to at least 90.3 USD/bbl?',
});
const eiaBet = (generatedAt, deadline) => bet(generatedAt, deadline, {
  metricKey: `${EIA_FEED}|value(metric==brent)`, sourceFeed: EIA_FEED, threshold: 90.3, baselineValue: 88.1,
  question: 'Will the EIA Brent spot price rise to at least 90.3?',
});
const SLUG = 'gemini-4pt0-released-by-june-30-2026';
const settlementBet = (generatedAt, deadline) => bet(generatedAt, deadline, {
  metricKey: `${SETTLEMENT_FEED}|yesPrice(slug==${SLUG})`, sourceFeed: SETTLEMENT_FEED, threshold: 50, baselineValue: 12.5,
  question: 'Gemini 4.0 released by June 30, 2026?',
}, { id: `market:${SLUG}` });

const brentFeed = (price, fetchedAt) => shapeResolutionFeeds({ [COMMODITY_FEED]: { _seed: { fetchedAt }, data: { quotes: [{ symbol: 'BZ=F', price }] } } });
const eiaFeed = (current, date) => shapeResolutionFeeds({ [EIA_FEED]: { brent: { current, date, unit: 'USD/bbl' } } });
const settlementFeed = (yesPrice, asOf) => shapeResolutionFeeds({ [SETTLEMENT_FEED]: { records: [{ slug: SLUG, yesPrice, asOf }] } });

const onlyRow = (ledger) => {
  const rows = Object.values(ledger).filter((entry) => !entry.parentKey);
  assert.equal(rows.length, 1);
  return rows[0];
};

// Opens a window and runs the daily cron (06:02 UTC, feed fetched ten minutes
// earlier) on each listed day before the deadline.
async function openWindow(prediction, days, feedFor) {
  const history = [snap(prediction.generatedAt, [prediction])];
  let ledger = {};
  for (const day of days) {
    const now = at(`${day}T06:02:00Z`);
    ({ ledger } = await run(ledger, history, feedFor(now - 10 * MINUTE_MS), now));
  }
  return { ledger, history };
}

describe('a live at-deadline read more than one resolver cycle late (#8990)', () => {
  // Deadline 07-19 05:00; the resolver runs daily at about 06:02.
  const EMIT = at('2026-07-15T05:00:00Z');
  const DEADLINE = at('2026-07-19T05:00:00Z');
  const pendingRuns = ['2026-07-16', '2026-07-17', '2026-07-18'];

  it('seals VOID late_read instead of grading the price read after a missed run', async () => {
    const { ledger, history } = await openWindow(brentBet(EMIT, DEADLINE), pendingRuns, (fetchedAt) => brentFeed(88, fetchedAt));
    // The 07-19 run is missed. The next one reads 78.68 at 25h01m past the deadline.
    const now = at('2026-07-20T06:02:00Z');
    const result = await run(ledger, history, brentFeed(78.68, at('2026-07-20T06:01:00Z')), now);
    const row = onlyRow(result.ledger);
    assert.equal(row.outcome, 'VOID', `graded ${row.outcome} on a reading 25h01m after the deadline`);
    assert.equal(row.evidence.reason, 'late_read');
    assert.equal(result.scorecard.totals.scored, 0);
  });

  it('grades the next run\'s reading when the deadline fell just after a run', async () => {
    const emit = at('2026-07-15T06:03:00Z');
    const deadline = at('2026-07-19T06:03:00Z');
    const { ledger, history } = await openWindow(brentBet(emit, deadline), [...pendingRuns, '2026-07-19'], (fetchedAt) => brentFeed(88, fetchedAt));
    assert.equal(onlyRow(ledger).status, 'pending', 'the 07-19 run started a minute before the deadline');
    // Cron jitter: the next run starts at 06:04:05 and reads a quote fetched 24h01m after the deadline.
    const now = at('2026-07-20T06:04:05Z');
    const result = await run(ledger, history, brentFeed(91.87, at('2026-07-20T06:04:00Z')), now);
    const row = onlyRow(result.ledger);
    assert.equal(row.outcome, 'YES');
    assert.equal(row.evidence.metricValue, 91.87);
  });

  it('never grades a quote fetched before the deadline, even on the deadline day', async () => {
    const emit = at('2026-07-15T06:01:00Z');
    const deadline = at('2026-07-19T06:01:00Z');
    const { ledger, history } = await openWindow(brentBet(emit, deadline), [...pendingRuns, '2026-07-19'], (fetchedAt) => brentFeed(88, fetchedAt));
    assert.equal(onlyRow(ledger).status, 'pending', 'the 07-19 06:02 run read a quote fetched at 05:52, before the 06:01 deadline');
    const result = await run(ledger, history, brentFeed(91.87, at('2026-07-20T05:52:00Z')), at('2026-07-20T06:02:00Z'));
    const row = onlyRow(result.ledger);
    assert.equal(row.outcome, 'YES');
    assert.equal(row.evidence.readTs, at('2026-07-20T05:52:00Z'));
  });

  it('keeps grading a period feed whose reading is dated by its own observation date', async () => {
    const { ledger, history } = await openWindow(eiaBet(EMIT, DEADLINE), pendingRuns, () => eiaFeed(88, '2026-07-10'));
    let state = ledger;
    for (const day of ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25']) {
      ({ ledger: state } = await run(state, history, eiaFeed(88, '2026-07-17'), at(`${day}T06:02:00Z`)));
      assert.equal(onlyRow(state).status, 'pending', `EIA has not published the deadline week on ${day}`);
    }
    // The week covering the deadline publishes a week later.
    const result = await run(state, history, eiaFeed(91.2, '2026-07-24'), at('2026-07-26T06:02:00Z'));
    assert.equal(onlyRow(result.ledger).outcome, 'YES');
  });

  it('keeps grading a market settlement adjudicated days after the deadline', async () => {
    const { ledger, history } = await openWindow(settlementBet(EMIT, DEADLINE), pendingRuns, () => shapeResolutionFeeds({ [SETTLEMENT_FEED]: { records: [] } }));
    const result = await run(ledger, history, settlementFeed(100, '2026-07-28T00:00:00Z'), at('2026-07-29T06:02:00Z'));
    assert.equal(onlyRow(result.ledger).outcome, 'YES');
  });
});

describe('a GPS-jamming read: one snapshot per UTC day, published a day later (#8990)', () => {
  // seed-gpsjam runs every 8h and day D's snapshot first lands at its 08:00
  // tick on D+1, so the 06:00 resolver run on day X holds the snapshot dated
  // X-2. Records are given pre-shaped: one per zone, dated by the snapshot day.
  const GPS_FEED = 'intelligence:gpsjam:v2';
  const ZONE = 'Baltic Sea';
  const countOn = (day) => 300 + Number(day.slice(8, 10));
  const gpsFeed = (day) => ({ [GPS_FEED]: [{ region: ZONE, hexCount: countOn(day), asOf: day }] });
  const dayBefore = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
  const gpsForecast = (generatedAt, deadline) => ({
    id: 'fc-gps-baltic',
    domain: 'military',
    region: ZONE,
    title: 'GPS interference in Baltic Sea shipping zone',
    probability: 0.5,
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    generatedAt,
    resolution: { kind: 'hard', metricKey: `${GPS_FEED}|hexCount(region==${ZONE})`, operator: '>=', threshold: 310, window: 'at-deadline', deadline, sourceFeed: GPS_FEED },
  });

  async function runDays(deadline, days, snapshotFor) {
    const forecast = gpsForecast(deadline - 7 * DAY_MS, deadline);
    const history = [snap(forecast.generatedAt, [forecast])];
    let ledger = {};
    let result;
    for (const day of days) {
      result = await run(ledger, history, snapshotFor(day), at(`${day}T06:02:00Z`));
      ledger = result.ledger;
    }
    return onlyRow(ledger);
  }
  const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));

  for (const hour of ['03:00', '10:03', '18:02']) {
    it(`grades a deadline at ${hour} on the snapshot dated the deadline day`, async () => {
      const row = await runDays(at(`2026-07-19T${hour}:00Z`), days('2026-07-13', 9), (day) => gpsFeed(dayBefore(day, 2)));
      assert.equal(row.status, 'resolved');
      assert.equal(row.evidence.metricValue, countOn('2026-07-19'), 'read the 07-19 snapshot, first held by the 07-21 run');
      assert.equal(row.evidence.readTs, at('2026-07-19T00:00:00Z'));
      assert.equal(row.outcome, 'YES');
    });
  }

  it('waits for a deadline-day snapshot published a cycle late', async () => {
    const lagged = (day) => gpsFeed(dayBefore(day, day >= '2026-07-21' ? 3 : 2));
    const row = await runDays(at('2026-07-19T03:00:00Z'), days('2026-07-13', 10), lagged);
    assert.equal(row.evidence.metricValue, countOn('2026-07-19'), 'the 07-22 run reads the 07-19 snapshot');
  });

  it('seals VOID once the deadline-day snapshot is past the bound', async () => {
    const stuck = (day) => gpsFeed(day <= '2026-07-20' ? dayBefore(day, 2) : '2026-07-18');
    const waiting = await runDays(at('2026-07-19T03:00:00Z'), days('2026-07-13', 10), stuck);
    assert.equal(waiting.status, 'pending', 'the 07-22 run is inside the bound');
    const row = await runDays(at('2026-07-19T03:00:00Z'), days('2026-07-13', 11), stuck);
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'value_source_never_settled');
  });

  it('seals VOID late_read when a later snapshot replaced the deadline day before it was read', async () => {
    const skipped = (day) => gpsFeed(day === '2026-07-21' ? '2026-07-20' : dayBefore(day, 2));
    const row = await runDays(at('2026-07-19T03:00:00Z'), days('2026-07-13', 9), skipped);
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'late_read');
  });

  it('seals VOID feed_unavailable when the feed stays down past the bound', async () => {
    const down = (day) => (day >= '2026-07-19' ? {} : gpsFeed(dayBefore(day, 2)));
    const waiting = await runDays(at('2026-07-19T03:00:00Z'), days('2026-07-13', 10), down);
    assert.equal(waiting.status, 'pending');
    const row = await runDays(at('2026-07-19T03:00:00Z'), days('2026-07-13', 11), down);
    assert.equal(row.evidence.reason, 'feed_unavailable');
  });
});

describe('a feed that never comes back (#8990)', () => {
  const EMIT = at('2026-07-15T05:00:00Z');
  const DEADLINE = at('2026-07-19T05:00:00Z');

  afterEach(() => __setCountFeedAvailableForTests(CONFLICT_COUNT_SOURCE_FEED, undefined));

  it('seals a live read VOID feed_unavailable once the read can no longer be on time', async () => {
    const { ledger, history } = await openWindow(brentBet(EMIT, DEADLINE), ['2026-07-16', '2026-07-17', '2026-07-18'], (fetchedAt) => brentFeed(88, fetchedAt));
    const missed = await run(ledger, history, {}, at('2026-07-19T06:02:00Z'));
    assert.equal(onlyRow(missed.ledger).status, 'pending');
    const result = await run(missed.ledger, history, {}, at('2026-07-20T06:02:00Z'));
    const row = onlyRow(result.ledger);
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'feed_unavailable');
  });

  it('waits out a period feed\'s settlement grace, then seals VOID feed_unavailable', async () => {
    const { ledger, history } = await openWindow(eiaBet(EMIT, DEADLINE), ['2026-07-16'], () => eiaFeed(88, '2026-07-10'));
    const waiting = await run(ledger, history, {}, at('2026-08-02T04:00:00Z'));
    assert.equal(onlyRow(waiting.ledger).status, 'pending', 'inside the 14-day EIA grace');
    const result = await run(waiting.ledger, history, {}, at('2026-08-02T06:02:00Z'));
    assert.equal(onlyRow(result.ledger).evidence.reason, 'feed_unavailable');
  });

  it('waits out a settlement feed\'s grace, then seals VOID feed_unavailable', async () => {
    const { ledger, history } = await openWindow(settlementBet(EMIT, DEADLINE), ['2026-07-16'], () => shapeResolutionFeeds({ [SETTLEMENT_FEED]: { records: [] } }));
    const waiting = await run(ledger, history, {}, at('2026-08-02T04:00:00Z'));
    assert.equal(onlyRow(waiting.ledger).status, 'pending');
    const result = await run(waiting.ledger, history, {}, at('2026-08-02T06:02:00Z'));
    assert.equal(onlyRow(result.ledger).evidence.reason, 'feed_unavailable');
  });

  it('bounds a count read the same way: settlement lag plus the scalar grace', async () => {
    __setCountFeedAvailableForTests(CONFLICT_COUNT_SOURCE_FEED, true);
    const conflict = {
      id: 'fc-conflict-sd',
      domain: 'conflict',
      region: 'Sudan',
      title: 'Escalation risk: Sudan',
      probability: 0.4,
      timeHorizon: '7d',
      generationOrigin: 'legacy_detector',
      generatedAt: EMIT,
      resolution: { kind: 'hard', metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Sudan)`, operator: '>=', threshold: 12, window: 'within-horizon', deadline: DEADLINE, sourceFeed: CONFLICT_COUNT_SOURCE_FEED },
    };
    const history = [snap(EMIT, [conflict])];
    const opened = await run({}, history, {}, EMIT + HOUR_MS);
    const waiting = await run(opened.ledger, history, {}, DEADLINE + 12 * DAY_MS - HOUR_MS);
    assert.equal(onlyRow(waiting.ledger).status, 'pending', 'inside the 2-day ACLED lag plus 10-day grace');
    const result = await run(waiting.ledger, history, {}, DEADLINE + 12 * DAY_MS + HOUR_MS);
    assert.equal(onlyRow(result.ledger).evidence.reason, 'feed_unavailable');
  });
});

describe('rows already graded on a late read (#8990)', () => {
  // The audit's example: graded NO at 78.68 on 08-05, while another Brent
  // window sampled 91.87 at 07-22T06:00, 56 minutes after this deadline.
  const DEADLINE = 1784696647319;
  const LATE_READ_TS = 1785909633767;
  const RESOLVED_AT = 1785909816578;
  const ARCHIVED_AT = 1785909848495;
  const TIMELY_TS = at('2026-07-22T06:00:00Z');
  const NOW = at('2026-10-08T06:02:00Z');
  const HISTORY = [snap(NOW, [])];

  const row = (key, deadline, threshold, baselineValue, extra) => ({
    id: 'commodity:BZ=F:the Brent crude oil price',
    key,
    domain: 'market',
    region: '',
    title: `The Brent crude oil price: ${threshold >= baselineValue ? 'rise' : 'fall'} to ${threshold} USD/bbl?`,
    generationOrigin: 'bet_engine',
    spec: { kind: 'hard', metricKey: BRENT, operator: 'crosses', threshold, baselineValue, window: 'at-deadline', deadline, sourceFeed: COMMODITY_FEED, question: `Will Brent reach ${threshold}?` },
    probability: 0.4,
    firstSeenProbability: 0.4,
    generatedAt: deadline - 4 * DAY_MS,
    firstSeenAt: deadline - 4 * DAY_MS,
    lastSeenAt: deadline - HOUR_MS,
    deadline,
    status: 'resolved',
    ...extra,
  });
  const late = row(`commodity:BZ=F:the Brent crude oil price@${DEADLINE}`, DEADLINE, 90.3, 88.1, {
    samples: { count: 1, recent: [{ ts: LATE_READ_TS, value: 78.68 }] },
    outcome: 'NO',
    resolvedAt: RESOLVED_AT,
    sealedAt: RESOLVED_AT,
    evidence: { metricValue: 78.68, comparison: '78.68 crosses 90.3 from 88.1', metricKey: BRENT, resolvedAt: RESOLVED_AT, readTs: LATE_READ_TS },
    receiptArchivedAt: ARCHIVED_AT,
  });
  const witnessDeadline = DEADLINE - 2 * HOUR_MS;
  const witness = row(`commodity:BZ=F:the Brent crude oil price@${witnessDeadline}`, witnessDeadline, 95, 88.1, {
    samples: { count: 2, recent: [{ ts: TIMELY_TS - DAY_MS, value: 88.4 }, { ts: TIMELY_TS, value: 91.87 }] },
    outcome: 'NO',
    resolvedAt: TIMELY_TS + 3 * MINUTE_MS,
    evidence: { metricValue: 91.87, metricKey: BRENT, resolvedAt: TIMELY_TS + 3 * MINUTE_MS, readTs: TIMELY_TS },
    receiptArchivedAt: TIMELY_TS + 4 * MINUTE_MS,
  });
  const orphanDeadline = at('2026-09-01T05:00:00Z');
  const orphan = row(`commodity:BZ=F:the Brent crude oil price@${orphanDeadline}`, orphanDeadline, 70, 75, {
    samples: { count: 1, recent: [{ ts: orphanDeadline + 4 * DAY_MS, value: 69 }] },
    outcome: 'YES',
    resolvedAt: orphanDeadline + 4 * DAY_MS + MINUTE_MS,
    evidence: { metricValue: 69, metricKey: BRENT, resolvedAt: orphanDeadline + 4 * DAY_MS + MINUTE_MS, readTs: orphanDeadline + 4 * DAY_MS },
    receiptArchivedAt: orphanDeadline + 4 * DAY_MS + 2 * MINUTE_MS,
  });
  const eiaDeadline = at('2026-09-01T05:00:00Z');
  const eiaLate = {
    ...row(`bet:eia@${eiaDeadline}`, eiaDeadline, 90, 85, {
      outcome: 'YES',
      resolvedAt: eiaDeadline + 10 * DAY_MS,
      evidence: { metricValue: 91, readTs: eiaDeadline + 7 * DAY_MS, resolvedAt: eiaDeadline + 10 * DAY_MS },
      receiptArchivedAt: eiaDeadline + 10 * DAY_MS + MINUTE_MS,
    }),
    id: 'bet:eia',
    spec: { kind: 'hard', metricKey: `${EIA_FEED}|value(metric==brent)`, operator: 'crosses', threshold: 90, baselineValue: 85, window: 'at-deadline', deadline: eiaDeadline, sourceFeed: EIA_FEED, question: 'EIA Brent to 90?' },
  };
  const legacy = Object.fromEntries([late, witness, orphan, eiaLate].map((entry) => [entry.key, entry]));

  it('re-grades on the ledger\'s first reading after the deadline and keeps what it replaced', async () => {
    const { ledger } = await run(legacy, HISTORY, {}, NOW);
    const corrected = ledger[late.key];
    assert.equal(corrected.outcome, 'YES', 'the first reading after the deadline was 91.87');
    assert.equal(corrected.evidence.metricValue, 91.87);
    assert.equal(corrected.evidence.readTs, TIMELY_TS);
    assert.equal(corrected.evidence.supersededOutcome, 'NO');
    assert.equal(corrected.evidence.supersededEvidence.metricValue, 78.68);
    assert.equal(corrected.evidence.regradedAt, NOW);
    assert.equal(corrected.resolvedAt, RESOLVED_AT, 'the row stays in the same rolling window');
    assert.equal(receiptNeedsRearchive(corrected), true);
  });

  it('voids a late row the ledger holds no on-time reading for', async () => {
    const { ledger } = await run(legacy, HISTORY, {}, NOW);
    const voided = ledger[orphan.key];
    assert.equal(voided.outcome, 'VOID');
    assert.equal(voided.evidence.reason, 'late_read');
    assert.equal(voided.evidence.supersededOutcome, 'YES');
    assert.equal(voided.evidence.voidedAt, NOW);
    assert.equal(receiptNeedsRearchive(voided), true);
    const [receipt] = buildPublicReceipts({ [orphan.key]: { ...voided, generationOrigin: 'legacy_detector' } }, NOW);
    assert.equal(receipt.voidReason, 'late_read', 'a published row names the reason on its receipt');
  });

  it('leaves on-time reads and period feeds alone', async () => {
    const { ledger } = await run(legacy, HISTORY, {}, NOW);
    assert.deepEqual(ledger[witness.key], { ...witness });
    assert.deepEqual(ledger[eiaLate.key], { ...eiaLate });
  });

  it('is idempotent and queues each corrected receipt for re-archive once', async () => {
    const first = await run(legacy, HISTORY, {}, NOW);
    const second = await run(first.ledger, HISTORY, {}, NOW + DAY_MS);
    assert.deepEqual(second.ledger, first.ledger);
    const queued = collectUnarchivedReceipts(second.ledger).map((receipt) => receipt.key).sort();
    assert.deepEqual(queued, [late.key, orphan.key].sort());
  });

  it('labels the new reasons in plain words', () => {
    assert.equal(typeof RECEIPT_VOID_REASON_LABELS.late_read, 'string');
    assert.equal(typeof RECEIPT_VOID_REASON_LABELS.feed_unavailable, 'string');
  });
});
