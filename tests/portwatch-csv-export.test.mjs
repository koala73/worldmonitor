// IMF PortWatch's ArcGIS query service has timed out since 2026-10-27: queries
// that run past ~10 s return HTTP 200 with "Invalid query parameters", so about
// 40% of the 26 per-chokepoint queries failed every run and Korea Strait fell
// out of supply_chain:portwatch:v1. The ArcGIS Hub CSV export of the same layer
// is cached and answers in one request, so it is now the primary source and the
// query pipeline is the fallback.
//
// The fixture is a slice of the real export (downloaded 2026-11-01): Korea
// Strait over its full baseline year plus the 180-day history window, Suez
// Canal with 10 baseline days, Kerch Strait with only rows outside both
// windows, and Bering Strait, which is not a tracked chokepoint. Expected
// values were computed from the fixture with awk, not by the code under test.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  baselineWindow,
  buildHistory,
  chokepointsFromCsv,
  fetchAll,
  HISTORY_DAYS,
} from '../scripts/seed-portwatch.mjs';

const NOW = Date.parse('2026-11-01T06:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const CSV = readFileSync(new URL('./fixtures/portwatch-chokepoints-export.csv', import.meta.url), 'utf8');
const SINCE = NOW - HISTORY_DAYS * DAY_MS;
const WINDOW = baselineWindow(NOW);

test('the fixture starts with the export BOM, so the header is only found once it is stripped', () => {
  assert.equal(CSV.charCodeAt(0), 0xfeff);
});

test('history matches what buildHistory yields from the equivalent ArcGIS query features', () => {
  const result = chokepointsFromCsv(CSV, SINCE, WINDOW);
  const korea = result.korea_strait.history;
  assert.equal(korea.length, 174, '2026-05-05..2026-10-25, the 180-day window the query used');
  assert.equal(korea[0].date, '2026-05-05');
  assert.equal(korea.at(-1).date, '2026-10-25');
  // The live query returns the DateOnly field as "YYYY-MM-DD" with these outFields.
  const queried = buildHistory([
    { attributes: { date: '2026-05-05', n_container: 47, n_dry_bulk: 42, n_general_cargo: 50, n_roro: 6, n_tanker: 47, n_total: 192,
      capacity_container: 881191, capacity_dry_bulk: 886392, capacity_general_cargo: 94818, capacity_roro: 4550, capacity_tanker: 313564 } },
    { attributes: { date: '2026-10-25', n_container: 41, n_dry_bulk: 23, n_general_cargo: 20, n_roro: 8, n_tanker: 43, n_total: 135,
      capacity_container: 741521, capacity_dry_bulk: 644812, capacity_general_cargo: 73683, capacity_roro: 15853, capacity_tanker: 643465 } },
  ]);
  assert.deepEqual([korea[0], korea.at(-1)], queried);
  assert.equal(result.korea_strait.wowChangePct, 1.3, '1389 vs 1371 transits');
  assert.equal(result.suez.history.length, 20);
  assert.equal(result.suez.wowChangePct, -6.8, '289 vs 310 transits');
});

test('the baseline equals the outStatistics avg/count over the year-earlier window', () => {
  const result = chokepointsFromCsv(CSV, SINCE, WINDOW);
  assert.deepEqual(result.korea_strait.baseline, { avgDaily: 222.1, days: 365, from: '2024-11-01', to: '2025-10-31' });
  assert.equal(result.suez.baseline, null, '10 published days is below BASELINE_MIN_DAYS');
});

test('untracked ports and chokepoints with no rows in the history window are left out', () => {
  const result = chokepointsFromCsv(CSV, SINCE, WINDOW);
  assert.deepEqual(Object.keys(result).sort(), ['korea_strait', 'suez']);
});

function mangleKoreaRow(mangle) {
  const lines = CSV.split('\n');
  const columns = lines[0].replace(/^\uFEFF/, '').trim().split(',');
  const i = lines.findIndex(line => line.startsWith('2026/10/25') && line.includes(',Korea Strait,'));
  const cells = lines[i].split(',');
  lines[i] = mangle(cells, Object.fromEntries(columns.map((name, n) => [name, n]))).join(',');
  return lines.join('\n');
}
const TRUNCATED_ROW_CSV = mangleKoreaRow((cells, col) => cells.slice(0, col.portname + 1));
const NON_NUMERIC_CSV = mangleKoreaRow((cells, col) => { cells[col.n_total] = 'N/A'; return cells; });
const BAD_DATE_CSV = mangleKoreaRow((cells, col) => { cells[col.date] = '2026/13/01'; return cells; });

test('a tracked row that is cut short or holds a non-numeric count rejects the export', () => {
  assert.throws(() => chokepointsFromCsv(TRUNCATED_ROW_CSV, SINCE, WINDOW), /malformed row for Korea Strait/);
  assert.throws(() => chokepointsFromCsv(NON_NUMERIC_CSV, SINCE, WINDOW), /malformed row for Korea Strait/);
});

test('a tracked row whose date is not a real calendar day rejects the export', () => {
  // 2026-13-01 sorts inside the history window, so the window filter alone keeps it.
  assert.throws(() => chokepointsFromCsv(BAD_DATE_CSV, SINCE, WINDOW), /invalid date for Korea Strait/);
});

test('an export without the expected header or chokepoint rows is rejected', () => {
  assert.throws(() => chokepointsFromCsv('<html>maintenance</html>', SINCE, WINDOW), /missing column/);
  const header = CSV.split('\n')[0];
  assert.throws(() => chokepointsFromCsv(`${header}\n`, SINCE, WINDOW), /no chokepoint rows/);
});

const HUB_HOST = 'hub.arcgis.com';
const QUERY_HOST = 'services9.arcgis.com';

function stubNetwork(t, hubResponse, previous = null) {
  const env = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://redis.test')) return Response.json({ result: previous && JSON.stringify(previous) });
    if (url.includes(HUB_HOST)) return hubResponse();
    if (url.includes('outStatistics')) return Response.json({ features: [{ attributes: { avg_total: 50, day_count: 365 } }] });
    return Response.json({ features: [{ attributes: { date: '2026-10-25', n_total: 10 } }] });
  };
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => {
    mock.timers.reset();
    globalThis.fetch = realFetch;
    if (env.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = env.url;
    if (env.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = env.token;
  });
  return calls;
}

const queriedNames = calls => new Set(calls
  .filter(u => u.includes(QUERY_HOST))
  .map(u => decodeURIComponent(u.replaceAll('+', ' ')).match(/portname='([^']+)'/)?.[1]));

test('fetchAll reads the CSV export and queries ArcGIS only for the chokepoints it lacks', async (t) => {
  const calls = stubNetwork(t, () => new Response(CSV, { status: 200 }));
  const result = await fetchAll();
  assert.equal(calls.filter(u => u.includes(HUB_HOST)).length, 1);
  const queried = queriedNames(calls);
  assert.equal(queried.has('Korea Strait'), false, 'Korea Strait came from the CSV');
  assert.equal(queried.has('Suez Canal'), false, 'Suez Canal came from the CSV');
  assert.equal(queried.has('Strait of Hormuz'), true, 'a chokepoint absent from the CSV is queried');
  assert.equal(Object.keys(result).length, 13, 'the publish clears validateFn instead of failing on a partial export');
  assert.equal(result.korea_strait.history.length, 174);
  assert.equal(result.korea_strait.baseline.avgDaily, 222.1);
  assert.equal(result.korea_strait.fetchedAt, NOW);
});

for (const [label, hubResponse] of [
  ['the download fails', () => new Response('unavailable', { status: 503 })],
  ['the body is not the export', () => new Response('<html>maintenance</html>', { status: 200 })],
  ['a tracked row is malformed', () => new Response(NON_NUMERIC_CSV, { status: 200 })],
]) {
  test(`fetchAll falls back to the ArcGIS query pipeline when ${label}`, async (t) => {
    const calls = stubNetwork(t, hubResponse);
    const result = await fetchAll();
    assert.ok(calls.some(u => u.includes(QUERY_HOST)), 'query pipeline ran');
    assert.equal(Object.keys(result).length, 13);
    assert.equal(result.korea_strait.history[0].total, 10);
    assert.equal(result.korea_strait.baseline.avgDaily, 50);
  });
}

test('fetchAll queries a chokepoint whose CSV history ends before the previous snapshot', async (t) => {
  // The previous Korea entry is past the carry-forward limit, so without a
  // query the older CSV history would replace it.
  const previous = {
    korea_strait: { history: [{ date: '2026-10-28', total: 5 }], wowChangePct: 0, baseline: null, fetchedAt: NOW - 4 * DAY_MS },
  };
  const calls = stubNetwork(t, () => new Response(CSV, { status: 200 }), previous);
  await fetchAll();
  const queried = queriedNames(calls);
  assert.equal(queried.has('Korea Strait'), true, 'the trailing CSV entry is re-queried');
  assert.equal(queried.has('Suez Canal'), false, 'a CSV entry with no newer previous history is not');
});

// Past fetchDeadlineAtMs runSeed has already given up on the run, so a query
// could not publish and would only spend ArcGIS's per-IP rate limit.
test('fetchAll rethrows a failed CSV after the fetch deadline instead of querying ArcGIS', async (t) => {
  const calls = stubNetwork(t, () => new Response('unavailable', { status: 503 }));
  await assert.rejects(fetchAll({ fetchDeadlineAtMs: NOW - 1 }), /HTTP 503/);
  assert.equal(calls.filter(u => u.includes(HUB_HOST)).length, 1, 'the CSV was requested');
  assert.deepEqual([...queriedNames(calls)], []);
});

test('fetchAll returns a partial CSV after the fetch deadline without querying what it lacks', async (t) => {
  const calls = stubNetwork(t, () => new Response(CSV, { status: 200 }));
  const result = await fetchAll({ fetchDeadlineAtMs: NOW - 1 });
  assert.equal(calls.filter(u => u.includes(HUB_HOST)).length, 1, 'the CSV was requested');
  assert.deepEqual([...queriedNames(calls)], []);
  assert.deepEqual(Object.keys(result).sort(), ['korea_strait', 'suez']);
  assert.equal(result.korea_strait.history.length, 174);
});
