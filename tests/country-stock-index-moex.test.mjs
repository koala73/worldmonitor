// #6153: the RU country index is served from the Moscow Exchange ISS API,
// which Yahoo stopped covering after 2022. This pins the ISS leg without the
// network: the columnar history parse, the snapshot contract shared with the
// Yahoo leg, the registry routing, the audit's handling of a non-Yahoo entry,
// and the RPC's refusal to spend a Yahoo request on a non-Yahoo index.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOEX_SOURCE,
  buildMoexCountryStockIndexSnapshot,
  fetchMoexCountryStockIndexSnapshot,
  moexHistoryUrl,
  parseMoexHistoryCloses,
} from '../scripts/_country-stock-index-moex.mjs';
import {
  loadCountryStockIndexes,
  loadDeclaredCountryStockIndexes,
  loadYahooCountryStockIndexes,
} from '../scripts/_country-stock-index-registry.mjs';
import { auditCountryStockIndexes, classify, exitCodeFor } from '../scripts/audit-country-stock-index-symbols.mjs';

const RU = { code: 'RU', symbol: 'IMOEX', name: 'MOEX Russia Index' };
const FIXED_AT = '2026-10-29T20:00:00.000Z';
const quote = (price = 2496.26, tradeDate = '2026-10-29') => ({ marketdata: { columns: ['SECID', 'CURRENTVALUE', 'TRADEDATE'], data: [['IMOEX', price, tradeDate]] } });
const history = (rows, columns = ['TRADEDATE', 'CLOSE']) => ({ history: { columns, data: rows } });

test('reads closes by column name in trade-date order and drops rows without a finite close', () => {
  const payload = history([
    ['2026-10-23', 2469.36],
    ['2026-10-22', 2431.66],
    ['2026-10-24', null],
    ['2026-10-27', '2524.06'],
    'not a row',
  ]);
  assert.deepEqual(parseMoexHistoryCloses(payload), [2431.66, 2469.36, 2524.06]);
  // a column inserted upstream must not shift the fields
  const shifted = history([['IMOEX', '2026-10-22', 2431.66], ['IMOEX', '2026-10-23', 2469.36]], ['SECID', 'TRADEDATE', 'CLOSE']);
  assert.deepEqual(parseMoexHistoryCloses(shifted), [2431.66, 2469.36]);
  for (const bad of [null, {}, { history: {} }, history([], ['TRADEDATE']), { history: { columns: 'x', data: [] } }]) {
    assert.deepEqual(parseMoexHistoryCloses(bad), [], JSON.stringify(bad));
  }
});

test('publishes the same RPC snapshot shape as the Yahoo leg, in RUB, over the last six closes', () => {
  const payload = history([
    ['2026-10-20', 2400], ['2026-10-21', 2410], ['2026-10-22', 2431.66], ['2026-10-23', 2469.36],
    ['2026-10-26', 2491.83], ['2026-10-27', 2524.06], ['2026-10-28', 2522.93], ['2026-10-29', 2496.26],
  ]);
  assert.deepEqual(buildMoexCountryStockIndexSnapshot(payload, quote(), RU, FIXED_AT), {
    available: true,
    code: 'RU',
    symbol: 'IMOEX',
    indexName: 'MOEX Russia Index',
    price: 2496.26,
    weekChangePercent: 2.66,
    currency: 'RUB',
    fetchedAt: FIXED_AT,
  });
  assert.equal(buildMoexCountryStockIndexSnapshot(history([['2026-10-29', 2496.26]]), quote(), RU, FIXED_AT), null, 'one close is not a week');
});

test('requests the ISS history window with the join columns and a User-Agent, and refuses a bad response', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return { ok: true, status: 200, json: async () => String(url).includes('/history/')
      ? history([['2026-10-28', 2522.93], ['2026-10-29', 2496.26]]) : quote(2590) };
  };
  const now = new Date('2026-10-29T12:00:00Z');
  const snapshot = await fetchMoexCountryStockIndexSnapshot(RU, { fetchImpl, now });
  assert.equal(snapshot.price, 2590);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((call) => new URL(call.url).searchParams.get('iss.only') === 'marketdata'));
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://iss.moex.com/iss/history/engines/stock/markets/index/securities/IMOEX.json');
  assert.equal(url.searchParams.get('history.columns'), 'TRADEDATE,CLOSE');
  assert.equal(url.searchParams.get('from'), '2026-09-14');
  assert.equal(url.searchParams.get('till'), '2026-10-29');
  assert.equal(calls[0].url, moexHistoryUrl('IMOEX', now));
  assert.match(calls[0].headers['User-Agent'], /WorldMonitor/);

  await assert.rejects(fetchMoexCountryStockIndexSnapshot(RU, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchMoexCountryStockIndexSnapshot(RU, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), /insufficient market data/);
});

test('the registry routes RU to the ISS leg and keeps it out of the Yahoo audit list', () => {
  const declared = loadDeclaredCountryStockIndexes().find((index) => index.code === 'RU');
  assert.deepEqual(declared, { code: 'RU', symbol: 'IMOEX', name: 'MOEX Russia Index', source: MOEX_SOURCE });
  assert.ok(loadCountryStockIndexes().some((index) => index.code === 'RU'), 'RU is seedable again');
  assert.equal(loadYahooCountryStockIndexes().some((index) => index.code === 'RU'), false);
  assert.equal(loadYahooCountryStockIndexes().length, loadCountryStockIndexes().length - 1);
});

