import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import forecastRoute from '../api/forecast/v1/[rpc].ts';
import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import {
  SCORECARD_DECLARED_FIELDS,
  SCORECARD_NESTED_CHILD_FIELDS,
  SCORECARD_NESTED_OBJECT_FIELDS,
  selectDeclaredScorecardFields,
} from '../scripts/build-accuracy-page.mjs';
import {
  MARKET_ALERT_FIELDS,
  MARKET_ALERT_ROW_FIELDS,
  RECEIPT_FIELDS,
  SCORECARD_BLOCK_FIELDS,
} from '../server/worldmonitor/forecast/v1/scorecard-fields.ts';
import { PUBLIC_RECEIPT_FIELDS } from '../scripts/_forecast-scorecard.mjs';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalEnv = { ...process.env };

const REDIS_KEY = 'forecast:scorecard:v1';
const MARKET_ALERTS_KEY = 'correlation:market-alerts:scorecard:v1';

const FORECAST_DATA = {
  schemaVersion: 1,
  generatedAt: 456,
  rollingWindowDays: 180,
  methodology: 'test methodology',
  totals: { entries: 1, resolved: 1, pending: 0, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
};

// What seed-market-alert-ledger stores: the public block plus seeder totals,
// archive status and per-row outcome counts that stay off the contract.
const MARKET_ALERTS_STORED = {
  schemaVersion: 1,
  generatedAt: 789,
  windowHours: 6,
  rollingWindowDays: 30,
  methodology: 'market-alert methodology',
  totals: { pending: 1, resolved: 4, hit: 3, miss: 1, void: 0 },
  archive: { readFailed: false, truncated: false, unproven: false, coveredFromMs: 1, readAt: 2 },
  byType: [
    { type: 'market', pending: 1, resolved: 4, hit: 3, miss: 1, void: 0, n: 4, hitRate: 0.75, pairedHitRate: 0.5, baseN: 2, baseHitRate: 0.5, medianLeadTimeMs: 3600000 },
    { type: 'prediction-market', pending: 0, resolved: 0, hit: 0, miss: 0, void: 0, n: 0, hitRate: null, pairedHitRate: null, baseN: 0, baseHitRate: null, medianLeadTimeMs: null },
  ],
};
const MARKET_ALERTS_SERVED = {
  generatedAt: 789,
  windowHours: 6,
  rollingWindowDays: 30,
  methodology: 'market-alert methodology',
  byType: [
    { type: 'market', scored: 4, hitRate: 0.75, baseN: 2, baseHitRate: 0.5, pairedHitRate: 0.5, medianLeadTimeMs: 3600000 },
    { type: 'prediction-market', scored: 0, baseN: 0 },
  ],
};

function envelope(data: unknown) {
  return { _seed: { fetchedAt: Date.now() }, data };
}

function serveRedis(stored: Record<string, unknown>, failing: string[] = []) {
  globalThis.fetch = (async (input) => {
    const key = decodeURIComponent(String(input).split('/get/')[1] ?? '');
    if (failing.includes(key)) throw new Error(`redis unavailable for ${key}`);
    const value = Object.hasOwn(stored, key) ? stored[key] : null;
    return Response.json({ result: value == null ? null : JSON.stringify(value) });
  }) as typeof fetch;
}

function makeCtx() {
  const req = new Request('https://worldmonitor.app/api/forecast/v1/get-forecast-scorecard');
  return { request: req, pathParams: {}, headers: {} };
}

function restoreEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
}

