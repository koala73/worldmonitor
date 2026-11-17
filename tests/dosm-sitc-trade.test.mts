import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  SITC_SECTIONS,
  buildSitcTradePayload,
  countSitcTradeMonths,
  validateSitcTradePayload,
} from '../scripts/_dosm-sitc-trade.mjs';
import { SITC_TRADE_MY_KEY, sitcTradeContentMeta } from '../scripts/seed-trade-sitc-my.mjs';
import {
  DEFAULT_SITC_MONTHS,
  SITC_SECTION_ORDER,
  SITC_TRADE_SEED_KEYS,
  getMonthlySitcTrade,
  normalizeSitcRequest,
} from '../server/worldmonitor/trade/v1/get-monthly-sitc-trade';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/dosm-trade/${name}`, import.meta.url), 'utf8');
const TRADE = fixture('trade_sitc_1d.csv');
const INDEX = fixture('tradeidx.csv');
const FETCHED_AT = '2026-11-17T08:00:00.000Z';

describe('DOSM SITC trade producer', () => {
  it('keeps every section in SITC order with whole-ringgit values and attaches indices by month', () => {
    const data = buildSitcTradePayload(TRADE, INDEX, FETCHED_AT);
    assert.deepEqual(data.sections.map((section) => section.section), [...SITC_SECTION_ORDER]);
    assert.deepEqual(SITC_SECTIONS, [...SITC_SECTION_ORDER]);
    assert.equal(data.currency, 'MYR');
    assert.equal(data.latestMonth, '2026-09');
    assert.equal(data.latestIndexMonth, '2026-08');
    assert.equal(countSitcTradeMonths(data), 99);
    const food = data.sections.find((section) => section.section === '0')!;
    assert.equal(food.label, 'Food');
    assert.deepEqual(food.months.at(-1), { month: '2026-09', exports: 4834780427, imports: 7086989476 });
    assert.deepEqual(food.months.at(-2), {
      month: '2026-08', exports: 4264769233, imports: 6472866499,
      exportsUnitValueIndex: 243.0974, exportsVolumeIndex: 93.9306, importsUnitValueIndex: 161.9198, importsVolumeIndex: 158.6193,
    });
    // Whole ringgit: September 2026 total exports are about RM 215 billion, not 215 trillion.
    const overall = data.sections.find((section) => section.section === 'overall')!;
    assert.equal(overall.months.at(-1)!.exports, 215112665290);
    assert.deepEqual(sitcTradeContentMeta(data), { newestItemAt: Date.parse('2026-09-01T00:00:00Z'), oldestItemAt: Date.parse('2026-01-01T00:00:00Z') });
  });

  it('rejects format, section, duplicate, coverage and unit drift instead of publishing it', () => {
    assert.throws(() => buildSitcTradePayload(TRADE.replace('date,section,exports,imports', 'date,section,exports'), INDEX), /format changed/);
    assert.throws(() => buildSitcTradePayload(TRADE.replace('2026-09-01,0,', '2026-09-01,10,'), INDEX), /section changed/);
    assert.throws(() => buildSitcTradePayload(TRADE.replace('2026-09-01,0,', '2026-09-15,0,'), INDEX), /date changed/);
    assert.throws(() => buildSitcTradePayload(TRADE.replace('2026-09-01,1,', '2026-09-01,0,'), INDEX), /duplicate/);
    const withoutFood = TRADE.split('\n').filter((line) => !line.startsWith('2026-05-01,0,')).join('\n');
    assert.throws(() => buildSitcTradePayload(withoutFood, INDEX), /does not cover every overall month/);
    // A section reported in millions while the total stays in ringgit no longer sums.
    assert.throws(() => buildSitcTradePayload(TRADE.replace('2026-09-01,0,4834780427,', '2026-09-01,0,4834.780427,'), INDEX), /do not sum/);
    assert.throws(() => buildSitcTradePayload(TRADE.replace('2026-09-01,0,4834780427,', '2026-09-01,0,,'), INDEX), /value invalid/);
    assert.throws(() => buildSitcTradePayload(TRADE, INDEX.replace('2026-08-01,0,243.0974', '2026-08-01,0,0')), /value invalid/);
  });

  it('ignores index months the trade release has not reached', () => {
    const ahead = `${INDEX.trimEnd()}\n2026-10-01,0,250,90,160,150,150\n`;
    assert.equal(buildSitcTradePayload(TRADE, ahead).latestIndexMonth, '2026-08');
  });

  it('accepts only full-history payloads with a recent newest month', () => {
    const data = buildSitcTradePayload(TRADE, INDEX);
    const now = new Date('2026-11-17T00:00:00Z');
    assert.equal(validateSitcTradePayload(data, now), false, 'nine months is not the 1990 history');
    const long = { ...data, sections: data.sections.map((section) => ({ ...section, months: Array.from({ length: 441 }, (_, i) => ({ month: String(i) })) })) };
    assert.equal(validateSitcTradePayload(long, now), true);
    assert.equal(validateSitcTradePayload({ ...long, latestMonth: '2026-03' }, now), false, 'a stalled publisher must not refresh seed-meta');
    assert.equal(validateSitcTradePayload({ ...long, sections: long.sections.slice(1) }, now), false);
  });
});

describe('GetMonthlySitcTrade handler', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, mode: process.env.LOCAL_API_MODE };
  const seeded = buildSitcTradePayload(TRADE, INDEX, FETCHED_AT);
  let reads: string[] = [];

  function serve(result: (key: string) => Response) {
    globalThis.fetch = (async (url: string | URL) => {
      const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
      reads.push(key);
      return result(key);
    }) as typeof fetch;
  }
  const envelope = (data: unknown) => new Response(JSON.stringify({ result: JSON.stringify({ _seed: { fetchedAt: Date.now(), recordCount: 99, sourceVersion: 'test', schemaVersion: 1, state: 'OK' }, data }) }));

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    delete process.env.LOCAL_API_MODE;
    reads = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [['UPSTASH_REDIS_REST_URL', originalEnv.url], ['UPSTASH_REDIS_REST_TOKEN', originalEnv.token], ['LOCAL_API_MODE', originalEnv.mode]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('reads the seeder key and serves requested sections sliced to the newest months', async () => {
    assert.equal(SITC_TRADE_SEED_KEYS.MY, SITC_TRADE_MY_KEY);
    serve(() => envelope(seeded));
    const res = await getMonthlySitcTrade({} as never, { country: '', sections: ['4', '0'], months: 3 });
    assert.deepEqual(reads, [SITC_TRADE_MY_KEY]);
    assert.equal(res.unavailableReason, 'TRADE_FLOW_UNAVAILABLE_REASON_UNSPECIFIED');
    assert.equal(res.country, 'MY');
    assert.equal(res.currency, 'MYR');
    assert.equal(res.latestMonth, '2026-09');
    assert.equal(res.latestIndexMonth, '2026-08');
    assert.equal(res.fetchedAt, FETCHED_AT);
    assert.deepEqual(res.series.map((series) => series.section), ['0', '4'], 'SITC order, not request order');
    assert.deepEqual(res.series[0]!.months.map((month) => month.month), ['2026-07', '2026-08', '2026-09']);
    assert.equal(res.series[0]!.months[2]!.exportsUnitValueIndex, undefined);
    assert.equal(res.series[0]!.months[1]!.exportsUnitValueIndex, 243.0974);
  });

  it('defaults to every section and sixty months', async () => {
    serve(() => envelope(seeded));
    assert.deepEqual(normalizeSitcRequest({ country: '', sections: [], months: 0 }), { country: 'MY', sections: [...SITC_SECTION_ORDER], months: DEFAULT_SITC_MONTHS });
    const res = await getMonthlySitcTrade({} as never, { country: 'MY', sections: [], months: 0 });
    assert.equal(res.series.length, 11);
    assert.equal(res.series[0]!.months.length, 9);
  });

  it('tells an uncovered country from a missing seed and a failed read', async () => {
    serve(() => envelope(seeded));
    const uncovered = await getMonthlySitcTrade({} as never, { country: 'TH', sections: [], months: 0 });
    assert.deepEqual([uncovered.unavailableReason, uncovered.upstreamUnavailable, reads.length], ['TRADE_FLOW_UNAVAILABLE_REASON_NOT_COVERED', false, 0]);

    serve(() => new Response(JSON.stringify({ result: null })));
    const missing = await getMonthlySitcTrade({} as never, { country: 'MY', sections: [], months: 0 });
    assert.deepEqual([missing.unavailableReason, missing.upstreamUnavailable, missing.series.length], ['TRADE_FLOW_UNAVAILABLE_REASON_SEED_MISSING', true, 0]);

    serve(() => new Response('down', { status: 503 }));
    const failed = await getMonthlySitcTrade({} as never, { country: 'MY', sections: [], months: 0 });
    assert.deepEqual([failed.unavailableReason, failed.upstreamUnavailable], ['TRADE_FLOW_UNAVAILABLE_REASON_CACHE_UNAVAILABLE', true]);
  });

  it('rejects malformed requests that bypass route validation and drops malformed seeded months', async () => {
    for (const req of [{ country: 'my', sections: [], months: 0 }, { country: '', sections: ['10'], months: 0 }, { country: '', sections: [], months: 481 }]) {
      const res = await getMonthlySitcTrade({} as never, req);
      assert.equal(res.unavailableReason, 'TRADE_FLOW_UNAVAILABLE_REASON_INVALID_REQUEST');
    }
    const corrupt = structuredClone(seeded);
    corrupt.sections[0]!.months.push({ month: '2026-13', exports: 1, imports: 1 }, { month: '2026-10', exports: -1, imports: 1 } as never);
    serve(() => envelope(corrupt));
    const res = await getMonthlySitcTrade({} as never, { country: 'MY', sections: ['0'], months: 2 });
    assert.deepEqual(res.series[0]!.months.map((month) => month.month), ['2026-08', '2026-09']);
  });
});
