import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getUsInterestRates } from '../server/worldmonitor/economic/v1/get-us-interest-rates.ts';
import {
  RATE_SERIES as SERVER_SERIES,
  RATES_CANONICAL_KEY,
  RATES_DECADES as SERVER_DECADES,
  buildUsInterestRates,
  mergeRateHistories,
  normalizeRatePoints,
  rateSeriesDecadeKey,
} from '../server/worldmonitor/economic/v1/us-interest-rates.ts';
import {
  RATE_SERIES as SEEDED_SERIES,
  RATES_CANONICAL_KEY as SEEDED_KEY,
  RATES_DECADES as SEEDED_DECADES,
  fredRateObservations,
  interestRateShardKeys,
  rateDecadeShard,
  rateSeriesDecadeKey as seededDecadeKey,
  rateSnapshot,
  validateRateHistory,
} from '../scripts/seed-us-interest-rates.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  LOCAL_API_MODE: process.env.LOCAL_API_MODE,
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function redisEnv(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  delete process.env.LOCAL_API_MODE;
}

function redisResult(value: unknown): Response {
  return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function dailyPoints(start: string, count: number, value = 1): Array<{ date: string; value: number }> {
  const points = [];
  let cursor = Date.parse(`${start}T00:00:00Z`);
  for (let index = 0; index < count; index += 1) {
    points.push({ date: new Date(cursor).toISOString().slice(0, 10), value: index === 3 ? 0 : value });
    cursor += 86_400_000;
  }
  return points;
}

describe('US interest rate history', () => {
  it('keeps a zero print and drops the FRED missing sentinel', () => {
    const points = fredRateObservations({
      observations: [
        { date: '2026-09-18', value: '0' },
        { date: '2026-09-19', value: '.' },
        { date: '2026-09-17', value: '3.88' },
      ],
    });
    assert.deepEqual(points, [
      { date: '2026-09-17', value: 3.88 },
      { date: '2026-09-18', value: 0 },
    ]);
  });

  it('returns one latest print per series unless history is requested', () => {
    const snapshot = {
      fedFundsEffective: { date: '2026-09-18', value: 3.88 },
      sofr: { date: '2026-09-18', value: 3.91 },
    };
    const latestOnly = buildUsInterestRates(snapshot, undefined, false);
    assert.equal(latestOnly.unavailable, false);
    assert.equal(latestOnly.series.length, 2);
    const effective = latestOnly.series.find((row) => row.id === 'fed_funds_effective');
    assert.equal(effective?.points.length, 1);
    assert.equal(effective?.points[0]?.percent, 3.88);
    assert.equal(effective?.points[0]?.date, Date.parse('2026-09-18T00:00:00Z'));
    assert.equal(latestOnly.series.find((row) => row.id === 'sofr')?.points[0]?.percent, 3.91);

    const withHistory = buildUsInterestRates(snapshot, {
      sofr: [
        { date: '2018-04-03', value: 1.8 },
        { date: '2018-04-02', value: 1.83 },
      ],
    }, true);
    assert.deepEqual(
      withHistory.series.find((row) => row.id === 'sofr')?.points.map((point) => point.percent),
      [1.83, 1.8, 3.91],
    );
  });

  it('splits a series on the decade and keeps the later duplicate', () => {
    const shard = rateDecadeShard({
      series: {
        fedFundsEffective: [
          { date: '2019-12-31', value: 1.5 },
          { date: '2020-01-02', value: 1.55 },
          { date: '2020-01-02', value: 1.56 },
        ],
      },
    }, 'fedFundsEffective', 2020);
    assert.deepEqual(shard.points.map((point) => point.date), ['2020-01-02', '2020-01-02']);
    assert.deepEqual(normalizeRatePoints(shard.points), [{ date: '2020-01-02', value: 1.56 }]);
  });

  it('rejects a truncated effective-rate history', () => {
    const series: Record<string, Array<{ date: string; value: number }>> = {};
    for (const item of SEEDED_SERIES) {
      const start = item.startsWith.length === 10
        ? item.startsWith
        : item.startsWith.length === 7
          ? `${item.startsWith}-01`
          : `${item.startsWith}1-01-01`;
      series[item.id] = dailyPoints(start, item.minPoints);
    }
    assert.equal(validateRateHistory({ series }), true);
    series.fedFundsEffective = series.fedFundsEffective.slice(0, 120);
    assert.equal(validateRateHistory({ series }), false);
  });

  it('uses the same Redis keys as the seeder', () => {
    assert.equal(RATES_CANONICAL_KEY, SEEDED_KEY);
    assert.deepEqual(SERVER_DECADES, SEEDED_DECADES);
    assert.deepEqual(
      SERVER_SERIES.map((series) => [series.id, series.fredId, series.redisSuffix]),
      SEEDED_SERIES.map((series) => [series.id, series.fredId, series.redisSuffix]),
    );
    assert.equal(
      rateSeriesDecadeKey('sofr', 2020),
      seededDecadeKey('sofr', 2020),
    );
    assert.equal(rateSnapshot({ series: { sofr: [{ date: '2026-09-18', value: 3.91 }] } }).sofr.value, 3.91);
  });

  it('publishes one decade shard for every series', () => {
    const keys = interestRateShardKeys();
    assert.equal(keys.length, SEEDED_SERIES.length * SEEDED_DECADES.length);
    assert.equal(new Set(keys.map((item) => item.key)).size, keys.length);
    assert.equal(keys.every((item) => item.skipWhenEmpty === true && item.allowMissingOnSkip === true), true);
    const sofr2020 = keys.find((item) => item.key === seededDecadeKey('sofr', 2020));
    assert.ok(sofr2020);
    assert.deepEqual(
      sofr2020.transform({
        series: {
          sofr: [
            { date: '2019-12-31', value: 1.5 },
            { date: '2020-04-01', value: 0.01 },
          ],
        },
      }),
      { points: [{ date: '2020-04-01', value: 0.01 }] },
    );
  });
});

describe('US interest rate handler', () => {
  it('reads only the snapshot key for the current print', async () => {
    redisEnv();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input));
      assert.match(url, new RegExp(`${RATES_CANONICAL_KEY}$`));
      return redisResult({
        fedFundsEffective: { date: '2026-09-18', value: 0 },
        sofr: { date: '2026-09-18', value: 3.91 },
      });
    }) as typeof fetch;

    const response = await getUsInterestRates({} as never, { history: false });
    assert.equal(response.unavailable, false);
    assert.equal(response.series.find((row) => row.id === 'fed_funds_effective')?.points[0]?.percent, 0);
    assert.equal(response.series.find((row) => row.id === 'fed_funds_effective')?.points.length, 1);
  });

  it('merges decade shards when history is requested', async () => {
    redisEnv();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body) return redisResult({ fedFundsEffective: { date: '2026-09-18', value: 3.88 } });
      const pipeline = JSON.parse(String(init.body)) as string[][];
      assert.equal(pipeline.length, SERVER_SERIES.length * SERVER_DECADES.length);
      const results = pipeline.map((command) => {
        const key = command[1] ?? '';
        if (key.endsWith('fed-funds-effective:2020')) {
          return { result: JSON.stringify({ points: [{ date: '2020-01-02', value: 1.55 }] }) };
        }
        return { result: null };
      });
      return new Response(JSON.stringify(results), { status: 200 });
    }) as typeof fetch;

    const response = await getUsInterestRates({} as never, { history: true });
    assert.equal(response.unavailable, false);
    const effective = response.series.find((row) => row.id === 'fed_funds_effective');
    assert.equal(effective?.points[0]?.percent, 1.55);
    assert.equal(effective?.points.at(-1)?.percent, 3.88);
  });

  it('returns unavailable when history is requested but no shard contributed points', async () => {
    redisEnv();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body) {
        return redisResult({ fedFundsEffective: { date: '2026-09-18', value: 3.88 } });
      }
      return new Response('pipeline failed', { status: 500 });
    }) as typeof fetch;

    const response = await getUsInterestRates({} as never, { history: true });
    assert.equal(response.unavailable, true);
    assert.deepEqual(response.series, []);
  });

  it('returns unavailable when nothing has been seeded', async () => {
    redisEnv();
    globalThis.fetch = (async () => redisResult(null)) as typeof fetch;
    const response = await getUsInterestRates({} as never, { history: false });
    assert.equal(response.unavailable, true);
    assert.deepEqual(response.series, []);
  });

  it('builds the latest print from history when the snapshot key is empty', () => {
    const histories = mergeRateHistories([
      ['economic:us-interest-rates:v1:sofr:2010', [{ date: '2018-04-02', value: 1.8 }]],
      ['economic:us-interest-rates:v1:sofr:2020', [{ date: '2026-09-18', value: 3.91 }]],
    ]);
    const response = buildUsInterestRates(undefined, histories, true);
    const sofr = response.series.find((row) => row.id === 'sofr');
    assert.equal(sofr?.points.at(-1)?.percent, 3.91);
    assert.equal(sofr?.points.length, 2);
  });
});
