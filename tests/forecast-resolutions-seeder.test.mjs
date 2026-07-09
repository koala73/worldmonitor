import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  RESOLUTIONS_KEY,
  SCORECARD_META_KEY,
  SCORECARD_KEY,
  LEDGER_RETENTION_WINDOW_DAYS,
  appendSample,
  appendR2Receipts,
  collectUnarchivedReceipts,
  declareRecords,
  markReceiptsArchived,
  processResolutionCycle,
  pruneArchivedTerminalEntries,
} from '../scripts/seed-forecast-resolutions.mjs';
import { computeScorecard } from '../scripts/_forecast-scorecard.mjs';
import { CONFLICT_COUNT_SOURCE_FEED, UNREST_COUNT_SOURCE_FEED } from '../scripts/_forecast-resolution.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-07-07T00:00:00Z');

function forecast(overrides = {}) {
  const generatedAt = overrides.generatedAt ?? T0;
  const deadline = overrides.deadline ?? generatedAt + DAY_MS;
  const resolution = overrides.resolution ?? {
    kind: 'hard',
    metricKey: 'supply_chain:chokepoints:v4|riskScore(route==Strait of Hormuz)',
    operator: '>=',
    threshold: 60,
    window: 'at-deadline',
    deadline,
    sourceFeed: 'supply_chain:chokepoints:v4',
  };
  return {
    id: 'fc-hormuz',
    domain: 'supply_chain',
    region: 'Strait of Hormuz',
    title: 'Hormuz disruption risk rises',
    probability: 0.62,
    confidence: 0.7,
    timeHorizon: '24h',
    generationOrigin: 'detector',
    generatedAt,
    calibration: { marketPrice: 55 },
    resolution,
    ...overrides,
  };
}

function snapshot(generatedAt, predictions) {
  return { generatedAt, predictions };
}

