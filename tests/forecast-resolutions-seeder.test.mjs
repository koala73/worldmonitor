import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  RESOLUTIONS_KEY,
  SCORECARD_META_KEY,
  SCORECARD_KEY,
  appendSample,
  appendR2Receipts,
  collectUnarchivedReceipts,
  declareRecords,
  markReceiptsArchived,
  processResolutionCycle,
} from '../scripts/seed-forecast-resolutions.mjs';

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
