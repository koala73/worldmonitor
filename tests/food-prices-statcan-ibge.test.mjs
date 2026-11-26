import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PRODUCT_ID, TABLE_URL, collect as collectStatcan, parseStatcanMetadata, parseStatcanPrices, splitProduct } from '../scripts/lib/food-prices-adapters/statcan.mjs';
import { DATA_URL, collect as collectIbge, parseIbge } from '../scripts/lib/food-prices-adapters/ibge.mjs';
import { collectFoodSource } from '../scripts/lib/food-prices-fetch.mjs';
import { mergeFoodSnapshot } from '../scripts/lib/food-prices-seed.mjs';

const json = name => JSON.parse(readFileSync(new URL(`./fixtures/food-prices/${name}.json`, import.meta.url), 'utf8'));
const NOW = new Date('2026-11-26T08:00:00Z');
const dated = (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10);
const PROXY_AUTH = 'user:secret@gate.decodo.com:10001';

/**
 * A fake StatCan WDS. The fixture holds Canada, Ontario and Yellowknife; other geographies answer FAILED with an
 * empty vector, as WDS does for a product a geography does not collect. Batches over 300 are refused like WDS does.
 */
function wds({ requests = [], series = json('statcan').series, metadata = json('statcan').metadata } = {}) {
  const byCoordinate = new Map(series.map(row => [row.object.coordinate, row]));
  return async (url, options = {}) => {
    const target = new URL(url);
    const body = JSON.parse(options.body);
    requests.push({ url: target, body });
    assert.equal(options.method, 'POST');
    if (target.pathname.endsWith('/getCubeMetadata')) return JSON.stringify(metadata);
    assert.ok(target.pathname.endsWith('/getDataFromCubePidCoordAndLatestNPeriods'));
    if (body.length > 300) return JSON.stringify({ message: 'The number of object in the list exceeds the limit - 300. Error code = 9' });
    return JSON.stringify(body.map(({ coordinate }) => byCoordinate.get(coordinate)
      ?? { status: 'FAILED', object: { responseStatusCode: 2, productId: PRODUCT_ID, coordinate, vectorId: 0, vectorDataPoint: [] } }));
  };
}
const ctx = (get, warnings = []) => ({ now: NOW, dated, get, warn: message => warnings.push(message) });
const point = (row, change) => ({ ...row, object: { ...row.object, vectorDataPoint: row.object.vectorDataPoint.map(p => ({ ...p, ...change })) } });

test('StatCan product labels split into the item and its published unit', () => {
  assert.deepEqual(splitProduct('Beef stewing cuts, per kilogram'), { item: 'Beef stewing cuts', unit: 'kg' });
  assert.deepEqual(splitProduct('Bacon, 500 grams'), { item: 'Bacon', unit: '500 g' });
  assert.deepEqual(splitProduct('Oranges, 1.36 kilograms'), { item: 'Oranges', unit: '1.36 kg' });
  assert.deepEqual(splitProduct('Milk, 1 litre'), { item: 'Milk', unit: '1 L' });
  assert.deepEqual(splitProduct('Soy milk, 1.89 litres'), { item: 'Soy milk', unit: '1.89 L' });
  assert.deepEqual(splitProduct('Canned soup, 284 millilitres'), { item: 'Canned soup', unit: '284 ml' });
  assert.deepEqual(splitProduct('Eggs, 1 dozen'), { item: 'Eggs', unit: 'dozen' });
  assert.deepEqual(splitProduct('Lemons, unit'), { item: 'Lemons', unit: 'piece' });
  assert.deepEqual(splitProduct('Tea (20 bags)'), { item: 'Tea', unit: '20 bags' });
  assert.deepEqual(splitProduct('Frozen corn, 750 grams '), { item: 'Frozen corn', unit: '750 g' });
  assert.throws(() => splitProduct('Rice, 1 bag'), /unit format changed/);
});

test('StatCan metadata keeps the 13 geographies and food products, without personal-care and household products', () => {
  const { geographies, foods } = parseStatcanMetadata(json('statcan').metadata);
  assert.equal(geographies.length, 13);
  assert.ok(geographies.some(geo => geo.name === 'Whitehorse, Yukon'));
  assert.equal(foods.length, 106);
  assert.ok(!foods.some(food => ['Deodorant', 'Toothpaste', 'Shampoo', 'Laundry detergent'].includes(food.item)));
  const moved = structuredClone(json('statcan').metadata);
  moved[0].object.dimension[1].dimensionNameEn = 'Product groups';
  assert.throws(() => parseStatcanMetadata(moved), /metadata format changed/);
  const weekly = structuredClone(json('statcan').metadata);
  weekly[0].object.frequencyCode = 12;
  assert.throws(() => parseStatcanMetadata(weekly), /metadata format changed/);
  assert.throws(() => parseStatcanMetadata([{ status: 'FAILED', object: 'no cube' }]), /metadata format changed/);
});