describe('processResolutionCycle', () => {
  it('pre-registers one open window, updates probability only before deadline, and rolls over after deadline', () => {
    const first = forecast({ probability: 0.6, generatedAt: T0, deadline: T0 + DAY_MS });
    const second = forecast({
      probability: 0.72,
      generatedAt: T0 + 6 * 60 * 60 * 1000,
      deadline: T0 + DAY_MS + 6 * 60 * 60 * 1000,
      resolution: { ...first.resolution, threshold: 70, deadline: T0 + DAY_MS + 6 * 60 * 60 * 1000 },
    });
    const third = forecast({
      probability: 0.4,
      generatedAt: T0 + DAY_MS,
      deadline: T0 + 2 * DAY_MS,
      resolution: { ...first.resolution, threshold: 80, deadline: T0 + 2 * DAY_MS },
    });

    const { ledger } = processResolutionCycle({}, [
      snapshot(T0, [first]),
      snapshot(T0 + 6 * 60 * 60 * 1000, [second]),
      snapshot(T0 + DAY_MS, [third]),
    ], {
      'supply_chain:chokepoints:v4': { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 61 }] },
    }, T0 + 12 * 60 * 60 * 1000);

    assert.deepEqual(Object.keys(ledger).sort(), [`fc-hormuz@${T0 + DAY_MS}`, `fc-hormuz@${T0 + 2 * DAY_MS}`]);
    const open = ledger[`fc-hormuz@${T0 + DAY_MS}`];
    assert.equal(open.firstSeenProbability, 0.6);
    assert.equal(open.probability, 0.72);
    assert.equal(open.spec.threshold, 60, 'pre-deadline snapshots must not mutate the frozen spec');
    assert.equal(open.deadline, T0 + DAY_MS);
    assert.equal(ledger[`fc-hormuz@${T0 + 2 * DAY_MS}`].probability, 0.4);
  });

  it('skips unspeced forecasts, marks judged specs pending-judge, samples hard specs, and resolves terminal entries once', () => {
    const hard = forecast({ deadline: T0 + DAY_MS });
    const judged = forecast({
      id: 'fc-judge',
      domain: 'political',
      resolution: {
        kind: 'judged',
        deadline: T0 + DAY_MS,
        question: 'Will the policy change happen?',
      },
    });
    const unspeced = forecast({ id: 'fc-unspeced' });
    delete unspeced.resolution;

    const first = processResolutionCycle({}, [snapshot(T0, [hard, judged, unspeced])], {
      'supply_chain:chokepoints:v4': { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 61 }] },
    }, T0 + DAY_MS);

    assert.ok(first.ledger[`fc-hormuz@${T0 + DAY_MS}`]);
    assert.equal(first.ledger[`fc-judge@${T0 + DAY_MS}`].status, 'pending-judge');
    assert.ok(!Object.keys(first.ledger).some((key) => key.startsWith('fc-unspeced')));
    assert.equal(first.ledger[`fc-hormuz@${T0 + DAY_MS}`].status, 'resolved');
    assert.equal(first.ledger[`fc-hormuz@${T0 + DAY_MS}`].outcome, 'YES');
    assert.equal(first.receipts.length, 1);

    const second = processResolutionCycle(first.ledger, [snapshot(T0, [hard])], {
      'supply_chain:chokepoints:v4': { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 5 }] },
    }, T0 + DAY_MS + 1);

    assert.deepEqual(second.ledger[`fc-hormuz@${T0 + DAY_MS}`], first.ledger[`fc-hormuz@${T0 + DAY_MS}`]);
    assert.equal(second.receipts.length, 0);
    assert.deepEqual(second.ledger, first.ledger, 'idempotent rerun with terminal entry should be byte-identical');
  });

  it('keeps count entries unsampled and pending until the UCDP settlement lag', () => {
    const countForecast = forecast({
      id: 'fc-mali',
      domain: 'conflict',
      region: 'Mali',
      resolution: {
        kind: 'hard',
        metricKey: 'conflict:ucdp-events:v1|count(country==Mali)',
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline: T0 + DAY_MS,
        sourceFeed: 'conflict:ucdp-events:v1',
      },
    });

    const { ledger } = processResolutionCycle({}, [snapshot(T0, [countForecast])], {
      'conflict:ucdp-events:v1': { events: [{ country: 'Mali', date_start: '2026-07-07' }] },
    }, T0 + DAY_MS);

    const row = ledger[`fc-mali@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending');
    assert.equal(row.samples.count, 0);
  });

  it('keeps due count entries pending when the source feed is unavailable', () => {
    const countForecast = forecast({
      id: 'fc-mali',
      domain: 'conflict',
      region: 'Mali',
      resolution: {
        kind: 'hard',
        metricKey: 'conflict:ucdp-events:v1|count(country==Mali)',
        operator: '>=',
        threshold: 1,
        window: 'within-horizon',
        deadline: T0 + DAY_MS,
        sourceFeed: 'conflict:ucdp-events:v1',
      },
    });

    const { ledger, receipts } = processResolutionCycle({}, [snapshot(T0, [countForecast])], {}, T0 + 16 * DAY_MS);

    const row = ledger[`fc-mali@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending');
    assert.equal(row.outcome, undefined);
    assert.equal(receipts.length, 0);
  });

  it('migrates already-open ACLED/unrest count entries from display feeds to resolution feeds', () => {
    const deadline = T0 + DAY_MS;
    const oldLedger = {
      [`fc-mali@${deadline}`]: {
        id: 'fc-mali',
        key: `fc-mali@${deadline}`,
        domain: 'conflict',
        region: 'Mali',
        title: 'Conflict events in Mali stay below threshold',
        timeHorizon: '24h',
        generationOrigin: 'detector',
        spec: {
          kind: 'hard',
          metricKey: 'conflict:acled:v1:all:0:0|count(country==Mali)',
          operator: '>=',
          threshold: 2,
          window: 'within-horizon',
          deadline,
          sourceFeed: 'conflict:acled:v1:all:0:0',
        },
        probability: 0.52,
        firstSeenProbability: 0.52,
        generatedAt: T0,
        deadline,
        firstSeenAt: T0,
        lastSeenAt: T0,
        status: 'pending',
        samples: { count: 0, recent: [] },
      },
      [`fc-venezuela@${deadline}`]: {
        id: 'fc-venezuela',
        key: `fc-venezuela@${deadline}`,
        domain: 'political',
        region: 'Venezuela',
        title: 'Protests in Venezuela stay below threshold',
        timeHorizon: '24h',
        generationOrigin: 'detector',
        spec: {
          kind: 'hard',
          metricKey: 'unrest:events:v1|count(country==Venezuela)',
          operator: '>=',
          threshold: 2,
          window: 'within-horizon',
          deadline,
          sourceFeed: 'unrest:events:v1',
        },
        probability: 0.55,
        firstSeenProbability: 0.55,
        generatedAt: T0,
        deadline,
        firstSeenAt: T0,
        lastSeenAt: T0,
        status: 'pending',
        samples: { count: 0, recent: [] },
      },
    };

    const { ledger, receipts } = processResolutionCycle(oldLedger, [], {
      [CONFLICT_COUNT_SOURCE_FEED]: {
        events: [
          { country: 'Ghana', occurredAt: T0 - DAY_MS },
          { country: 'Mali', occurredAt: T0 + 2 * 60 * 60 * 1000 },
          { country: 'Burkina Faso', occurredAt: deadline },
        ],
      },
      [UNREST_COUNT_SOURCE_FEED]: {
        events: [
          { country: 'Colombia', occurredAt: T0 - DAY_MS },
          { country: 'Venezuela', occurredAt: T0 + 3 * 60 * 60 * 1000 },
          { country: 'Ecuador', occurredAt: deadline },
        ],
      },
    }, deadline + 3 * DAY_MS);

    const conflictRow = ledger[`fc-mali@${deadline}`];
    assert.equal(conflictRow.spec.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
    assert.equal(conflictRow.spec.metricKey, `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Mali)`);
    assert.equal(conflictRow.status, 'resolved');
    assert.equal(conflictRow.outcome, 'NO');
    assert.equal(conflictRow.evidence.metricValue, 1);

    const unrestRow = ledger[`fc-venezuela@${deadline}`];
    assert.equal(unrestRow.spec.sourceFeed, UNREST_COUNT_SOURCE_FEED);
    assert.equal(unrestRow.spec.metricKey, `${UNREST_COUNT_SOURCE_FEED}|count(country==Venezuela)`);
    assert.equal(unrestRow.status, 'resolved');
    assert.equal(unrestRow.outcome, 'NO');
    assert.equal(unrestRow.evidence.metricValue, 1);
    assert.equal(receipts.length, 2);
  });

  it('migrates old-key count specs first ingested from history snapshots', () => {
    const deadline = T0 + DAY_MS;
    const conflict = forecast({
      id: 'fc-mali',
      domain: 'conflict',
      region: 'Mali',
      title: 'Conflict events in Mali stay below threshold',
      deadline,
      resolution: {
        kind: 'hard',
        metricKey: 'conflict:acled:v1:all:0:0|count(country==Mali)',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:acled:v1:all:0:0',
      },
    });
    const unrest = forecast({
      id: 'fc-venezuela',
      domain: 'political',
      region: 'Venezuela',
      title: 'Protests in Venezuela stay below threshold',
      deadline,
      resolution: {
        kind: 'hard',
        metricKey: 'unrest:events:v1|count(country==Venezuela)',
        operator: '>=',
        threshold: 2,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'unrest:events:v1',
      },
    });

    const { ledger, receipts } = processResolutionCycle({}, [snapshot(T0, [conflict, unrest])], {
      [CONFLICT_COUNT_SOURCE_FEED]: {
        events: [
          { country: 'Ghana', occurredAt: T0 - DAY_MS },
          { country: 'Mali', occurredAt: T0 + 2 * 60 * 60 * 1000 },
          { country: 'Burkina Faso', occurredAt: deadline },
        ],
      },
      [UNREST_COUNT_SOURCE_FEED]: {
        events: [
          { country: 'Colombia', occurredAt: T0 - DAY_MS },
          { country: 'Venezuela', occurredAt: T0 + 3 * 60 * 60 * 1000 },
          { country: 'Ecuador', occurredAt: deadline },
        ],
      },
    }, deadline + 3 * DAY_MS);

    assert.equal(ledger[`fc-mali@${deadline}`].spec.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
    assert.equal(ledger[`fc-mali@${deadline}`].spec.metricKey, `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Mali)`);
    assert.equal(ledger[`fc-mali@${deadline}`].status, 'resolved');
    assert.equal(ledger[`fc-mali@${deadline}`].outcome, 'NO');
    assert.equal(ledger[`fc-venezuela@${deadline}`].spec.sourceFeed, UNREST_COUNT_SOURCE_FEED);
    assert.equal(ledger[`fc-venezuela@${deadline}`].spec.metricKey, `${UNREST_COUNT_SOURCE_FEED}|count(country==Venezuela)`);
    assert.equal(ledger[`fc-venezuela@${deadline}`].status, 'resolved');
    assert.equal(ledger[`fc-venezuela@${deadline}`].outcome, 'NO');
    assert.equal(receipts.length, 2);
  });

  it('does not resolve stale UCDP count snapshots to NO after the settlement lag', () => {
    const deadline = T0 + 30 * DAY_MS;
    const countForecast = forecast({
      id: 'fc-ukraine',
      domain: 'conflict',
      region: 'Ukraine',
      timeHorizon: '30d',
      deadline,
      resolution: {
        kind: 'hard',
        metricKey: 'conflict:ucdp-events:v1|count(country==Ukraine)',
        operator: '>=',
        threshold: 66,
        window: 'within-horizon',
        deadline,
        sourceFeed: 'conflict:ucdp-events:v1',
      },
    });

    const { ledger, receipts, scorecard } = processResolutionCycle({}, [snapshot(T0, [countForecast])], {
      'conflict:ucdp-events:v1': {
        events: [
          { country: 'Ukraine', dateStart: Date.parse('2025-11-20T00:00:00Z') },
          { country: 'Ukraine', dateStart: Date.parse('2025-12-18T00:00:00Z') },
        ],
      },
    }, deadline + 14 * DAY_MS);

    const row = ledger[`fc-ukraine@${deadline}`];
    assert.equal(row.status, 'pending');
    assert.equal(row.outcome, undefined);
    assert.equal(row.samples.count, 0);
    assert.equal(receipts.length, 0);
    assert.equal(scorecard.totals.pending, 1);
    assert.equal(scorecard.totals.scored, 0);
  });

  it('records feed-read gaps as error samples and computes a scorecard', () => {
    const pending = forecast({ deadline: T0 + 7 * DAY_MS });
    const { ledger, scorecard } = processResolutionCycle({}, [snapshot(T0, [pending])], {}, T0 + DAY_MS);

    const row = ledger[`fc-hormuz@${T0 + 7 * DAY_MS}`];
    assert.equal(row.samples.count, 1);
    assert.match(row.samples.recent[0].error, /missing_feed/);
    assert.equal(scorecard.totals.entries, 1);
    assert.equal(scorecard.totals.pending, 1);
  });

  it('samples the first live feed read after a point-window deadline before resolving', () => {
    const point = forecast({
      resolution: {
        kind: 'hard',
        metricKey: 'prediction:markets-bootstrap:v1|yesPrice(market==Will the Fed cut rates in July 2026?)',
        operator: 'crosses',
        threshold: 50,
        baselineValue: 72,
        window: 'at-endDate',
        deadline: T0 + DAY_MS,
        sourceFeed: 'prediction:markets-bootstrap:v1',
      },
      deadline: T0 + DAY_MS,
      title: 'Will the Fed cut rates in July 2026?',
    });

    const { ledger, receipts } = processResolutionCycle({}, [snapshot(T0, [point])], {
      'prediction:markets-bootstrap:v1': {
        markets: [{ market: 'Will the Fed cut rates in July 2026?', yesPrice: 98 }],
      },
    }, T0 + DAY_MS + 10);

    const row = ledger[`fc-hormuz@${T0 + DAY_MS}`];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'YES');
    assert.equal(row.samples.recent.at(-1).ts, T0 + DAY_MS + 10);
    assert.equal(row.evidence.metricValue, 98);
    assert.equal(receipts.length, 1);
  });
});