describe('getForecastScorecard backend status', () => {
  let getForecastScorecard: typeof import('../server/worldmonitor/forecast/v1/get-forecast-scorecard').getForecastScorecard;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const mod = await import('../server/worldmonitor/forecast/v1/get-forecast-scorecard.ts');
    getForecastScorecard = mod.getForecastScorecard;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    restoreEnv();
  });

  it('unwraps seeded scorecard envelopes and passes camelCase fields through by name', async () => {
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      assert.ok(url.endsWith(`/get/${encodeURIComponent(REDIS_KEY)}`));
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: { fetchedAt: Date.now(), recordCount: 2, sourceVersion: 'test', schemaVersion: 1, state: 'OK' },
          data: {
            schemaVersion: 1,
            generatedAt: 456,
            rollingWindowDays: 180,
            methodology: 'test methodology',
            totals: { entries: 2, resolved: 1, pending: 1, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
            overall: { count: 1, brier: 0.04, logScore: 0.22 },
            byDomain: [{ domain: 'market', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
            byGenerationOrigin: [{ generationOrigin: 'detector', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
            calibration: [{ bucket: '80-90', minProbability: 0.8, maxProbability: 0.9, count: 1, predictedMean: 0.8, realizedRate: 1, brier: 0.04 }],
            vsMarketSkill: { count: 1, forecastBrier: 0.04, marketBrier: 0.09, brierDelta: 0.05 },
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.generatedAt, 456);
    assert.equal(res.totals?.entries, 2);
    assert.equal(res.overall?.brier, 0.04);
    assert.equal(res.byDomain[0].domain, 'market');
    assert.equal(res.vsMarketSkill?.brierDelta, 0.05);
    assert.equal(JSON.stringify(res).includes('_seed'), false);
    assert.equal(res.degraded, false);
    assert.equal(res.stale, false);
    assert.equal(res.error, '');
  });

  it('does not serve the internal judgedLane block on the typed response (#7068)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      result: JSON.stringify({
        _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'test', schemaVersion: 1, state: 'OK' },
        data: {
          schemaVersion: 1,
          generatedAt: 456,
          rollingWindowDays: 180,
          methodology: 'test methodology',
          totals: { entries: 1, resolved: 1, pending: 0, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
          // Operator observability written by the resolutions seeder. It is not
          // in the proto, so it must not ride out on this typed response.
          judgedLane: { pendingJudge: 3, attemptClasses: { archive_incomplete: 9 }, scoredWithinSlaRate: 0.5 },
        },
      }),
    }), { status: 200 })) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.totals?.entries, 1, 'declared fields still pass through');
    assert.equal(JSON.stringify(res).includes('judgedLane'), false);
    assert.equal(JSON.stringify(res).includes('archive_incomplete'), false);
  });

  it('the public RPC serializes only declared top-level cache fields', async () => {
    process.env.WM_SESSION_SECRET = 'synthetic-scorecard-session-secret-long-enough';
    const token = (await issueSessionToken()).token;
    const data = {
      schemaVersion: 1, generatedAt: 456, rollingWindowDays: 180, methodology: 'fixture',
      totals: { entries: 2, resolved: 1, pending: 1, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 0.5 },
      overall: { count: 1, brier: 0.04, logScore: 0.22 },
      byDomain: [{ domain: 'market', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
      byGenerationOrigin: [{ generationOrigin: 'detector', resolved: 1, scored: 1, void: 0, voidRate: 0, brier: 0.04, logScore: 0.22 }],
      calibration: [{ bucket: '80-90', minProbability: 0.8, maxProbability: 0.9, count: 1, predictedMean: 0.8, realizedRate: 1, brier: 0.04 }],
      vsMarketSkill: { count: 1, forecastBrier: 0.04, marketBrier: 0.09, brierDelta: 0.05 },
      skill: { count: 1, brier: 0.04, logScore: 0.22, excludedScored: 1, excludedOrigins: ['bet_engine'] },
      publishedByDomain: [{ domain: 'market', count: 1, brier: 0.04, yesCount: 1 }],
      uncertainty: {
        method: 'entry-level percentile bootstrap, 1000 resamples, seed 7072',
        overallBrier: { count: 1, mean: 0.04, ci95: [0.04, 0.04], insufficientSample: true },
      },
      funnel: {
        matured: 2, immature: 0, maturityUnknown: 0, resolved: 1, scored: 1, pendingHardMatured: 1, pendingJudgeMatured: 0,
        resolvedOfMatured: { count: 2, successes: 1, rate: 0.5, ci95: [0.094531, 0.905469] },
        scoredOfMatured: { count: 2, successes: 1, rate: 0.5, ci95: [0.094531, 0.905469] },
      },
      receipts: [{ question: 'Will Brent reach 104.89 USD/bbl?', forecastAt: 1, probability: 0.35, outcome: 'NO', resolvedAt: 2, sourceFeed: 'commodity-prices', observedValue: 100.75 }],
      degraded: false, stale: false, error: '',
    };
    const { fetchImpl } = createRedisFetch({});
    const stored: Record<string, unknown> = {
      [REDIS_KEY]: envelope({
        ...data,
        uncertainty: { ...data.uncertainty, skillBrier: null, draws: [0.1], overallBrier: { ...data.uncertainty.overallBrier, scope: 'overall' } },
        funnel: { ...data.funnel, entryIds: ['a'], resolvedOfMatured: { ...data.funnel.resolvedOfMatured, sampleIds: ['b'] } },
        receipts: data.receipts.map((row) => ({ ...row, key: 'ledger-key', rationale: 'judge text' })),
        judgedLane: { pendingJudge: 3 },
        betEngine: { count: 1, vsBaseRate: { brierDelta: 0.02 }, deviationSkill: { count: 1 } },
        futureInternalMetric: { syntheticMarker: 'not-part-of-response' },
      }),
      [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED),
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const key = decodeURIComponent(url.split('/get/')[1] ?? '');
      if (Object.hasOwn(stored, key)) return Response.json({ result: JSON.stringify(stored[key]) });
      assert.equal(new URL(url).origin, 'https://fake-upstash.example', 'all I/O must stay in the mock');
      return fetchImpl(input, init);
    };
    const response = await forecastRoute(new Request(makeCtx().request.url, {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
    }));
    assert.equal(response.status, 200);
    const serialized = await response.json();
    assert.deepEqual(Object.keys(serialized).sort(), [...SCORECARD_DECLARED_FIELDS].sort());
    assert.deepEqual(
      serialized,
      { ...data, marketAlerts: MARKET_ALERTS_SERVED },
      'every declared field must survive the real gateway and serializer, and a null interval is omitted',
    );
  });

  it('filters the market-alert block with the member lists the /accuracy/ page keeps', () => {
    const numbered = (fields: readonly string[]) => Object.fromEntries(fields.map((field, index) => [field, index + 1]));
    const selected = selectDeclaredScorecardFields({
      marketAlerts: {
        ...numbered([...MARKET_ALERT_FIELDS, 'schemaVersion', 'totals', 'archive']),
        byType: [numbered([...MARKET_ALERT_ROW_FIELDS, 'pending', 'resolved', 'hit', 'miss', 'void'])],
      },
    });
    assert.deepEqual(Object.keys(selected.marketAlerts).sort(), [...MARKET_ALERT_FIELDS].sort());
    assert.deepEqual(Object.keys(selected.marketAlerts.byType[0]).sort(), [...MARKET_ALERT_ROW_FIELDS].sort());
  });

  it('filters receipt rows with the member list the producer publishes', () => {
    assert.deepEqual([...RECEIPT_FIELDS], [...PUBLIC_RECEIPT_FIELDS]);
  });

  it('filters the interval and funnel blocks with the same member lists the /accuracy/ page uses', () => {
    for (const [block, { fields, children }] of Object.entries(SCORECARD_BLOCK_FIELDS)) {
      assert.deepEqual([...fields], [...SCORECARD_NESTED_OBJECT_FIELDS[block]], `${block} members`);
      assert.deepEqual(
        Object.fromEntries(Object.entries(children).map(([key, list]) => [key, [...list]])),
        Object.fromEntries(Object.entries(SCORECARD_NESTED_CHILD_FIELDS[block]).map(([key, list]) => [key, [...list]])),
        `${block} children`,
      );
    }
  });

  it('serves the market-alert scorecard from its own key, whitelisted member by member (#8867)', async () => {
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.deepEqual(res.marketAlerts, MARKET_ALERTS_SERVED);
    assert.equal(res.totals?.entries, 1);
    assert.equal(res.degraded, false);
  });

  it('serves the median lead time as a whole number of milliseconds, as int64 declares', async () => {
    const stored = { ...MARKET_ALERTS_STORED, byType: [{ ...MARKET_ALERTS_STORED.byType[0], medianLeadTimeMs: 1000.5 }] };
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(stored) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.marketAlerts?.byType[0]?.medianLeadTimeMs, 1001);
  });

  it('starts both Redis reads before either answers', async () => {
    const events: string[] = [];
    const stored: Record<string, unknown> = { [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope(MARKET_ALERTS_STORED) };
    globalThis.fetch = (async (input) => {
      const key = decodeURIComponent(String(input).split('/get/')[1] ?? '');
      events.push(`start ${key}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${key}`);
      return Response.json({ result: JSON.stringify(stored[key]) });
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.deepEqual(events.slice(0, 2).sort(), [`start ${MARKET_ALERTS_KEY}`, `start ${REDIS_KEY}`]);
    assert.deepEqual(res.marketAlerts, MARKET_ALERTS_SERVED);
  });

  it('omits marketAlerts when its key is missing', async () => {
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(Object.hasOwn(res, 'marketAlerts'), false);
    assert.equal(res.degraded, false);
  });

  it('omits marketAlerts when the stored value carries no finite generatedAt', async () => {
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA), [MARKET_ALERTS_KEY]: envelope({ ...MARKET_ALERTS_STORED, generatedAt: null }) });

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(Object.hasOwn(res, 'marketAlerts'), false);
  });

  it('omits marketAlerts and keeps the forecast scorecard undegraded when its read fails', async () => {
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    serveRedis({ [REDIS_KEY]: envelope(FORECAST_DATA) }, [MARKET_ALERTS_KEY]);

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(Object.hasOwn(res, 'marketAlerts'), false);
    assert.equal(res.degraded, false);
    assert.equal(res.error, '');
    assert.equal(res.totals?.entries, 1);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), /market-alerts/);
  });

  it('marks cached scorecards stale when the seed envelope is older than the health budget', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        result: JSON.stringify({
          _seed: {
            fetchedAt: Date.now() - 2161 * 60 * 1000,
            recordCount: 1,
            sourceVersion: 'test',
            schemaVersion: 1,
            state: 'OK',
          },
          data: {
            schemaVersion: 1,
            generatedAt: 456,
            rollingWindowDays: 180,
            methodology: 'test methodology',
            totals: { entries: 1, resolved: 1, pending: 0, pendingJudge: 0, scored: 1, void: 0, voidRate: 0, publicationCoverage: 1 },
          },
        }),
      }), { status: 200 });
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.degraded, false);
    assert.equal(res.stale, true);
  });

  it('returns a well-formed degraded empty response on backend failure', async () => {
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    globalThis.fetch = (async () => {
      throw new Error('redis unavailable');
    }) as typeof fetch;

    const res = await getForecastScorecard(makeCtx(), {});

    assert.equal(res.degraded, true);
    assert.equal(res.error, 'forecast_scorecard_backend_unavailable');
    assert.equal(res.generatedAt, 0);
    assert.equal(res.totals?.entries, 0);
    assert.deepEqual(errors, [
      ['[forecast] getForecastScorecard market-alerts read failed:', 'redis unavailable'],
      ['[forecast] getForecastScorecard getRawJson failed:', 'redis unavailable'],
    ]);
  });
});