test('StatCan prices are the newest month in CAD per geography; missing and suppressed series are left out', () => {
  const { series, metadata } = json('statcan');
  const members = parseStatcanMetadata(metadata);
  const rows = parseStatcanPrices(series, members);
  assert.ok(rows.every(row => row.date === '2026-09-01' && row.currency === 'CAD' && row.marketType === 'retail' && row.price > 0));
  assert.deepEqual([...new Set(rows.map(row => row.market))].sort(), ['Canada', 'Ontario', 'Yellowknife, Northwest Territories']);
  assert.equal(rows.filter(row => row.market === 'Canada').length, 106);
  const bacon = series.find(row => row.object.coordinate === '11.10.0.0.0.0.0.0.0.0').object.vectorDataPoint[0].value;
  assert.deepEqual(rows.find(row => row.market === 'Canada' && row.item === 'Bacon'),
    { item: 'Bacon', market: 'Canada', marketType: 'retail', unit: '500 g', currency: 'CAD', date: '2026-09-01', price: bacon, origin: '' });
  // Yellowknife collects only part of the basket; the rest answer FAILED and are not prices.
  assert.ok(series.some(row => row.status === 'FAILED'));
  const yellowknife = rows.filter(row => row.market.startsWith('Yellowknife')).length;
  assert.ok(yellowknife > 0 && yellowknife < 106);
  const keys = rows.map(row => JSON.stringify([row.market, row.item, row.unit]));
  assert.equal(new Set(keys).size, keys.length);

  // A suppressed cell (status code set) or a null value is skipped, not published as zero.
  const ontarioBacon = '6.10.0.0.0.0.0.0.0.0';
  const suppressed = series.map(row => (row.object.coordinate === ontarioBacon ? point(row, { value: null, statusCode: 1 }) : row));
  assert.ok(!parseStatcanPrices(suppressed, members).some(row => row.market === 'Ontario' && row.item === 'Bacon'));
  // A discontinued series whose latest point is an older month stays out of the newest month.
  const older = series.map(row => (row.object.coordinate === ontarioBacon ? point(row, { refPer: '2025-03-01' }) : row));
  const olderRows = parseStatcanPrices(older, members);
  assert.ok(olderRows.every(row => row.date === '2026-09-01'));
  assert.ok(!olderRows.some(row => row.market === 'Ontario' && row.item === 'Bacon'));
});

test('StatCan prices fail closed on moved coordinates, bad points and a thin national table', () => {
  const { series, metadata } = json('statcan');
  const members = parseStatcanMetadata(metadata);
  const swap = (coordinate, change) => series.map(row => (row.object.coordinate === coordinate ? change(row) : row));
  const bacon = '11.10.0.0.0.0.0.0.0.0';
  assert.throws(() => parseStatcanPrices(swap(bacon, row => ({ ...row, object: { ...row.object, coordinate: '11.10.1.0.0.0.0.0.0.0' } })), members), /coordinate format changed/);
  assert.throws(() => parseStatcanPrices(swap(bacon, row => ({ ...row, object: { ...row.object, coordinate: '99.10.0.0.0.0.0.0.0.0' } })), members), /coordinate format changed/);
  assert.throws(() => parseStatcanPrices(swap(bacon, row => point(row, { refPer: '2026-09' })), members), /data point format changed/);
  assert.throws(() => parseStatcanPrices(swap(bacon, row => point(row, { value: -1 })), members), /data point format changed/);
  const thin = series.filter(row => !row.object.coordinate.startsWith('11.') || Number(row.object.coordinate.split('.')[1]) < 20);
  assert.throws(() => parseStatcanPrices(thin, members), /national prices missing/);
});

test('StatCan collect batches coordinates under the WDS limit and rejects a short batch', async () => {
  const requests = [];
  const report = await collectStatcan(ctx(wds({ requests })));
  const batches = requests.filter(request => request.url.pathname.endsWith('/getDataFromCubePidCoordAndLatestNPeriods'));
  assert.equal(batches.length, 5);
  assert.ok(batches.every(batch => batch.body.length <= 300 && batch.body.every(entry => entry.productId === PRODUCT_ID && entry.latestN === 1)));
  assert.equal(batches.reduce((total, batch) => total + batch.body.length, 0), 13 * 106);
  assert.ok(requests.every(request => request.url.origin === 'https://www150.statcan.gc.ca' && request.url.pathname.startsWith('/t1/wds/rest/')));
  assert.equal(report.reportUrl, TABLE_URL);
  assert.deepEqual(report.refreshedReports, [{ date: '2026-09-01' }]);
  assert.deepEqual(report.contexts, []);
  const short = wds();
  await assert.rejects(collectStatcan(ctx(async (url, options) => {
    const answer = JSON.parse(await short(url, options));
    return JSON.stringify(url.endsWith('/getCubeMetadata') ? answer : answer.slice(1));
  })), /returned 299 of 300 series/);
  // A month after the run date is a publisher error, not data.
  const future = json('statcan').series.map(row => point(row, { refPer: '2026-12-01' }));
  await assert.rejects(collectStatcan(ctx(wds({ series: future }))), /future date/);
});

