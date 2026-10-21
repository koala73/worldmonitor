import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import { fetchSnbCurve } from '../scripts/seed-yield-curve-ch.mjs';
import { contentMeta, latestExtraKeyEntry, yearExtraKeyEntry } from '../scripts/seed-yield-curves-shared.mjs';
import { govYieldCurveFromLatest, govYieldCurvesFromShards } from '../server/worldmonitor/economic/v1/government-yield-curves.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const csv = readFileSync(new URL('./fixtures/yield-curves/snb-confederation.csv', import.meta.url), 'utf8');
const expectedTenors = ['1y', '2y', '3y', '4y', '5y', '6y', '7y', '8y', '9y', '10y', '20y', '30y'];

it('fetches the daily Confederation curve with explicit full history and preserves observation dates through readers', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://data.snb.ch');
    assert.equal(url.pathname, '/api/warehouse/cube/SNB1A.SNB.NSS.KZS.EID/data/csv/en');
    assert.equal(url.searchParams.get('fromDate'), '1988-01-01');
    assert.equal(url.searchParams.get('dimSel'), 'LAUFZEIT(J01M0,J02M0,J03M0,J04M0,J05M0,J06M0,J07M0,J08M0,J09M0,J10M0,J20M0,J30M0),ZEITPUNKT(A1100),frequency(P1D_L),AGGREGATIONSMETHODE(ZZ)');
    assert.ok(new Headers(init?.headers).get('User-Agent'));
    assert.ok(init?.signal);
    return new Response(csv);
  };
  const payload = await fetchSnbCurve();
  assert.deepEqual(payload.curves.map((curve) => curve.date), ['1988-01-04', '2026-08-31', '2026-09-22']);
  const latest = payload.curves.at(-1)!;
  assert.deepEqual(Object.keys(latest.tenors).sort(), [...expectedTenors].sort());
  assert.equal(latest.tenors['10y'], 0.564);
  assert.equal(latest.tenors['30y'], 0.551);
  assert.equal(payload.curves[1].tenors['10y'], 0.469);
  const newest = Date.parse('2026-09-22T00:00:00Z');
  assert.equal(contentMeta(payload)?.newestItemAt, newest);
  assert.equal(contentMeta(payload)?.oldestItemAt, Date.parse('1988-01-04T00:00:00Z'));
  const wireLatest = govYieldCurveFromLatest(latestExtraKeyEntry('CH').transform(payload));
  assert.equal(wireLatest[0].date, newest);
  assert.deepEqual(wireLatest[0].tenors, latest.tenors);
  const shards = [1988, 2026].map((year) => yearExtraKeyEntry('CH', year, year === 2026).transform(payload));
  assert.deepEqual(govYieldCurvesFromShards(shards).map((curve) => curve.date), payload.curves.map((curve) => Date.parse(`${curve.date}T00:00:00Z`)));
});

it('excludes monthly aggregates, other fixings and extra maturities even if returned by the source', async () => {
  const unwanted = [
    '"2026-09-23";"J10M0";"A1100";"P1M";"ZH";"9"',
    '"2026-09-23";"J10M0";"A1100";"P1D_L";"ZH";"9"',
    '"2026-09-23";"J10M0";"A1700";"P1D_L";"ZZ";"9"',
    '"2026-09-23";"J01M6";"A1100";"P1D_L";"ZZ";"9"',
    '"2026-09-23";"J11M0";"A1100";"P1D_L";"ZZ";"9"',
    '"2026-09-23";"J10M0";"A1100";"P1D_L";"ZZ";""',
    '"2026-09-23";"J10M0";"A1100";"P1D_L";"ZZ";"NaN"',
  ];
  globalThis.fetch = async () => new Response(csv + unwanted.join('\n'));
  assert.equal((await fetchSnbCurve()).curves.at(-1)?.date, '2026-09-22');
});

for (const failure of ['http', 'empty', 'network']) {
  it(`rejects ${failure} instead of publishing an empty or old-source success`, async () => {
    globalThis.fetch = async () => {
      if (failure === 'network') throw new Error('connection reset');
      return failure === 'http' ? new Response('unavailable', { status: 503 }) : new Response(csv.split('\n').slice(0, 4).join('\n'));
    };
    await assert.rejects(fetchSnbCurve(), failure === 'network' ? /connection reset/ : failure === 'http' ? /HTTP 503/ : /parsed no business days/);
  });
}