describe('appendSample and seed contract', () => {
  it('caps recent samples and does not duplicate the same tick', () => {
    let samples = { count: 0, recent: [] };
    for (let i = 0; i < 45; i += 1) samples = appendSample(samples, { ts: T0 + i, value: i });
    samples = appendSample(samples, { ts: T0 + 44, value: 999 });

    assert.equal(samples.count, 45);
    assert.equal(samples.recent.length, 40);
    assert.equal(samples.recent.at(-1).value, 44);
    assert.equal(samples.min, 0);
    assert.equal(samples.max, 44);
  });

  it('exports stable Redis keys and record-count declaration', () => {
    assert.equal(RESOLUTIONS_KEY, 'forecast:resolutions:v1');
    assert.equal(SCORECARD_KEY, 'forecast:scorecard:v1');
    assert.equal(SCORECARD_META_KEY, 'seed-meta:forecast:scorecard');
    assert.equal(declareRecords({ a: {}, b: {} }), 2);
  });

  it('keeps terminal receipts retryable until R2 archival is marked successful', () => {
    const ledger = {
      'a@1': {
        key: 'a@1',
        status: 'resolved',
        outcome: 'YES',
        resolvedAt: T0,
      },
      'b@1': {
        key: 'b@1',
        status: 'resolved',
        outcome: 'NO',
        resolvedAt: T0,
        receiptArchivedAt: T0 + 1,
      },
      'c@1': {
        key: 'c@1',
        status: 'pending',
      },
    };

    const receipts = collectUnarchivedReceipts(ledger);
    assert.deepEqual(receipts.map((receipt) => receipt.key), ['a@1']);

    markReceiptsArchived(ledger, [{ key: 'a@1', objectKey: 'forecast-resolutions/2026-07-07/a.json' }], T0 + 2);

    assert.equal(ledger['a@1'].receiptArchivedAt, T0 + 2);
    assert.equal(ledger['a@1'].receiptArchiveKey, 'forecast-resolutions/2026-07-07/a.json');
    assert.deepEqual(collectUnarchivedReceipts(ledger), []);
  });

  it('exposes a retention window comfortably larger than the ~8.3d history intake reach', () => {
    // The forecast-history intake is LRANGE 200 at hourly cadence (~8.3 days).
    // Retention must be far larger so a pruned window can never be re-ingested
    // from a stale snapshot still sitting in the intake read.
    assert.equal(LEDGER_RETENTION_WINDOW_DAYS, 180);
    assert.ok(LEDGER_RETENTION_WINDOW_DAYS > 30, 'retention must dwarf the intake window');
  });

  it('keeps R2 receipt archival best-effort so one object failure stays retryable', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const archived = await appendR2Receipts([
        { key: 'a@1', resolvedAt: T0, entry: { outcome: 'YES' } },
        { key: 'b@1', resolvedAt: T0, entry: { outcome: 'NO' } },
      ], {
        env: {
          CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
          CLOUDFLARE_R2_ACCESS_KEY_ID: 'id',
          CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
          CLOUDFLARE_R2_BUCKET: 'bucket',
          CLOUDFLARE_R2_FORECAST_RESOLUTION_PREFIX: 'receipts',
        },
        putObject: async (_config, key) => {
          if (key.includes('/b@1-')) throw new Error('r2 down');
        },
      });

      assert.equal(archived.length, 1);
      assert.equal(archived[0].key, 'a@1');
      assert.match(archived[0].objectKey, /receipts\/forecast-resolutions\/2026-07-07\/a@1-/);
      assert.ok(warnings.some((line) => line.includes('R2 receipt failed for b@1')));
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('pruneArchivedTerminalEntries', () => {
  const RETENTION_MS = LEDGER_RETENTION_WINDOW_DAYS * DAY_MS;
  const NOW = Date.parse('2027-07-07T00:00:00Z');

  function ledgerFixture() {
    return {
      // resolved, archived, and older than the retention window → prunable
      'old-archived@1': {
        key: 'old-archived@1',
        id: 'old-archived',
        status: 'resolved',
        outcome: 'YES',
        probability: 0.7,
        resolvedAt: NOW - RETENTION_MS - DAY_MS,
        receiptArchivedAt: NOW - RETENTION_MS,
        receiptArchiveKey: 'receipts/old-archived.json',
      },
      // resolved and archived but still inside the rolling window → kept (still scored)
      'recent-archived@1': {
        key: 'recent-archived@1',
        id: 'recent-archived',
        status: 'resolved',
        outcome: 'NO',
        probability: 0.3,
        resolvedAt: NOW - 10 * DAY_MS,
        receiptArchivedAt: NOW - 9 * DAY_MS,
      },
      // resolved and old but NOT archived to R2 yet → kept (receipt not durably stored)
      'old-unarchived@1': {
        key: 'old-unarchived@1',
        id: 'old-unarchived',
        status: 'resolved',
        outcome: 'YES',
        probability: 0.9,
        resolvedAt: NOW - RETENTION_MS - DAY_MS,
      },
      // pending forever → kept (still needs resolution)
      'pending@1': { key: 'pending@1', id: 'pending', status: 'pending' },
      // judged spec awaiting a judge resolver that has not shipped → kept
      'judge@1': { key: 'judge@1', id: 'judge', status: 'pending-judge' },
      // resolved+archived but missing resolvedAt → kept (cannot age-check safely)
      'no-resolvedat@1': {
        key: 'no-resolvedat@1',
        id: 'no-resolvedat',
        status: 'resolved',
        outcome: 'YES',
        receiptArchivedAt: NOW - RETENTION_MS,
      },
    };
  }

  it('drops only resolved+archived entries older than the retention window', () => {
    const pruned = pruneArchivedTerminalEntries(ledgerFixture(), NOW);
    assert.deepEqual(Object.keys(pruned).sort(), [
      'judge@1',
      'no-resolvedat@1',
      'old-unarchived@1',
      'pending@1',
      'recent-archived@1',
    ]);
    assert.equal(pruned['old-archived@1'], undefined);
  });

  it('never mutates the input ledger', () => {
    const ledger = ledgerFixture();
    pruneArchivedTerminalEntries(ledger, NOW);
    assert.ok(ledger['old-archived@1'], 'input must be left intact for the caller');
  });

  it('normalizes array and seed-envelope ledger inputs before pruning', () => {
    const ledger = ledgerFixture();
    const arrayPruned = pruneArchivedTerminalEntries(Object.values(ledger), NOW);
    assert.equal(arrayPruned['old-archived@1'], undefined);
    assert.ok(arrayPruned['recent-archived@1'], 'array input keeps in-window archived rows');
    assert.ok(arrayPruned['old-unarchived@1'], 'array input keeps unarchived retry rows');

    const envelopedPruned = pruneArchivedTerminalEntries({
      _seed: {
        fetchedAt: NOW,
        recordCount: Object.keys(ledger).length,
        sourceVersion: 'test',
        schemaVersion: 1,
        state: 'OK',
      },
      data: Object.values(ledger),
    }, NOW);
    assert.equal(envelopedPruned['old-archived@1'], undefined);
    assert.equal(envelopedPruned.data, undefined, 'envelope wrapper must not leak into the pruned ledger');
    assert.ok(envelopedPruned['recent-archived@1'], 'enveloped input keeps in-window archived rows');
    assert.ok(envelopedPruned['old-unarchived@1'], 'enveloped input keeps unarchived retry rows');
  });

  it('honors a custom retention window', () => {
    const ledger = ledgerFixture();
    // With a 5-day window, the 10-day-old archived entry is also out of window.
    const pruned = pruneArchivedTerminalEntries(ledger, NOW, { retentionWindowDays: 5 });
    assert.equal(pruned['recent-archived@1'], undefined);
    assert.equal(pruned['old-archived@1'], undefined);
    assert.ok(pruned['old-unarchived@1'], 'unarchived stays even when out of window');
  });

  it('does not change the scorecard it is aligned with', () => {
    const ledger = ledgerFixture();
    const before = computeScorecard(ledger, NOW);
    const after = computeScorecard(pruneArchivedTerminalEntries(ledger, NOW), NOW);
    assert.deepEqual(after, before, 'pruned entries were already outside the rolling scorecard window');
  });
});

describe('processResolutionCycle retention', () => {
  it('prunes prior-cycle archived terminal entries once they age out of the window', () => {
    const RETENTION_MS = LEDGER_RETENTION_WINDOW_DAYS * DAY_MS;
    const now = T0 + 2 * RETENTION_MS;
    const existingLedger = {
      'stale-archived@1': {
        key: 'stale-archived@1',
        id: 'stale-archived',
        status: 'resolved',
        outcome: 'YES',
        probability: 0.55,
        resolvedAt: T0,
        receiptArchivedAt: T0 + DAY_MS,
        receiptArchiveKey: 'receipts/stale-archived.json',
      },
    };
    const fresh = forecast({ generatedAt: now, deadline: now + DAY_MS });

    const { ledger } = processResolutionCycle(existingLedger, [snapshot(now, [fresh])], {
      'supply_chain:chokepoints:v4': { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 5 }] },
    }, now);

    assert.equal(ledger['stale-archived@1'], undefined, 'aged-out archived receipt is pruned from the hot ledger');
    assert.ok(ledger[`fc-hormuz@${now + DAY_MS}`], 'freshly ingested window survives');
  });

  it('retains a terminal entry that resolved this cycle (not yet archived)', () => {
    const hard = forecast({ deadline: T0 + DAY_MS });
    const { ledger, receipts } = processResolutionCycle({}, [snapshot(T0, [hard])], {
      'supply_chain:chokepoints:v4': { chokepoints: [{ route: 'Strait of Hormuz', riskScore: 61 }] },
    }, T0 + DAY_MS);

    assert.equal(ledger[`fc-hormuz@${T0 + DAY_MS}`].status, 'resolved');
    assert.equal(receipts.length, 1, 'the receipt is still emitted for R2 archival');
  });
});
