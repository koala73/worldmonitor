import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getUsCpiMonthly } from '../server/worldmonitor/economic/v1/get-us-cpi-monthly.ts';
import { getUsTreasuryParYieldCurve } from '../server/worldmonitor/economic/v1/get-us-treasury-par-yield-curve.ts';
import {
  CPI_CANONICAL_KEY,
  CPI_DECADE_STARTS,
  CPI_LATEST_KEY,
  buildUsCpiMonths,
  mergeCpiShards,
  percentChange,
} from '../server/worldmonitor/economic/v1/us-cpi-monthly.ts';
import {
  TREASURY_CANONICAL_KEY,
  TREASURY_LATEST_KEY,
  TREASURY_START_YEAR,
  YIELD_FIELDS,
  treasuryCurvesFromShards,
} from '../server/worldmonitor/economic/v1/us-treasury-par-yield.ts';
import {
  CPI_CANONICAL_KEY as SEEDED_CPI_KEY,
  CPI_DECADE_STARTS as SEEDED_DECADES,
  CPI_LATEST_KEY as SEEDED_CPI_LATEST,
  cpiDecadeShard,
  fredObservations,
  latestCpiWindow,
} from '../scripts/seed-us-cpi.mjs';
import {
  TENOR_TAGS,
  TREASURY_CANONICAL_KEY as SEEDED_TREASURY_KEY,
  TREASURY_LATEST_KEY as SEEDED_TREASURY_LATEST,
  TREASURY_START_YEAR as SEEDED_TREASURY_START,
  parseTreasuryYieldXml,
  treasuryYearShard,
} from '../scripts/seed-us-treasury-par-yield.mjs';

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