test('StatCan goes through the proxy with its POST bodies, and merges as a monthly report', async () => {
  const fake = wds();
  const calls = [];
  const proxyFetchFn = async (url, _config, options) => {
    calls.push({ url, options });
    const body = await fake(url, { method: options.method, body: options.body });
    return { ok: true, status: 200, buffer: Buffer.from(body), contentType: 'application/json', headers: {} };
  };
  const result = await collectFoodSource('statcan', { now: NOW, pause: async () => {}, proxyAuth: PROXY_AUTH, proxyFetchFn, firstProxyExit: 0,
    fetchFn: async url => { throw new Error(`direct fetch must not run for ${url}`); } });
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.options.method === 'POST' && JSON.parse(call.options.body).length));
  const merged = mergeFoodSnapshot(undefined, result);
  assert.deepEqual([...new Set(merged.observations.map(row => row.date))], ['2026-09-01']);
  await assert.rejects(collectFoodSource('statcan', { now: NOW, pause: async () => {},
    fetchFn: async () => new Response(null, { status: 302, headers: { location: 'https://www.statcan.gc.ca/en/start' } }) }), /left its publisher/);
});

test('IBGE IPCA becomes a dated food-inflation context, not a price', () => {
  assert.deepEqual(parseIbge(json('ibge')), {
    country: 'Brazil', countryCode: 'BR', referenceDate: '2026-10-01', url: 'https://sidra.ibge.gov.br/tabela/7060',
    title: 'Food and drink IPCA: +1.04% month-on-month (food at home +1.31%, away from home +0.36%); +5.73% over 12 months (index changes, not prices)',
  });
  const negative = json('ibge').map((row, i) => (i && row.D2C === '63' && row.D4C === '7432' ? { ...row, V: '-0.20' } : row));
  assert.match(parseIbge(negative).title, /away from home -0\.20%/);
});

test('IBGE fails closed on a moved column, a relabelled group, a missing value or mixed months', () => {
  const rows = json('ibge');
  const change = (pick, update) => rows.map((row, i) => (i && pick(row) ? { ...row, ...update } : row));
  assert.throws(() => parseIbge([{ ...rows[0], D3C: 'Trimestre (Código)' }, ...rows.slice(1)]), /columns format changed/);
  assert.throws(() => parseIbge(change(row => row.D4C === '7171', { D4N: '11.Alimentos' })), /7171 change format changed/);
  assert.throws(() => parseIbge(change(row => row.D2C === '2265' && row.D4C === '7170', { V: '...' })), /7170 change format changed/);
  assert.throws(() => parseIbge(change(row => row.D2C === '63' && row.D4C === '7170', { MN: 'número-índice' })), /7170 change format changed/);
  assert.throws(() => parseIbge(change(row => row.D4C === '7432', { D3C: '202609' })), /month format changed/);
  assert.throws(() => parseIbge(rows.filter((row, i) => !i || row.D4C !== '7432')), /7432 change format changed/);
  assert.throws(() => parseIbge([]), /response format changed/);
  assert.throws(() => parseIbge({ erro: 'Tabela não encontrada' }), /response format changed/);
});

test('IBGE collect reads the API host, links the table page and rejects a future month', async () => {
  const requests = [];
  const report = await collectIbge(ctx(async url => { requests.push(url); return JSON.stringify(json('ibge')); }));
  assert.deepEqual(requests, [DATA_URL]);
  assert.equal(new URL(DATA_URL).hostname, 'apisidra.ibge.gov.br');
  assert.deepEqual(report.observations, []);
  assert.equal(report.contexts[0].referenceDate, '2026-10-01');
  const future = json('ibge').map((row, i) => (i ? { ...row, D3C: '202612' } : row));
  await assert.rejects(collectIbge(ctx(async () => JSON.stringify(future))), /future month/);

  const result = await collectFoodSource('ibge', { now: NOW, pause: async () => {}, fetchFn: async () => new Response(JSON.stringify(json('ibge'))) });
  assert.equal(result.contexts[0].url, 'https://sidra.ibge.gov.br/tabela/7060');
  await assert.rejects(collectFoodSource('ibge', { now: NOW, pause: async () => {},
    fetchFn: async () => new Response(null, { status: 302, headers: { location: 'https://servicodados.ibge.gov.br/api/v3/agregados' } }) }), /left its publisher/);
});
