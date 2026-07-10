import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  DEFAULT_JUDGED_ARCHIVE_HASH_LIMIT,
  DEFAULT_JUDGED_ARCHIVE_TIMEOUT_MS,
  DEFAULT_JUDGED_MAX_PENDING_AGE_MS,
  DEFAULT_JUDGED_MAX_PENDING_ATTEMPTS,
  JUDGED_ARCHIVE_KEY,
  JUDGED_EVIDENCE_LOOKBACK_MS,
  JUDGED_EVIDENCE_MAX_LOOKBACK_MS,
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
  processResolutionCycleWithJudges,
  pruneArchivedTerminalEntries,
  readDigestAccumulatorArchive,
  judgedArchiveWindowForEntry,
  selectJudgedArchiveItems,
} from '../scripts/seed-forecast-resolutions.mjs';
import { computeScorecard } from '../scripts/_forecast-scorecard.mjs';
import { CONFLICT_COUNT_SOURCE_FEED, UNREST_COUNT_SOURCE_FEED } from '../scripts/_forecast-resolution.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-07-07T00:00:00Z');
const SEEDER_SOURCE = readFileSync(new URL('../scripts/seed-forecast-resolutions.mjs', import.meta.url), 'utf8');
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REDIS_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS: process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS,
  FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS: process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS,
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_REDIS_ENV.UPSTASH_REDIS_REST_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_REDIS_ENV.UPSTASH_REDIS_REST_URL;
  if (ORIGINAL_REDIS_ENV.UPSTASH_REDIS_REST_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_REDIS_ENV.UPSTASH_REDIS_REST_TOKEN;
  if (ORIGINAL_REDIS_ENV.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS === undefined) delete process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS;
  else process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS = ORIGINAL_REDIS_ENV.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS;
  if (ORIGINAL_REDIS_ENV.FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS === undefined) delete process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS;
  else process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS = ORIGINAL_REDIS_ENV.FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS;
});

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

  it('migrates already-open display count entries — conflict AND unrest rows move to judged (#5091)', () => {
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
    assert.equal(conflictRow.status, 'pending-judge');
    assert.equal(conflictRow.spec.kind, 'judged');
    assert.equal(conflictRow.spec.sourceFeed, null);
    assert.equal(conflictRow.spec.metricKey, null);
    assert.equal(conflictRow.spec.deadline, deadline);
    assert.match(conflictRow.spec.question, /Mali/);
    assert.equal(conflictRow.outcome, undefined);

    // unrest's resolution feed is empty without ACLED creds (#5091), so the
    // display-key entry is remapped and then migrated to judged too — even when
    // this test supplies fake feed data, migration is gated on the flag, not the data.
    const unrestRow = ledger[`fc-venezuela@${deadline}`];
    assert.equal(unrestRow.status, 'pending-judge');
    assert.equal(unrestRow.spec.kind, 'judged');
    assert.equal(unrestRow.spec.sourceFeed, null);
    assert.equal(unrestRow.spec.metricKey, null);
    assert.match(unrestRow.spec.question, /Venezuela/);
    assert.match(unrestRow.spec.question, /unrest|instability/i);
    assert.equal(unrestRow.outcome, undefined);
    assert.equal(receipts.length, 0);
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

    assert.equal(ledger[`fc-mali@${deadline}`].status, 'pending-judge');
    assert.equal(ledger[`fc-mali@${deadline}`].spec.kind, 'judged');
    assert.equal(ledger[`fc-mali@${deadline}`].spec.sourceFeed, null);
    assert.equal(ledger[`fc-mali@${deadline}`].spec.metricKey, null);
    assert.match(ledger[`fc-mali@${deadline}`].spec.question, /Mali/);
    // unrest migrates to judged too (#5091), regardless of any supplied feed data.
    assert.equal(ledger[`fc-venezuela@${deadline}`].status, 'pending-judge');
    assert.equal(ledger[`fc-venezuela@${deadline}`].spec.kind, 'judged');
    assert.equal(ledger[`fc-venezuela@${deadline}`].spec.sourceFeed, null);
    assert.equal(ledger[`fc-venezuela@${deadline}`].spec.metricKey, null);
    assert.match(ledger[`fc-venezuela@${deadline}`].spec.question, /Venezuela/);
    assert.equal(receipts.length, 0);
  });

  it('migrates persisted pending ACLED conflict rows to judged without rewriting resolved rows', () => {
    const deadline = T0 + DAY_MS;
    const oldLedger = {
      [`fc-mali@${deadline}`]: {
        id: 'fc-mali',
        key: `fc-mali@${deadline}`,
        domain: 'conflict',
        region: 'Mali',
        title: 'Conflict events in Mali rise above trend',
        timeHorizon: '24h',
        generationOrigin: 'detector',
        spec: {
          kind: 'hard',
          metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Mali)`,
          operator: '>=',
          threshold: 2,
          window: 'within-horizon',
          deadline,
          sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
        },
        probability: 0.52,
        firstSeenProbability: 0.52,
        generatedAt: T0,
        deadline,
        firstSeenAt: T0,
        lastSeenAt: T0,
        status: 'pending',
        samples: { count: 1, recent: [{ ts: deadline + DAY_MS, error: `missing_feed:${CONFLICT_COUNT_SOURCE_FEED}` }] },
      },
      [`fc-resolved@${deadline}`]: {
        id: 'fc-resolved',
        key: `fc-resolved@${deadline}`,
        domain: 'conflict',
        region: 'Mali',
        title: 'Already resolved conflict row',
        timeHorizon: '24h',
        generationOrigin: 'detector',
        spec: {
          kind: 'hard',
          metricKey: `${CONFLICT_COUNT_SOURCE_FEED}|count(country==Mali)`,
          operator: '>=',
          threshold: 1,
          window: 'within-horizon',
          deadline,
          sourceFeed: CONFLICT_COUNT_SOURCE_FEED,
        },
        probability: 0.7,
        firstSeenProbability: 0.7,
        generatedAt: T0,
        deadline,
        firstSeenAt: T0,
        lastSeenAt: deadline,
        status: 'resolved',
        outcome: 'YES',
        resolvedAt: deadline + DAY_MS,
        sealedAt: deadline + DAY_MS,
        evidence: { metricValue: 2 },
        samples: { count: 0, recent: [] },
      },
    };

    const { ledger, receipts } = processResolutionCycle(oldLedger, [], {
      [CONFLICT_COUNT_SOURCE_FEED]: { events: [{ country: 'Mali', occurredAt: T0 + 1 }] },
    }, deadline + 3 * DAY_MS);

    const migrated = ledger[`fc-mali@${deadline}`];
    assert.equal(migrated.status, 'pending-judge');
    assert.equal(migrated.spec.kind, 'judged');
    assert.equal(migrated.spec.sourceFeed, null);
    assert.equal(migrated.spec.metricKey, null);
    assert.equal(migrated.spec.operator, null);
    assert.equal(migrated.spec.threshold, null);
    assert.equal(migrated.spec.deadline, deadline);
    assert.match(migrated.spec.question, /Mali/);
    assert.deepEqual(migrated.samples, { count: 0, recent: [] });

    const resolved = ledger[`fc-resolved@${deadline}`];
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.spec.kind, 'hard');
    assert.equal(resolved.spec.sourceFeed, CONFLICT_COUNT_SOURCE_FEED);
    assert.equal(resolved.outcome, 'YES');
    assert.equal(receipts.length, 0);
  });

  it('migrates persisted pending unrest count rows to judged too (#5091 — empty unrest:events-resolution feed)', () => {
    const deadline = T0 + DAY_MS;
    const oldLedger = {
      [`fc-unrest@${deadline}`]: {
        id: 'fc-unrest',
        key: `fc-unrest@${deadline}`,
        domain: 'political',
        region: 'Kenya',
        title: 'Civil unrest in Kenya escalates',
        timeHorizon: '7d',
        generationOrigin: 'detector',
        spec: {
          kind: 'hard',
          metricKey: `${UNREST_COUNT_SOURCE_FEED}|count(country==Kenya)`,
          operator: '>=',
          threshold: 3,
          window: 'within-horizon',
          deadline,
          sourceFeed: UNREST_COUNT_SOURCE_FEED,
        },
        probability: 0.5,
        firstSeenProbability: 0.5,
        generatedAt: T0,
        deadline,
        firstSeenAt: T0,
        lastSeenAt: T0,
        status: 'pending',
        samples: { count: 0, recent: [] },
      },
    };

    const { ledger } = processResolutionCycle(oldLedger, [], {}, deadline + 3 * DAY_MS);
    const migrated = ledger[`fc-unrest@${deadline}`];
    assert.equal(migrated.status, 'pending-judge');
    assert.equal(migrated.spec.kind, 'judged');
    assert.equal(migrated.spec.sourceFeed, null);
    assert.equal(migrated.spec.metricKey, null);
    assert.equal(migrated.spec.deadline, deadline);
    assert.match(migrated.spec.question, /Kenya/);
    assert.match(migrated.spec.question, /unrest|instability/i);
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

describe('processResolutionCycleWithJudges', () => {
  const archive = [
    {
      id: 'N1',
      title: 'Parliament approves the emergency policy change',
      description: 'The bill passed before the forecast deadline after the coalition vote.',
      url: 'https://news.example/policy-change',
      publishedAt: T0 + DAY_MS + 1,
    },
  ];

  function judgedForecast(overrides = {}) {
    return forecast({
      id: 'fc-judge',
      domain: 'political',
      region: 'Freedonia',
      title: 'Policy change passes',
      probability: 0.7,
      resolution: {
        kind: 'judged',
        deadline: T0 + DAY_MS,
        question: 'Will the emergency policy change pass before the deadline?',
      },
      ...overrides,
    });
  }

  it('resolves a due judged entry when both models agree and cite archive evidence', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, archive, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => ({
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash',
          text: JSON.stringify({ outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }], rationale: 'The cited article confirms passage.' }),
        }),
        async () => ({ provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }], rationale: 'The policy passed before the deadline.' }),
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'YES');
    assert.equal(row.evidence.reason, 'dual_model_agreement');
    assert.deepEqual(row.evidence.citations.map((citation) => citation.id), ['N1']);
    assert.equal(result.receipts.length, 1);
    assert.equal(result.scorecard.totals.scored, 1);
  });

  it('resolves to VOID when the two judges disagree', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, archive, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }], rationale: 'The article says it passed.' }),
        async () => ({ provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'NO', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }], rationale: 'The article does not establish passage.' }),
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'judge_disagreement');
    assert.equal(result.scorecard.totals.void, 1);
    assert.equal(result.scorecard.totals.scored, 0);
  });

  it('resolves to VOID without calling judges when the archive has no relevant evidence', async () => {
    const unrelatedArchive = [{
      id: 'N9',
      title: 'Central bank holds rates unchanged',
      description: 'Officials said inflation remained steady.',
      url: 'https://news.example/rates',
      publishedAt: T0 + DAY_MS + 1,
    }];
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, unrelatedArchive, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'no_archive_evidence');
    assert.equal(result.scorecard.totals.void, 1);
  });

  it('keeps no-evidence entries pending when the archive does not cover the entry window', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, {
      available: true,
      coverageStartMs: T0 + DAY_MS,
      coverageEndMs: T0 + DAY_MS + 2,
      items: [{
        id: 'N1',
        title: 'Central bank holds rates unchanged',
        description: 'Officials said inflation remained steady.',
        url: 'https://news.example/rates',
        publishedAt: T0 + DAY_MS + 1,
      }],
    }, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.outcome, undefined);
    assert.equal(row.judgeLastAttempt.reason, 'archive_unavailable');
    assert.equal(result.receipts.length, 0);
  });

  it('seals a long-horizon disagreement when a truncated archive covers the deadline window', async () => {
    const deadline = T0 + 30 * DAY_MS;
    const nowMs = deadline + 60 * 60 * 1000;
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast({
      resolution: {
        kind: 'judged',
        deadline,
        question: 'Will the emergency policy change pass before the deadline?',
      },
    })])], {}, {
      available: true,
      truncated: true,
      coverageStartMs: deadline - JUDGED_EVIDENCE_LOOKBACK_MS,
      coverageEndMs: nowMs,
      items: [{
        id: 'N1',
        title: 'Parliament votes on the emergency policy change',
        description: 'The coalition held its final vote before the forecast deadline.',
        url: 'https://news.example/policy-change',
        publishedAt: deadline - 1,
      }],
    }, nowMs, {
      judgeModels: [
        async () => ({ provider: 'openrouter', outcome: 'YES', citations: [{ id: 'N1', quote: 'The coalition held its final vote before the forecast deadline' }] }),
        async () => ({ provider: 'groq', outcome: 'NO', citations: [{ id: 'N1', quote: 'The coalition held its final vote before the forecast deadline' }] }),
      ],
    });

    const row = result.ledger[`fc-judge@${deadline}`];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'judge_disagreement');
    assert.equal(result.receipts.length, 1);
  });

  it('anchors the evidence window on the deadline instead of forecast generation', () => {
    const deadline = T0 + 30 * DAY_MS;
    const nowMs = deadline + 60 * 60 * 1000;

    assert.deepEqual(judgedArchiveWindowForEntry({
      generatedAt: T0,
      firstSeenAt: T0,
      spec: { kind: 'judged', deadline },
    }, nowMs), {
      startMs: deadline - JUDGED_EVIDENCE_LOOKBACK_MS,
      endMs: nowMs,
    });
  });

  it('honors the configured deadline evidence lookback', () => {
    const deadline = T0 + 30 * DAY_MS;
    const nowMs = deadline + 60 * 60 * 1000;
    process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS = String(2 * DAY_MS);

    assert.deepEqual(judgedArchiveWindowForEntry({ spec: { kind: 'judged', deadline } }, nowMs), {
      startMs: deadline - 2 * DAY_MS,
      endMs: nowMs,
    });
  });

  it('keeps a covered no-evidence entry pending when the archive is explicitly incomplete', async () => {
    const deadline = T0 + DAY_MS;
    const nowMs = deadline + 2;
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, {
      available: true,
      coverageComplete: false,
      coverageStartMs: deadline - JUDGED_EVIDENCE_LOOKBACK_MS,
      coverageEndMs: nowMs,
      items: [],
    }, nowMs, {
      judgeModels: [
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
      ],
    });

    const row = result.ledger[`fc-judge@${deadline}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.judgeLastAttempt.reason, 'archive_unavailable');
    assert.equal(row.judgeLastAttempt.detail, 'archive_window_incomplete');
    assert.equal(result.receipts.length, 0);
  });

  it('filters shared archive evidence to each entry deadline window', () => {
    const deadline = T0 + 30 * DAY_MS;
    const nowMs = deadline + 60 * 60 * 1000;
    const entry = judgedForecast({
      resolution: {
        kind: 'judged',
        deadline,
        question: 'Will the emergency policy change pass before the deadline?',
      },
    });

    const selected = selectJudgedArchiveItems(entry, [{
      id: 'N-old',
      title: 'Emergency policy change passes',
      description: 'The coalition passed the policy in an earlier session.',
      publishedAt: deadline - 8 * DAY_MS,
    }, {
      id: 'N-current',
      title: 'Emergency policy change passes',
      description: 'The coalition passed the policy before the deadline.',
      publishedAt: deadline - DAY_MS,
    }], { nowMs });

    assert.deepEqual(selected.map((item) => item.id), ['N-current']);
  });

  it('filters one normalized archive independently for judged entries with different deadlines', async () => {
    const earlyDeadline = T0 + 10 * DAY_MS;
    const lateDeadline = T0 + 20 * DAY_MS;
    const nowMs = lateDeadline + 1;
    const forecasts = [
      judgedForecast({
        id: 'judge-early-window',
        resolution: {
          kind: 'judged',
          deadline: earlyDeadline,
          question: 'Will the emergency policy change pass before the deadline?',
        },
      }),
      judgedForecast({
        id: 'judge-late-window',
        resolution: {
          kind: 'judged',
          deadline: lateDeadline,
          question: 'Will the emergency policy change pass before the deadline?',
        },
      }),
    ];
    const sharedArchive = {
      available: true,
      coverageStartMs: earlyDeadline - JUDGED_EVIDENCE_LOOKBACK_MS,
      coverageEndMs: nowMs,
      items: [{
        id: 'N-early',
        title: 'Emergency policy change passes early vote',
        description: 'The policy passed in the early session.',
        publishedAt: earlyDeadline - DAY_MS,
      }, {
        id: 'N-late',
        title: 'Emergency policy change passes final vote',
        description: 'The policy passed in the later session.',
        publishedAt: lateDeadline - DAY_MS,
      }],
    };
    const evidenceByEntry = new Map();
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, forecasts)], {}, sharedArchive, nowMs, {
      judgeModels: [
        async (entry, items) => {
          evidenceByEntry.set(entry.id, items.map((item) => item.id));
          return { provider: 'openrouter', outcome: 'YES', citations: [{ id: items[0].id, quote: items[0].description }] };
        },
        async (_entry, items) => ({ provider: 'groq', outcome: 'YES', citations: [{ id: items[0].id, quote: items[0].description }] }),
      ],
    });

    assert.deepEqual(evidenceByEntry.get('judge-early-window'), ['N-late', 'N-early']);
    assert.deepEqual(evidenceByEntry.get('judge-late-window'), ['N-late']);
    assert.equal(result.ledger[`judge-early-window@${earlyDeadline}`].status, 'resolved');
    assert.equal(result.ledger[`judge-late-window@${lateDeadline}`].status, 'resolved');
  });

  it('keeps weak judge outcomes pending when matching evidence comes from an incomplete archive', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, {
      available: true,
      coverageStartMs: T0 + DAY_MS,
      coverageEndMs: T0 + DAY_MS + 2,
      items: archive,
    }, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', outcome: 'VOID', citations: [], rationale: 'Archive is insufficient.' }),
        async () => ({ provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'VOID', citations: [], rationale: 'Not enough coverage.' }),
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.outcome, undefined);
    assert.equal(row.judgeLastAttempt.reason, 'archive_unavailable');
    assert.equal(row.judgeLastAttempt.detail, 'archive_window_incomplete');
    assert.equal(result.receipts.length, 0);
  });

  it('resolves YES/NO judge agreement to VOID when citations lack matching excerpts', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, archive, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', outcome: 'YES', citations: [{ id: 'N1' }], rationale: 'The article says it passed.' }),
        async () => ({ provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'YES', citations: [{ id: 'N1', quote: 'A fabricated sentence that is not in the archive' }], rationale: 'The policy passed before the deadline.' }),
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'all_judges_void');
    assert.deepEqual(row.evidence.judgments.map((judgment) => judgment.reason), ['invalid_citations', 'invalid_citations']);
    assert.equal(result.scorecard.totals.void, 1);
    assert.equal(result.scorecard.totals.scored, 0);
  });

  it('keeps the entry pending when a judge call is unavailable or malformed', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, archive, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }], rationale: 'The article says it passed.' }),
        async () => null,
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.outcome, undefined);
    assert.equal(row.judgeLastAttempt.reason, 'judge_unavailable');
    assert.equal(result.receipts.length, 0);
  });

  it('does not fall back to live judges when an injected judge list is incomplete', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, archive, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }], rationale: 'The article says it passed.' }),
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.outcome, undefined);
    assert.equal(row.judgeLastAttempt.reason, 'judge_unavailable');
    assert.equal(row.judgeLastAttempt.detail, 'fewer_than_two_models');
    assert.equal(result.receipts.length, 0);
  });

  it('keeps the entry pending when a judge returns unparseable text', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, archive, T0 + DAY_MS + 2, {
      judgeModels: [
        async () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }], rationale: 'The article says it passed.' }),
        async () => ({ provider: 'groq', model: 'llama-3.3-70b-versatile', text: 'not-json' }),
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.judgeLastAttempt.reason, 'judge_unavailable');
    assert.equal(row.judgeLastAttempt.detail, 'invalid_judge_response');
    assert.equal(result.receipts.length, 0);
  });

  it('caps judged attempts per run', async () => {
    let judgeCalls = 0;
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [
      judgedForecast({ id: 'fc-judge-1' }),
      judgedForecast({ id: 'fc-judge-2' }),
    ])], {}, archive, T0 + DAY_MS + 2, {
      maxJudgedEntries: 1,
      judgeModels: [
        async () => {
          judgeCalls += 1;
          return { outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }] };
        },
        async () => {
          judgeCalls += 1;
          return { outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }] };
        },
      ],
    });

    const rows = Object.values(result.ledger);
    assert.equal(rows.filter((row) => row.status === 'resolved').length, 1);
    assert.equal(rows.filter((row) => row.status === 'pending-judge').length, 1);
    assert.equal(result.receipts.length, 1);
    assert.equal(judgeCalls, 2);
  });

  it('rotates judged backlog by oldest attempt instead of fixed key order', async () => {
    const deadline = T0 + DAY_MS;
    const { ledger } = processResolutionCycle({}, [snapshot(T0, [
      judgedForecast({ id: 'a-recent' }),
      judgedForecast({ id: 'b-old' }),
    ])], {}, T0);
    ledger[`a-recent@${deadline}`].judgeAttempts = 3;
    ledger[`a-recent@${deadline}`].judgeLastAttempt = { at: T0 + 12 * 60 * 60 * 1000, reason: 'archive_unavailable' };
    ledger[`b-old@${deadline}`].judgeAttempts = 3;
    ledger[`b-old@${deadline}`].judgeLastAttempt = { at: T0 + 60 * 60 * 1000, reason: 'archive_unavailable' };

    const result = await processResolutionCycleWithJudges(ledger, [], {}, archive, T0 + DAY_MS + 2, {
      maxJudgedEntries: 1,
      maxJudgedPendingAttempts: 99,
      judgeModels: [
        async () => ({ outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }] }),
        async () => ({ outcome: 'YES', citations: [{ id: 'N1', quote: 'The bill passed before the forecast deadline' }] }),
      ],
    });

    assert.equal(result.ledger[`a-recent@${deadline}`].status, 'pending-judge');
    assert.equal(result.ledger[`b-old@${deadline}`].status, 'resolved');
    assert.equal(result.receipts[0].key, `b-old@${deadline}`);
  });

  it('voids old judged entries after retry attempts are exhausted', async () => {
    const deadline = T0 + DAY_MS;
    const { ledger } = processResolutionCycle({}, [snapshot(T0, [judgedForecast({ id: 'stuck-judge' })])], {}, T0);
    const key = `stuck-judge@${deadline}`;
    ledger[key].judgeAttempts = 1;
    ledger[key].judgeLastAttempt = { at: deadline + 1, reason: 'archive_unavailable' };

    const result = await processResolutionCycleWithJudges(ledger, [], {}, { available: false }, deadline + 2 * DAY_MS, {
      maxJudgedPendingAttempts: 2,
      maxJudgedPendingAgeMs: DAY_MS,
    });

    const row = result.ledger[key];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.judgeAttempts, 2);
    assert.equal(row.evidence.reason, 'judge_retry_exhausted');
    assert.equal(row.evidence.attempts, 2);
    assert.equal(row.evidence.maxAttempts, 2);
    assert.equal(row.evidence.maxAgeMs, DAY_MS);
    assert.equal(row.evidence.lastAttemptReason, 'archive_unavailable');
    assert.equal(result.receipts.length, 1);
    assert.equal(result.scorecard.totals.void, 1);
  });

  it('does not start judge calls when the remaining run budget is below the admission floor', async () => {
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [judgedForecast()])], {}, archive, T0 + DAY_MS + 2, {
      deadlineMs: Date.now() + 2_000,
      minJudgeStageBudgetMs: 5_000,
      judgeModels: [
        async () => { throw new Error('judge should not start when the run budget is exhausted'); },
        async () => { throw new Error('judge should not start when the run budget is exhausted'); },
      ],
    });

    const row = result.ledger[`fc-judge@${T0 + DAY_MS}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.judgeLastAttempt, undefined);
    assert.equal(result.receipts.length, 0);
  });

  it('marks capped archive reads as truncated instead of complete', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/pipeline')) {
        const commands = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => commands.map(([, key]) => ({
            result: ['title', `Story ${key}`, 'description', 'Policy change context', 'publishedAt', String(T0 + 1)],
          })),
        };
      }
      return {
        ok: true,
        json: async () => ({ result: ['new-hash', String(T0 + 2), 'old-hash', String(T0 + 1)] }),
      };
    };

    try {
      const archive = await readDigestAccumulatorArchive(T0, T0 + DAY_MS, { maxHashes: 1 });
      assert.equal(archive.truncated, true);
      assert.equal(archive.items.length, 1);
      assert.ok(warnings.some((line) => line.includes('judged archive hash cap reached')));
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('readDigestAccumulatorArchive', () => {
  it('rejects missing Redis credentials without exiting the process', async () => {
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (() => {
      exitCalled = true;
      throw new Error('process.exit should not be called');
    });
    try {
      await assert.rejects(
        readDigestAccumulatorArchive(T0, T0 + DAY_MS, { env: {} }),
        /Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN/,
      );
      assert.equal(exitCalled, false);
    } finally {
      process.exit = originalExit;
    }
  });

  it('uses a production-sized default archive hash limit', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    let zsetCommand;
    globalThis.fetch = async (_url, init) => {
      zsetCommand = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ result: [] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0, T0 + DAY_MS);

    assert.ok(DEFAULT_JUDGED_ARCHIVE_HASH_LIMIT >= 15_000);
    assert.ok(DEFAULT_JUDGED_ARCHIVE_TIMEOUT_MS >= 20_000);
    assert.equal(zsetCommand.at(-1), String(DEFAULT_JUDGED_ARCHIVE_HASH_LIMIT + 1));
    assert.equal(archive.truncated, undefined);
    assert.equal(archive.items.length, 0);
  });

  it('fails closed when the scored archive response is structurally invalid', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: { hash: 'not-a-scored-array' } }),
    });

    await assert.rejects(
      readDigestAccumulatorArchive(T0, T0 + DAY_MS),
      /returned non-array WITHSCORES data/,
    );
  });

  it('bounds the Redis archive query to the 14-day evidence floor and hash limit', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    let zsetCommand;
    let pipelineCommands;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    const nowMs = T0 + 5 * DAY_MS;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/pipeline')) {
        pipelineCommands = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => pipelineCommands.map(([, key]) => ({
            result: ['title', `Story ${key}`, 'description', 'Policy change context', 'publishedAt', String(T0 + 1)],
          })),
        };
      }
      zsetCommand = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ result: [
          'new-hash', String(nowMs - 1),
          'old-hash', String(nowMs - 2),
          'extra-hash', String(nowMs - 3),
        ] }),
      };
    };

    try {
      const archive = await readDigestAccumulatorArchive(T0 - 30 * DAY_MS, nowMs, { maxHashes: 2 });

      assert.deepEqual(zsetCommand, [
        'ZREVRANGEBYSCORE',
        JUDGED_ARCHIVE_KEY,
        String(nowMs),
        String(nowMs - JUDGED_EVIDENCE_MAX_LOOKBACK_MS),
        'WITHSCORES',
        'LIMIT',
        '0',
        '3',
      ]);
      assert.deepEqual(pipelineCommands.map(([, key]) => key), [
        'story:track:v1:new-hash',
        'story:track:v1:old-hash',
      ]);
      assert.equal(archive.requestedStartMs, T0 - 30 * DAY_MS);
      assert.equal(archive.coverageStartMs, nowMs - 2);
      assert.equal(archive.items.length, 2);
      assert.equal(archive.truncated, true);
      assert.ok(warnings.some((line) => line.includes('FORECAST_RESOLUTION_JUDGE_ARCHIVE_HASH_LIMIT')));
    } finally {
      console.warn = originalWarn;
    }
  });

  it('honors the configured maximum archive lookback', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS = String(2 * DAY_MS);
    process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS = String(3 * DAY_MS);
    const nowMs = T0 + 5 * DAY_MS;
    let zsetCommand;
    globalThis.fetch = async (_url, init) => {
      zsetCommand = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ result: [] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0 - 30 * DAY_MS, nowMs);

    assert.equal(zsetCommand[3], String(nowMs - 3 * DAY_MS));
    assert.equal(archive.coverageStartMs, nowMs - 3 * DAY_MS);
  });

  it('clamps the evidence window to the configured maximum lookback', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_LOOKBACK_MS;
    process.env.FORECAST_RESOLUTION_JUDGE_EVIDENCE_MAX_LOOKBACK_MS = String(DAY_MS);
    const nowMs = T0 + 5 * DAY_MS;
    let zsetCommand;
    globalThis.fetch = async (_url, init) => {
      zsetCommand = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ result: [] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0 - 30 * DAY_MS, nowMs);

    assert.equal(zsetCommand[3], String(nowMs - DAY_MS));
    assert.equal(archive.coverageStartMs, nowMs - DAY_MS);

    const deadline = nowMs;
    assert.deepEqual(judgedArchiveWindowForEntry({ spec: { kind: 'judged', deadline } }, nowMs), {
      startMs: deadline - DAY_MS,
      endMs: nowMs,
    });

    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [forecast({
      id: 'judge-max-lookback',
      domain: 'political',
      region: 'Freedonia',
      title: 'Policy change passes',
      resolution: {
        kind: 'judged',
        deadline,
        question: 'Will the emergency policy change pass before the deadline?',
      },
    })])], {}, archive, nowMs, {
      judgeModels: [
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
      ],
    });

    const row = result.ledger[`judge-max-lookback@${deadline}`];
    assert.equal(row.status, 'resolved');
    assert.equal(row.outcome, 'VOID');
    assert.equal(row.evidence.reason, 'no_archive_evidence');
    assert.equal(result.receipts.length, 1);
  });

  it('keeps a due judged entry pending when a capped read starts after its required window', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const deadline = T0 + 10 * DAY_MS;
    const nowMs = deadline + DAY_MS;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/pipeline')) {
        return {
          ok: true,
          json: async () => [{
            result: ['title', 'Unrelated market update', 'description', 'Markets were steady.', 'publishedAt', String(deadline + 1)],
          }],
        };
      }
      return {
        ok: true,
        json: async () => ({ result: [
          'retained-hash', String(deadline + 1),
          'dropped-hash', String(deadline + 1),
        ] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(
      deadline - JUDGED_EVIDENCE_LOOKBACK_MS,
      nowMs,
      { maxHashes: 1 },
    );
    assert.equal(archive.truncated, true);
    assert.equal(archive.coverageStartMs, deadline + 2, 'equal-score cap ties must not over-claim the boundary');

    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [forecast({
      id: 'judge-truncated-window',
      domain: 'political',
      region: 'Freedonia',
      title: 'Policy change passes',
      resolution: {
        kind: 'judged',
        deadline,
        question: 'Will the emergency policy change pass before the deadline?',
      },
    })])], {}, archive, nowMs, {
      judgeModels: [
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
      ],
    });

    const row = result.ledger[`judge-truncated-window@${deadline}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.judgeLastAttempt.detail, 'archive_window_incomplete');
    assert.equal(result.receipts.length, 0);
  });

  it('chunks story-track reads while preserving hash-to-row alignment', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const pipelineBatches = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/pipeline')) {
        const commands = JSON.parse(init.body);
        pipelineBatches.push(commands);
        return {
          ok: true,
          json: async () => commands.map(([, key]) => ({
            result: ['title', `Story ${key}`, 'description', 'Policy change context', 'publishedAt', String(T0 + 1)],
          })),
        };
      }
      return {
        ok: true,
        json: async () => ({ result: [
          'hash-1', String(T0 + 3),
          'hash-2', String(T0 + 2),
          'hash-3', String(T0 + 1),
        ] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0, T0 + DAY_MS, {
      maxHashes: 4,
      storyTrackBatchSize: 2,
    });

    assert.deepEqual(pipelineBatches.map((batch) => batch.map(([, key]) => key)), [
      ['story:track:v1:hash-1', 'story:track:v1:hash-2'],
      ['story:track:v1:hash-3'],
    ]);
    assert.deepEqual(archive.items.map((item) => item.hash), ['hash-1', 'hash-2', 'hash-3']);
  });

  it('fails closed when the shared archive budget expires between chunks', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const originalDateNow = Date.now;
    const clock = [1_000, 1_000, 1_002];
    let clockIndex = 0;
    let pipelineCalls = 0;
    Date.now = () => clock[Math.min(clockIndex++, clock.length - 1)];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/pipeline')) {
        pipelineCalls += 1;
        const commands = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => commands.map(() => ({
            result: ['title', 'Story', 'description', 'Policy context', 'publishedAt', String(T0 + 1)],
          })),
        };
      }
      return {
        ok: true,
        json: async () => ({ result: [
          'hash-1', String(T0 + 3),
          'hash-2', String(T0 + 2),
          'hash-3', String(T0 + 1),
        ] }),
      };
    };

    try {
      await assert.rejects(
        readDigestAccumulatorArchive(T0, T0 + DAY_MS, {
          archiveTimeoutMs: 1,
          storyTrackBatchSize: 2,
        }),
        /exceeded 1ms archive budget/,
      );
      assert.equal(pipelineCalls, 1);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('normalizes object-shaped HGETALL rows', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/pipeline')) {
        return {
          ok: true,
          json: async () => [{
            result: {
              title: 'Policy change passes',
              description: 'The bill passed.',
              publishedAt: String(T0 + 1),
            },
          }],
        };
      }
      return {
        ok: true,
        json: async () => ({ result: ['hash-1', String(T0 + 1)] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0, T0 + DAY_MS, { maxHashes: 2 });

    assert.equal(archive.items.length, 1);
    assert.equal(archive.items[0].hash, 'hash-1');
    assert.equal(archive.items[0].title, 'Policy change passes');
  });

  it('skips missing story-track rows but marks the archive incomplete', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/pipeline')) {
        return {
          ok: true,
          json: async () => [
            { result: [] },
            { result: ['title', 'Policy change passes', 'description', 'The bill passed.', 'publishedAt', String(T0 + 1)] },
          ],
        };
      }
      return {
        ok: true,
        json: async () => ({ result: ['missing-hash', String(T0 + 2), 'hash-2', String(T0 + 1)] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0, T0 + DAY_MS);

    assert.equal(archive.items.length, 1);
    assert.equal(archive.truncated, undefined);
    assert.equal(archive.incomplete, true);
    assert.equal(archive.missingRows, 1);
    assert.equal(archive.items[0].hash, 'hash-2');
  });

  it('does not seal no-evidence judged forecasts when every archive row is missing', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/pipeline')) {
        return {
          ok: true,
          json: async () => [{ result: [] }],
        };
      }
      return {
        ok: true,
        json: async () => ({ result: ['missing-hash', String(T0 + 1)] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0 - JUDGED_EVIDENCE_LOOKBACK_MS, T0 + DAY_MS);
    const result = await processResolutionCycleWithJudges({}, [snapshot(T0, [forecast({
      id: 'judge-missing-archive-row',
      domain: 'political',
      region: 'Freedonia',
      title: 'Policy change passes',
      resolution: {
        kind: 'judged',
        deadline: T0 + 1,
        question: 'Will the emergency policy change pass before the deadline?',
      },
    })])], {}, archive, T0 + DAY_MS, {
      judgeModels: [
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
        async () => { throw new Error('judge should not be called without relevant archive evidence'); },
      ],
    });

    const row = result.ledger[`judge-missing-archive-row@${T0 + 1}`];
    assert.equal(row.status, 'pending-judge');
    assert.equal(row.judgeLastAttempt.reason, 'archive_unavailable');
    assert.equal(result.receipts.length, 0);
  });

  it('keeps good evidence while marking an errored Redis story row incomplete', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/pipeline')) {
        return {
          ok: true,
          json: async () => [
            { result: ['title', 'Policy change passes', 'description', 'The bill passed.', 'publishedAt', String(T0 + 1)] },
            { error: 'ERR transient HGETALL failure' },
          ],
        };
      }
      return {
        ok: true,
        json: async () => ({ result: ['hash-1', String(T0 + 2), 'hash-2', String(T0 + 1)] }),
      };
    };

    const archive = await readDigestAccumulatorArchive(T0, T0 + DAY_MS);

    assert.equal(archive.items.length, 1);
    assert.equal(archive.items[0].hash, 'hash-1');
    assert.equal(archive.incomplete, true);
    assert.equal(archive.missingRows, 1);
  });

  it('logs caller context and fails closed when a story-track response is short', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/pipeline')) {
        return {
          ok: true,
          json: async () => [{ result: ['title', 'Only one row'] }],
        };
      }
      return {
        ok: true,
        json: async () => ({ result: ['hash-1', String(T0 + 2), 'hash-2', String(T0 + 1)] }),
      };
    };

    try {
      await assert.rejects(
        readDigestAccumulatorArchive(T0, T0 + DAY_MS),
        /story-track pipeline returned incomplete archive data/,
      );
      assert.ok(warnings.some((line) => line.includes('[forecast-resolutions] readStoryTracksChunked')));
      assert.ok(warnings.some((line) => line.includes('returned 1 of 2 expected')));
      assert.ok(warnings.some((line) => line.includes('treats the archive read as failed')));
    } finally {
      console.warn = originalWarn;
    }
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
    assert.equal(DEFAULT_JUDGED_MAX_PENDING_ATTEMPTS, 14);
    assert.equal(DEFAULT_JUDGED_MAX_PENDING_AGE_MS, 14 * DAY_MS);
    assert.equal(declareRecords({ a: {}, b: {} }), 2);
  });

  it('keeps dry-run on the judged path without live LLM calls', () => {
    const dryRunStart = SEEDER_SOURCE.indexOf('async function dryRun()');
    const dryRunEnd = SEEDER_SOURCE.indexOf('export async function appendR2Receipts');
    const dryRunSource = SEEDER_SOURCE.slice(dryRunStart, dryRunEnd);

    assert.ok(dryRunStart > -1);
    assert.ok(dryRunEnd > dryRunStart);
    assert.match(dryRunSource, /processResolutionCycleWithJudges/);
    assert.match(dryRunSource, /judgedMode:\s*'no-llm'/);
    assert.match(dryRunSource, /judgeModels:\s*dryRunJudgeModels/);
    assert.doesNotMatch(dryRunSource, /processResolutionCycle\(/);
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
      // judged spec awaiting resolution → kept
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