describe('US CPI changes', () => {
  const components = {
    headline: [
      { date: '2024-12-01', value: 100 },
      { date: '2025-01-01', value: 110 },
      { date: '2025-12-01', value: 120 },
      { date: '2026-01-01', value: 132 },
    ],
    energy: [{ date: '2026-02-01', value: 50 }],
  };

  it('computes a simple percent and leaves a gap without a change', () => {
    assert.equal(percentChange(110, 100), 10);
    assert.equal(percentChange(90, 100), -10);
    const months = buildUsCpiMonths({ components }, true);
    const january = months.find((month) => month.month === Date.parse('2025-01-01T00:00:00Z'));
    assert.equal(january?.headline?.monthOverMonth?.percent, 10);
    assert.equal(january?.headline?.yearOverYear, undefined);
    const december = months.find((month) => month.month === Date.parse('2025-12-01T00:00:00Z'));
    assert.equal(december?.headline?.monthOverMonth, undefined);
    assert.equal(december?.headline?.yearOverYear?.percent, 20);
    const nextJanuary = months.find((month) => month.month === Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(nextJanuary?.headline?.monthOverMonth?.percent, 10);
    assert.equal(nextJanuary?.headline?.yearOverYear?.percent, 20);
    const february = months.find((month) => month.month === Date.parse('2026-02-01T00:00:00Z'));
    assert.equal(february?.headline, undefined);
    assert.equal(february?.energy?.index, 50);
    assert.equal(february?.energy?.monthOverMonth, undefined);
  });

  it('returns only the latest month unless history is requested', () => {
    const latest = buildUsCpiMonths({ components }, false);
    assert.equal(latest.length, 1);
    assert.equal(latest[0]?.energy?.index, 50);
  });

  it('keeps month-over-month across a decade boundary', () => {
    const merged = mergeCpiShards([
      cpiDecadeShard({ components: { headline: [{ date: '2019-12-01', value: 200 }] } }, 2010),
      cpiDecadeShard({ components: { headline: [{ date: '2020-01-01', value: 210 }] } }, 2020),
    ]);
    const months = buildUsCpiMonths(merged, true);
    assert.equal(months.at(-1)?.headline?.monthOverMonth?.percent, 5);
  });

  it('drops FRED missing sentinels and keeps the month start', () => {
    assert.deepEqual(fredObservations({
      observations: [
        { date: '1947-01-01', value: '21.48' },
        { date: '1947-02-01', value: '.' },
      ],
    }), [{ date: '1947-01-01', value: 21.48 }]);
  });

  it('windows the latest print on the headline month', () => {
    const windowed = latestCpiWindow({ components });
    assert.deepEqual(windowed.components.headline.map((point: { date: string }) => point.date), [
      '2025-01-01',
      '2025-12-01',
      '2026-01-01',
    ]);
    assert.deepEqual(windowed.components.energy, []);
  });
});

describe('Treasury par yield XML', () => {
  const xml = `<?xml version="1.0"?>
<feed>
<entry><m:properties>
<d:NEW_DATE m:type="Edm.DateTime">1990-01-02T00:00:00</d:NEW_DATE>
<d:BC_3MONTH m:type="Edm.Double">7.83</d:BC_3MONTH>
<d:BC_30YEAR m:type="Edm.Double">8.00</d:BC_30YEAR>
<d:BC_30YEARDISPLAY m:type="Edm.Double">9.99</d:BC_30YEARDISPLAY>
<d:BC_1MONTH m:type="Edm.Double" m:null="true" />
</m:properties></entry>
<entry><m:properties>
<d:NEW_DATE m:type="Edm.DateTime">2026-09-21T00:00:00</d:NEW_DATE>
<d:BC_1MONTH m:type="Edm.Double">3.96</d:BC_1MONTH>
<d:BC_10YEAR m:type="Edm.Double">4.90</d:BC_10YEAR>
<d:BC_30YEAR m:type="Edm.Double">5.20</d:BC_30YEAR>
</m:properties></entry>
<entry><m:properties>
<d:NEW_DATE m:type="Edm.DateTime">2026-09-21T00:00:00</d:NEW_DATE>
<d:BC_1MONTH m:type="Edm.Double">3.96</d:BC_1MONTH>
<d:BC_10YEAR m:type="Edm.Double">4.96</d:BC_10YEAR>
<d:BC_20YEAR m:type="Edm.Double" m:null="true" />
<d:BC_30YEAR m:type="Edm.Double">5.29</d:BC_30YEAR>
<d:BC_30YEARDISPLAY m:type="Edm.Double">9.99</d:BC_30YEARDISPLAY>
</m:properties></entry>
</feed>`;

  it('parses business days, ignores the display twin, and keeps the later duplicate', () => {
    const curves = parseTreasuryYieldXml(xml);
    assert.equal(curves.length, 2);
    assert.equal(curves[0].date, '1990-01-02');
    assert.equal(curves[0].threeMonth, 7.83);
    assert.equal(curves[0].thirtyYear, 8);
    assert.equal(curves[0].oneMonth, undefined);
    assert.equal(curves[1].tenYear, 4.96);
    assert.equal(curves[1].thirtyYear, 5.29);
    assert.equal(curves[1].twentyYear, undefined);
    assert.equal('thirtyYearDisplay' in curves[1], false);
  });

  it('splits a year without dropping a tenor', () => {
    const shard = treasuryYearShard({ curves: parseTreasuryYieldXml(xml) }, 2026);
    assert.equal(shard.curves.length, 1);
    assert.equal(shard.curves[0].tenYear, 4.96);
  });

  it('merges year shards into ascending business days', () => {
    const curves = treasuryCurvesFromShards([
      { curves: [{ date: '2026-09-21', tenYear: 4.96 }] },
      { curves: [{ date: '1990-01-02', threeMonth: 7.83 }] },
      { date: '2026-09-18', twoYear: 4.67 },
    ]);
    assert.deepEqual(curves.map((curve) => curve.date), [
      Date.parse('1990-01-02T00:00:00Z'),
      Date.parse('2026-09-18T00:00:00Z'),
      Date.parse('2026-09-21T00:00:00Z'),
    ]);
    assert.equal(curves[2]?.tenYear, 4.96);
  });
});

describe('seed and handler keys', () => {
  it('uses one Redis key for each CPI and Treasury document', () => {
    assert.equal(SEEDED_CPI_KEY, CPI_CANONICAL_KEY);
    assert.equal(SEEDED_CPI_LATEST, CPI_LATEST_KEY);
    assert.deepEqual(SEEDED_DECADES, [...CPI_DECADE_STARTS]);
    assert.equal(SEEDED_TREASURY_KEY, TREASURY_CANONICAL_KEY);
    assert.equal(SEEDED_TREASURY_LATEST, TREASURY_LATEST_KEY);
    assert.equal(SEEDED_TREASURY_START, TREASURY_START_YEAR);
    assert.deepEqual(TENOR_TAGS.map(([, field]) => field), [...YIELD_FIELDS]);
  });
});

describe('CPI and Treasury handlers', () => {
  it('returns the latest CPI month from the small key', async () => {
    redisEnv();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input));
      assert.match(url, /us-cpi:latest/);
      return redisResult({
        components: {
          headline: [
            { date: '2025-08-01', value: 300 },
            { date: '2026-08-01', value: 309 },
          ],
        },
      });
    }) as typeof fetch;

    const response = await getUsCpiMonthly({} as never, { history: false });
    assert.equal(response.unavailable, false);
    assert.equal(response.months.length, 1);
    assert.equal(response.months[0]?.headline?.index, 309);
    assert.equal(response.months[0]?.headline?.yearOverYear?.percent, 3);
  });

  it('merges CPI decade shards when history is requested', async () => {
    redisEnv();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const pipeline = JSON.parse(String(init?.body)) as string[][];
      assert.equal(pipeline.length, CPI_DECADE_STARTS.length);
      const results = pipeline.map((command) => {
        const key = command[1] ?? '';
        if (key.endsWith(':2010')) {
          return { result: JSON.stringify({ components: { headline: [{ date: '2019-12-01', value: 200 }] } }) };
        }
        if (key.endsWith(':2020')) {
          return { result: JSON.stringify({ components: { headline: [{ date: '2020-01-01', value: 220 }] } }) };
        }
        return { result: null };
      });
      return new Response(JSON.stringify(results), { status: 200 });
    }) as typeof fetch;

    const response = await getUsCpiMonthly({} as never, { history: true });
    assert.equal(response.unavailable, false);
    assert.equal(response.months.length, 2);
    assert.equal(response.months[1]?.headline?.monthOverMonth?.percent, 10);
  });

  it('returns unavailable when the curve has not been seeded', async () => {
    redisEnv();
    globalThis.fetch = (async () => redisResult(null)) as typeof fetch;
    const response = await getUsTreasuryParYieldCurve({} as never, { history: false });
    assert.equal(response.unavailable, true);
    assert.deepEqual(response.curves, []);
  });

  it('returns the latest par curve without reading the history shards', async () => {
    redisEnv();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      assert.match(decodeURIComponent(String(input)), /us-treasury-par-yield:latest/);
      return redisResult({ date: '2026-09-21', oneMonth: 3.96, tenYear: 4.96, thirtyYear: 5.29 });
    }) as typeof fetch;

    const response = await getUsTreasuryParYieldCurve({} as never, { history: false });
    assert.equal(response.unavailable, false);
    assert.equal(response.curves.length, 1);
    assert.equal(response.curves[0]?.date, Date.parse('2026-09-21T00:00:00Z'));
    assert.equal(response.curves[0]?.oneMonth, 3.96);
    assert.equal(response.curves[0]?.twentyYear, undefined);
  });
});
