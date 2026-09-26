import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { getGovernmentYieldCurve } from '../server/worldmonitor/economic/v1/get-government-yield-curve.ts';
import {
  COVERED_MARKETS,
  OECD_LT_KEY,
  findCoveredMarket,
  govYieldCanonicalKey,
  govYieldCurveFromLatest,
  govYieldCurvesFromShards,
  govYieldLatestKey,
  govYieldYearKey,
} from '../server/worldmonitor/economic/v1/government-yield-curves.ts';
import {
  collapseCurves,
  mergeCurveHistory,
  normalizeDateLabel,
  parseYieldNumber,
  yearShard,
} from '../scripts/lib/yield-curves/model.mjs';
import { parseJgbCsv } from '../scripts/lib/yield-curves/jgb.mjs';
import { parseBocBenchmarkCsv, parseBocTbillCsv, mergeBocCurves } from '../scripts/lib/yield-curves/boc.mjs';
import { parseBundesbankCsv } from '../scripts/lib/yield-curves/bundesbank.mjs';
import { parseBoeNominalWorkbook } from '../scripts/lib/yield-curves/boe.mjs';
import { fetchBoeCurve } from '../scripts/seed-yield-curve-gb.mjs';
import { latestTransform } from '../scripts/seed-oecd-lt-rates.mjs';
import { parseRbaCsv } from '../scripts/lib/yield-curves/rba.mjs';
import { parseSnbConfederationCsv } from '../scripts/lib/yield-curves/snb.mjs';
import { parseNorgesZeroCouponCsv } from '../scripts/lib/yield-curves/norges.mjs';
import { parseRiksbankObservations } from '../scripts/lib/yield-curves/riksbank.mjs';
import { parseChinaBondSearch } from '../scripts/lib/yield-curves/chinabond.mjs';
import {
  OECD_LT_MARKETS,
  buildOecdLtPayload,
  declareOecdRecords,
  parseFredCsv,
} from '../scripts/lib/yield-curves/oecd-lt.mjs';
import {
  activationKey,
  canonicalKey as seederCanonicalKey,
  latestExtraKeyEntry,
  latestKey as seederLatestKey,
  makeValidate,
  yearExtraKeyEntry,
  yearKey as seederYearKey,
} from '../scripts/seed-yield-curves-shared.mjs';

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

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/yield-curves/${name}`, import.meta.url), 'utf8');
}

describe('yield-curve model helpers', () => {
  it('normalizes both date dialects and rejects junk', () => {
    assert.equal(normalizeDateLabel('2026/9/1'), '2026-09-01');
    assert.equal(normalizeDateLabel('1990-01-02'), '1990-01-02');
    assert.equal(normalizeDateLabel('not-a-date'), null);
    assert.equal(normalizeDateLabel('2026-13-45'), null);
  });

  it('coerces European decimal commas and treats missing markers as null', () => {
    assert.equal(parseYieldNumber('3,52'), 3.52);
    assert.equal(parseYieldNumber('3.52'), 3.52);
    assert.equal(parseYieldNumber('-'), null);
    assert.equal(parseYieldNumber('.'), null);
    assert.equal(parseYieldNumber(''), null);
    assert.equal(parseYieldNumber(2.5), 2.5);
    assert.equal(parseYieldNumber(Number.NaN), null);
  });

  it('collapses duplicate dates with later tenors winning', () => {
    const collapsed = collapseCurves([
      { date: '2026-01-02', tenors: { '1y': 1.0, '2y': 2.0 } },
      { date: '2026-01-01', tenors: { '1y': 0.9 } },
      { date: '2026-01-02', tenors: { '2y': 2.5, '5y': 5.0 } },
    ]);
    assert.deepEqual(collapsed.map((c) => c.date), ['2026-01-01', '2026-01-02']);
    assert.deepEqual(collapsed[1].tenors, { '1y': 1.0, '2y': 2.5, '5y': 5.0 });
  });

  it('accumulates history across read-merge-write cycles without losing old days', () => {
    const previous = { curves: [{ date: '2026-01-01', tenors: { '1y': 1.0 } }] };
    const merged = mergeCurveHistory(previous, [
      { date: '2026-01-02', tenors: { '1y': 1.1 } },
      { date: '2026-01-01', tenors: { '1y': 1.05 } },
    ]);
    assert.equal(merged.curves.length, 2);
    assert.equal(merged.curves[0].tenors['1y'], 1.05); // newest print wins
    assert.equal(merged.curves[1].tenors['1y'], 1.1);
    // A null previous (cold start) still works.
    assert.equal(mergeCurveHistory(null, merged.curves).curves.length, 2);
  });

  it('slices year shards by date prefix', () => {
    const payload = { curves: [
      { date: '2025-12-31', tenors: { '1y': 1 } },
      { date: '2026-01-02', tenors: { '1y': 2 } },
      { date: '2026-06-01', tenors: { '1y': 3 } },
    ] };
    assert.deepEqual(yearShard(payload, 2026).curves.map((c) => c.date), ['2026-01-02', '2026-06-01']);
    assert.deepEqual(yearShard(payload, 1990).curves, []);
  });
});

describe('per-source parsers (captured fixtures)', () => {
  it('parses MOF JGB history: 40Y tail, dash-missing tenors, 1974 start', () => {
    const curves = parseJgbCsv(fixture('jgb-all.csv'));
    assert.equal(curves.length, 4);
    assert.equal(curves[0].date, '1974-09-24');
    // 1974: 1Y-9Y only; 15Y+ are dashes and must be absent, not zero.
    assert.deepEqual(Object.keys(curves[0].tenors), ['1y', '2y', '3y', '4y', '5y', '6y', '7y', '8y', '9y']);
    const latest = curves[curves.length - 1];
    assert.equal(latest.date, '2026-08-31');
    assert.equal(latest.tenors['40y'], 4.094);
    assert.equal(latest.tenors['10y'], 2.943);
  });

  it('parses BoC benchmark CSV: RRB excluded, LONG mapped to 30y', () => {
    const benchmark = parseBocBenchmarkCsv(fixture('boc-benchmark.csv'));
    assert.equal(benchmark.length, 4);
    assert.equal(benchmark[0].date, '2001-01-02');
    assert.deepEqual(
      Object.keys(benchmark[0].tenors).sort(),
      ['10y', '2y', '30y', '3y', '5y', '7y'],
    );
    const latest = benchmark[benchmark.length - 1];
    assert.equal(latest.date, '2026-09-21');
    assert.equal(latest.tenors['30y'], 4.16);
  });

  it('parses BoC T-bill daily averages and merges with the benchmark group', () => {
    const tbill = parseBocTbillCsv(fixture('boc-tbill.csv'));
    assert.equal(tbill.length, 2);
    assert.deepEqual(Object.keys(tbill[0].tenors).sort(), ['1m', '1y', '3m', '6m']);
    // The fixture slices cover different eras, so merging proves date-union
    // behavior rather than same-date tenor join.
    const merged = mergeBocCurves(parseBocBenchmarkCsv(fixture('boc-benchmark.csv')), tbill);
    assert.equal(merged.length, 6);
    const dates = merged.map((c) => c.date);
    assert.ok(dates.includes('2000-01-05'), 'tbill-only date survives the merge');
    assert.ok(dates.includes('2001-01-02'), 'benchmark-only date survives the merge');
  });

  it('parses Bundesbank SDMX par CSV: comma decimals, dot-missing columns', () => {
    const curves = parseBundesbankCsv(fixture('bundesbank-par.csv'));
    assert.equal(curves.length, 2);
    assert.equal(curves[0].date, '2026-09-21');
    assert.equal(curves[0].tenors['10y'], 3.49);
    assert.equal(curves[1].tenors['30y'], 3.78);
    // The 12 intermediate tenor columns (4y..9y etc.) are all present.
    assert.equal(Object.keys(curves[0].tenors).length, 13);
  });

  it('parses the BoE nominal workbook: spot grid plus short-end months', async () => {
    const { default: JSZip } = await import('jszip');
    const { default: ExcelJS } = await import('exceljs');
    const zip = await JSZip.loadAsync(readFileSync(new URL('./fixtures/yield-curves/boe-latest.zip', import.meta.url)));
    const name = Object.keys(zip.files).find((n) => /GLC Nominal daily data/i.test(n));
    assert.ok(name);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await zip.file(name!).async('nodebuffer'));
    const curves = parseBoeNominalWorkbook(workbook);
    assert.equal(curves.length, 15);
    const first = curves[0];
    assert.equal(first.date, '2026-09-01');
    assert.equal(first.tenors['1y'], 4.233668191992384);
    assert.ok(Object.keys(first.tenors).includes('30y'));
    assert.ok(Object.keys(first.tenors).includes('9m'), 'short-end months are folded in');
  });

  it('parses the RBA F2 CSV: four nominal tenors, indexed bond excluded', () => {
    const curves = parseRbaCsv(fixture('rba-f2-data.csv'));
    assert.equal(curves.length, 4);
    assert.equal(curves[0].date, '2013-05-20');
    // 2013-05-20 carried only the 10Y print.
    assert.deepEqual(Object.keys(curves[0].tenors), ['10y']);
    const latest = curves[curves.length - 1];
    assert.equal(latest.date, '2026-09-16');
    assert.deepEqual(Object.keys(latest.tenors).sort(), ['10y', '2y', '3y', '5y']);
  });

  it('parses the SNB daily Confederation cube, dropping valueless rows', () => {
    const curves = parseSnbConfederationCsv(fixture('snb-confederation.csv'));
    // The first business day has no published 30Y value; do not fill it
    // from the complete modern curve.
    assert.equal(curves.length, 3);
    assert.equal(curves[0].date, '1988-01-04');
    assert.equal(curves[0].tenors['30y'], undefined);
    const latest = curves.at(-1)!;
    assert.equal(latest.date, '2026-09-22');
    assert.equal(latest.tenors['30y'], 0.551);
    assert.equal(latest.tenors['10y'], 0.564);
    assert.deepEqual(
      Object.keys(latest.tenors).sort(),
      ['10y', '1y', '20y', '2y', '30y', '3y', '4y', '5y', '6y', '7y', '8y', '9y'],
    );
  });

  it('parses Norges Bank zero-coupon SDMX: 6m..10y tenors', () => {
    const curves = parseNorgesZeroCouponCsv(fixture('norges-zero.csv'));
    assert.equal(curves.length, 4);
    assert.equal(curves[0].date, '2015-01-02');
    assert.deepEqual(
      Object.keys(curves[curves.length - 1].tenors).sort(),
      ['10y', '1y', '2y', '3y', '4y', '5y', '6m', '6y', '7y', '8y', '9m', '9y'],
    );
    assert.equal(curves[curves.length - 1].tenors['10y'], 4.352);
  });

  it('parses Riksbank SWEA observations into per-tenor curves', () => {
    const observations = JSON.parse(fixture('riksbank-segvb10yc.json'));
    const curves = parseRiksbankObservations('SEGVB10YC', observations);
    assert.equal(curves.length, 4);
    assert.equal(curves[0].date, '1990-01-02');
    assert.deepEqual(curves[0].tenors, { '10y': 12.87 });
    assert.deepEqual(curves[curves.length - 1].tenors, { '10y': 3.143 });
    assert.deepEqual(parseRiksbankObservations('UNKNOWN', observations), []);
  });

  it('parses ChinaBond search JSON onto the sampled tenor grid', () => {
    const curves = parseChinaBondSearch(JSON.parse(fixture('chinabond-search.json')));
    assert.equal(curves.length, 1);
    assert.equal(curves[0].date, '2026-09-22');
    assert.equal(curves[0].tenors['3m'], 1.1865);
    assert.equal(curves[0].tenors['10y'], 1.6791);
    assert.equal(curves[0].tenors['30y'], 2.111);
    assert.ok(!Object.keys(curves[0].tenors).includes('2.5y'), 'fractional maturities are not keys');
  });

  it('parses FRED OECD CSV and builds the per-market payload', () => {
    const points = parseFredCsv(fixture('fred-oecd-de.csv'));
    assert.equal(points.length, 4);
    assert.equal(points[0].date, '1956-05-01');
    assert.equal(points[0].value, 6.4);
    const payload = buildOecdLtPayload({ DE: points });
    assert.deepEqual(payload.countries.DE.curves.at(-1)!.tenors, { '10y': 3.18 });
    assert.equal(declareOecdRecords(payload), 4);
    assert.equal(declareOecdRecords({ countries: {} }), 0);
    // Every configured market resolves a FRED series id.
    for (const [market, seriesId] of Object.entries(OECD_LT_MARKETS)) {
      assert.match(seriesId, /^IRLTLT01[A-Z]{2}M156N$/, `${market} series id shape`);
    }
  });
});

describe('seeder wiring', () => {
  it('requires country in the generated query contract', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/EconomicService.openapi.json', import.meta.url), 'utf8'));
    const operation = spec.paths['/api/economic/v1/get-government-yield-curve'].get;
    assert.equal(operation.parameters.find((param: { name: string }) => param.name === 'country').required, true);
  });

  it('counts each country in the OECD latest payload', () => {
    const history = buildOecdLtPayload(Object.fromEntries(
      Object.keys(OECD_LT_MARKETS).map((country) => [country, [
        { date: '2026-06-01', value: 3.5 },
        { date: '2026-07-01', value: 3.6 },
      ]]),
    ));
    const latest = latestTransform(history);
    assert.equal(declareOecdRecords(latest), Object.keys(OECD_LT_MARKETS).length);
    assert.deepEqual(latest.countries.IT.curves, [{ date: '2026-07-01', tenors: { '10y': 3.6 } }]);
    assert.equal(declareOecdRecords(latestTransform({ countries: {} })), 0);
  });

  it('derives one key family per market', () => {
    assert.equal(seederCanonicalKey('JP'), 'economic:yield-curve:jp:v1');
    assert.equal(seederLatestKey('JP'), 'economic:yield-curve:jp:v1:latest');
    assert.equal(seederYearKey('JP', 1990), 'economic:yield-curve:jp:v1:1990');
    assert.equal(activationKey('JP'), 'seed-activated:economic:yield-curve-jp');
    // Server twin agrees.
    assert.equal(govYieldCanonicalKey('JP'), seederCanonicalKey('JP'));
    assert.equal(govYieldLatestKey('JP'), seederLatestKey('JP'));
    assert.equal(govYieldYearKey('JP', 1990), seederYearKey('JP', 1990));
  });

  it('declares latest + per-year extra keys with skipWhenEmpty shards', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const endYear = now.getUTCFullYear();
    const extraKeys = [latestExtraKeyEntry('NO')];
    for (let year = 2015; year <= endYear; year += 1) {
      extraKeys.push(yearExtraKeyEntry('NO', year, year === endYear));
    }
    assert.equal(extraKeys.length, 13); // latest + 2015..2026
    assert.equal(extraKeys[0].key, 'economic:yield-curve:no:v1:latest');
    const shard = extraKeys.find((k) => k.key === 'economic:yield-curve:no:v1:2015');
    assert.equal(shard?.skipWhenEmpty, true);
    assert.equal(shard?.allowMissingOnSkip, false, 'a past year must publish or fail, not silently skip');
    const currentYear = extraKeys.find((k) => k.key === 'economic:yield-curve:no:v1:2026');
    assert.equal(currentYear?.allowMissingOnSkip, true, 'the current year may not have published yet');
  });

  it('validates floor counts and history anchors per market', () => {
    const validate = makeValidate(3, '2015-01');
    assert.equal(validate({ curves: [] }), false);
    assert.equal(validate({ curves: [{ date: '2014-12-01', tenors: { '1y': 1 } }] }), false);
    assert.equal(validate({ curves: [
      { date: '2015-01-02', tenors: { '1y': 1 } },
      { date: '2015-01-05', tenors: {} },
    ] }), false, 'a latest day without tenors fails');
    assert.equal(validate({ curves: [
      { date: '2015-01-02', tenors: { '1y': 1 } },
      { date: '2015-01-05', tenors: { '1y': 1 } },
      { date: '2026-09-01', tenors: { '1y': 1 } },
    ] }), true);
  });
});

describe('BoE month rollover recovery', () => {
  async function zipFor(date: string) {
    const { default: JSZip } = await import('jszip');
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('4. spot curve');
    sheet.getCell('B4').value = 1;
    sheet.getCell('A5').value = new Date(`${date}T00:00:00Z`);
    sheet.getCell('B5').value = 4.2;
    const zip = new JSZip();
    zip.file('GLC Nominal daily data.xlsx', await workbook.xlsx.writeBuffer());
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  async function mockSource(lastDate: string, archiveFails = false) {
    redisEnv();
    const previous = { curves: [
      ...Array.from({ length: 1001 }, (_, day) => ({
        date: new Date(Date.UTC(2020, 0, day + 1)).toISOString().slice(0, 10),
        tenors: { '1y': 4 },
      })),
      { date: lastDate, tenors: { '1y': 4.1 } },
    ] };
    const latest = await zipFor('2026-10-01');
    const archive = await zipFor('2026-09-30');
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('https://redis.example.test/')) return redisResult(previous);
      if (url.endsWith('latest-yield-curve-data.zip')) return new Response(new Uint8Array(latest));
      if (url.endsWith('glcnominalddata.zip')) {
        return archiveFails ? new Response('', { status: 503 }) : new Response(new Uint8Array(archive));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    return urls;
  }

  it('backfills a missed final day before publishing the new month', async () => {
    const urls = await mockSource('2026-09-29');
    const result = await fetchBoeCurve();
    assert.deepEqual(result.curves.slice(-3).map((curve) => curve.date), ['2026-09-29', '2026-09-30', '2026-10-01']);
    assert.ok(urls.some((url) => url.endsWith('glcnominalddata.zip')));
  });

  it('keeps same-month runs on the small daily download', async () => {
    const urls = await mockSource('2026-10-01');
    const result = await fetchBoeCurve();
    assert.equal(result.curves.at(-1)?.tenors['1y'], 4.2);
    assert.ok(!urls.some((url) => url.endsWith('glcnominalddata.zip')));
  });

  it('fails rollover publication when the archive cannot be read', async () => {
    await mockSource('2026-09-29', true);
    await assert.rejects(fetchBoeCurve(), /BoE HTTP 503/);
  });
});

describe('GetGovernmentYieldCurve handler', () => {
  it('rejects malformed country codes', async () => {
    for (const bad of ['usa', '', 'J', 'JPN', '1A']) {
      await assert.rejects(
        () => getGovernmentYieldCurve({} as never, { country: bad, history: false }),
        (err: unknown) => err instanceof Error && /Validation|country/.test(`${err.name}: ${err.message}`),
      );
    }
  });

  it('returns the latest business day from the :latest key', async () => {
    redisEnv();
    const seen: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const path = decodeURIComponent(String(url));
      seen.push(path);
      if (path.includes('economic:yield-curve:jp:v1:latest')) {
        return redisResult({ curves: [{ date: '2026-09-22', tenors: { '1y': 1.5, '10y': 2.9 } }] });
      }
      return redisResult(null);
    }) as typeof fetch;

    const res = await getGovernmentYieldCurve({} as never, { country: 'jp', history: false });
    assert.equal(res.unavailable, false);
    assert.equal(res.country, 'JP');
    assert.equal(res.source, 'jp-mof-cmt');
    assert.equal(res.measure, 'par');
    assert.equal(res.curves.length, 1);
    assert.equal(res.curves[0].tenors['10y'], 2.9);
    assert.ok(seen.some((p) => p.includes('latest')), 'the latest key is read, not the year shards');
  });

  it('assembles history from year shards in ascending order', async () => {
    redisEnv();
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const pipeline = JSON.parse(String(init?.body)) as string[][];
      assert.ok(Array.isArray(pipeline));
      const results = pipeline.map((command) => {
        const key = command[1];
        if (key === 'economic:yield-curve:au:v1:2024') {
          return { result: JSON.stringify({ curves: [{ date: '2024-06-03', tenors: { '2y': 2.4 } }] }) };
        }
        if (key === 'economic:yield-curve:au:v1:2013') {
          return { result: JSON.stringify({ curves: [{ date: '2013-05-20', tenors: { '10y': 3.229 } }] }) };
        }
        return { result: null };
      });
      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const res = await getGovernmentYieldCurve({} as never, { country: 'AU', history: true });
    assert.equal(res.unavailable, false);
    assert.equal(res.measure, 'benchmark');
    assert.deepEqual(res.curves.map((c) => new Date(c.date).toISOString().slice(0, 10)), ['2013-05-20', '2024-06-03']);
  });

  it('falls back to OECD monthly for an uncovered market', async () => {
    redisEnv();
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const path = decodeURIComponent(String(url));
      if (path.includes('economic:yield-curve:oecd-lt:v1:latest')) {
        return redisResult({ countries: { IT: { curves: [
          { date: '2026-07-01', tenors: { '10y': 3.8 } },
        ] } } });
      }
      if (path.includes('economic:yield-curve:oecd-lt:v1')) {
        return redisResult({ countries: { IT: { curves: [
          { date: '2026-06-01', tenors: { '10y': 3.7 } },
          { date: '2026-07-01', tenors: { '10y': 3.8 } },
        ] } } });
      }
      return redisResult(null);
    }) as typeof fetch;

    const latest = await getGovernmentYieldCurve({} as never, { country: 'IT', history: false });
    assert.equal(latest.unavailable, false);
    assert.equal(latest.source, 'oecd-mei-monthly');
    assert.equal(latest.measure, 'monthly-10y');
    assert.equal(latest.curves.length, 1);
    assert.equal(latest.curves[0].tenors['10y'], 3.8);

    const history = await getGovernmentYieldCurve({} as never, { country: 'IT', history: true });
    assert.equal(history.curves.length, 2);
    assert.deepEqual(history.curves.map((c) => c.tenors['10y']), [3.7, 3.8]);
  });

  it('returns unavailable for a market with neither daily nor monthly data', async () => {
    redisEnv();
    globalThis.fetch = (async () => redisResult(null)) as typeof fetch;
    const res = await getGovernmentYieldCurve({} as never, { country: 'NZ', history: false });
    assert.equal(res.unavailable, true);
    assert.equal(res.country, 'NZ');
    assert.deepEqual(res.curves, []);
    assert.equal(res.source, '');
    assert.equal(res.measure, '');
  });

  it('covers the eight daily markets with distinct sources and measures', () => {
    assert.deepEqual(COVERED_MARKETS.map((m) => m.country), ['JP', 'CA', 'DE', 'GB', 'AU', 'CH', 'NO', 'SE']);
    for (const market of COVERED_MARKETS) {
      const found = findCoveredMarket(market.country.toLowerCase());
      assert.equal(found?.country, market.country, `${market.country} resolves case-insensitively`);
    }
    assert.equal(findCoveredMarket('NZ'), undefined);
    const measures = new Set(COVERED_MARKETS.map((m) => m.measure));
    assert.deepEqual([...measures].sort(), ['benchmark', 'par', 'spot']);
  });

  it('normalizes shard and latest payloads through the server model', () => {
    const shards = [
      { curves: [{ date: '2025-06-02', tenors: { '5y': 2.5 } }] },
      { curves: [{ date: '2024-06-03', tenors: { '5y': 2.4 } }] },
    ];
    const history = govYieldCurvesFromShards(shards);
    assert.deepEqual(history.map((c) => new Date(c.date).toISOString().slice(0, 10)), ['2024-06-03', '2025-06-02']);
    assert.deepEqual(govYieldCurvesFromShards([null, undefined, {}]), []);
    assert.deepEqual(govYieldCurveFromLatest({ curves: [{ date: '2026-01-05', tenors: { '1y': 1 } }] }).length, 1);
    assert.deepEqual(govYieldCurveFromLatest(null), []);
  });
});