test('the Yahoo symbol audit reports a non-Yahoo entry without probing it and without failing the run', async () => {
  assert.equal(classify({ ...RU, source: MOEX_SOURCE }, { snapshot: false, error: null }), 'non-yahoo-source');
  let probes = 0;
  const rows = await auditCountryStockIndexes({
    indexes: [{ ...RU, source: MOEX_SOURCE }, { code: 'DE', symbol: '^GDAXI', name: 'DAX' }],
    fetchJson: async () => { probes += 1; return { chart: { result: [{ meta: { currency: 'EUR' }, indicators: { quote: [{ close: [1, 2, 3] }] } }] } }; },
    delayMs: 0,
  });
  assert.equal(probes, 1, 'only the Yahoo entry is probed');
  assert.deepEqual(rows.map((row) => [row.code, row.verdict]), [['RU', 'non-yahoo-source'], ['DE', 'ok']]);
  assert.equal(exitCodeFor(rows), 0);
});

test('the RPC serves a seeded RU row and answers unavailable without a Yahoo request when the seed is missing', async (t) => {
  const originalFetch = globalThis.fetch;
  const env = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (env.url == null) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = env.url;
    if (env.token == null) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = env.token;
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const requested = [];
  let seeded = JSON.stringify(buildMoexCountryStockIndexSnapshot(history([['2026-10-28', 2522.93], ['2026-10-29', 2496.26]]), quote(), RU, FIXED_AT));
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/get/market%3Astock-index%3Av1%3ARU')) return new Response(JSON.stringify({ result: seeded }), { status: 200 });
    throw new Error(`unexpected request: ${url}`);
  };
  const { getCountryStockIndex } = await import('../server/worldmonitor/market/v1/get-country-stock-index.ts');
  const served = await getCountryStockIndex({}, { countryCode: 'RU' });
  assert.equal(served.available, true);
  assert.equal(served.symbol, 'IMOEX');
  assert.equal(served.currency, 'RUB');

  // A fresh module instance so the in-memory cache does not mask the miss.
  const { getCountryStockIndex: freshHandler } = await import(`../server/worldmonitor/market/v1/get-country-stock-index.ts?miss=${Date.now()}`);
  seeded = null;
  requested.length = 0;
  const missed = await freshHandler({}, { countryCode: 'RU' });
  assert.equal(missed.available, false);
  assert.equal(missed.code, 'RU');
  assert.deepEqual(requested, ['https://redis.example.test/get/market%3Astock-index%3Av1%3ARU'], 'no Yahoo request for a MOEX-served index');
});


test('uses the current quote once and excludes same-day and future history', () => {
  const payload = history([
    ['2026-10-21', 100], ['2026-10-22', 110], ['2026-10-23', 120],
    ['2026-10-26', 130], ['2026-10-27', 140], ['2026-10-28', 150],
    ['2026-10-29', 999], ['2026-10-30', 999],
  ]);
  const result = buildMoexCountryStockIndexSnapshot(payload, quote(200), RU, FIXED_AT);
  assert.equal(result.price, 200);
  assert.equal(result.weekChangePercent, 81.82);
  for (const bad of [null, {}, quote(null), quote(''), quote(-1), quote(100, 'bad-date')]) {
    assert.equal(buildMoexCountryStockIndexSnapshot(payload, bad, RU, FIXED_AT), null);
  }
  assert.equal(buildMoexCountryStockIndexSnapshot(payload, { marketdata: { columns: ['CURRENTVALUE', 'TRADEDATE', 'SECID'], data: [[200, '2026-10-29', 'OTHER']] } }, RU, FIXED_AT), null);
});

test('the warmed non-Yahoo fallback expires after its one-hour TTL', async (t) => {
  const priorFetch = globalThis.fetch;
  const priorNow = Date.now;
  const priorUrl = process.env.UPSTASH_REDIS_REST_URL;
  const priorToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  t.after(() => {
    globalThis.fetch = priorFetch;
    Date.now = priorNow;
    if (priorUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = priorUrl;
    if (priorToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = priorToken;
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  let clock = new Date(FIXED_AT).getTime();
  Date.now = () => clock;
  let seeded = JSON.stringify(buildMoexCountryStockIndexSnapshot(history([['2026-10-28', 2522.93]]), quote(), RU, FIXED_AT));
  globalThis.fetch = async () => Response.json({ result: seeded });
  const { getCountryStockIndex } = await import(`../server/worldmonitor/market/v1/get-country-stock-index.ts?ttl=${clock}`);
  assert.equal((await getCountryStockIndex({}, { countryCode: 'RU' })).available, true);
  seeded = null;
  clock += 60 * 60 * 1000 - 1;
  assert.equal((await getCountryStockIndex({}, { countryCode: 'RU' })).available, true);
  clock += 2;
  assert.equal((await getCountryStockIndex({}, { countryCode: 'RU' })).available, false);
});
