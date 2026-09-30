import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { fetchJgbCurve } from '../scripts/seed-yield-curve-jp.mjs';
import { contentMeta, latestExtraKeyEntry, yearExtraKeyEntry } from '../scripts/seed-yield-curves-shared.mjs';
import { govYieldCurveFromLatest, govYieldCurvesFromShards } from '../server/worldmonitor/economic/v1/government-yield-curves.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const base = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/';
const historyUrl = `${base}historical/jgbcme_all.csv`;
const currentUrl = `${base}jgbcme.csv`;
const csv = (rows: string) => `Interest Rate,\nDate,1Y,10Y,40Y\n${rows}\n`;
const history = csv('1974/9/24,10.327,-,-\n2026/8/31,1.502,2.943,4.094');
const current = csv('2026/9/17,1.581,2.993,4.036\n2026/8/31,-,2.95,-');

it('combines MOF current data with history through metadata, latest and year readers', async () => {
  const requested: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    assert.ok(new Headers(init?.headers).get('User-Agent'));
    assert.ok(init?.signal);
    assert.ok(url === historyUrl || url === currentUrl);
    return new Response(url === historyUrl ? history : current);
  };
  const payload = await fetchJgbCurve();
  assert.deepEqual(requested.sort(), [historyUrl, currentUrl].sort());
  assert.deepEqual(payload.curves.map((curve) => curve.date), ['1974-09-24', '2026-08-31', '2026-09-17']);
  assert.deepEqual(payload.curves[1].tenors, { '1y': 1.502, '10y': 2.95, '40y': 4.094 });
  const newest = Date.parse('2026-09-17T00:00:00Z');
  assert.equal(contentMeta(payload)?.newestItemAt, newest);
  assert.equal(contentMeta(payload)?.oldestItemAt, Date.parse('1974-09-24T00:00:00Z'));
  const latest = govYieldCurveFromLatest(latestExtraKeyEntry('JP').transform(payload));
  assert.equal(latest.length, 1);
  assert.equal(latest[0].date, newest);
  assert.equal(latest[0].tenors['10y'], 2.993);
  const shards = [1974, 2026].map((year) => yearExtraKeyEntry('JP', year, year === 2026).transform(payload));
  assert.deepEqual(govYieldCurvesFromShards(shards).map((curve) => curve.date), payload.curves.map((curve) => Date.parse(`${curve.date}T00:00:00Z`)));
});

it('keeps a newer historical observation when the current file lags at rollover', async () => {
  globalThis.fetch = async (input) => new Response(String(input) === historyUrl ? history : csv('2026/8/28,1.483,2.93,4.084'));
  const payload = await fetchJgbCurve();
  assert.equal(payload.curves.at(-1)?.date, '2026-08-31');
});

for (const failedUrl of [historyUrl, currentUrl]) {
  for (const failure of ['http', 'empty', 'network']) {
    it(`rejects ${failure} in ${failedUrl === currentUrl ? 'current' : 'historical'} data instead of publishing partial history`, async () => {
      globalThis.fetch = async (input) => {
        if (String(input) !== failedUrl) return new Response(String(input) === historyUrl ? history : current);
        if (failure === 'network') throw new Error('connection reset');
        return failure === 'http' ? new Response('unavailable', { status: 503 }) : new Response('Date,1Y\n2026/9/17,-');
      };
      await assert.rejects(fetchJgbCurve(), failure === 'network' ? /connection reset/ : failure === 'http' ? /HTTP 503/ : /parsed no business days/);
    });
  }
}
