// Western Australia FuelWatch pump prices (#10838). The fixture is a verbatim
// excerpt (every 30th station, 24 and 25 November) of FuelWatchRetail-11-2026.csv
// as read on 2026-11-26; expected medians were computed from it independently
// (see tests/fixtures/regional-energy/README.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchRegionalEnergyFeed } from '../scripts/_regional-energy-source.mjs';
import feeds from '../scripts/shared/regional-energy-feeds.json' with { type: 'json' };
import { fuelWatchCsvUrls, parseFuelWatchPrices } from '../scripts/lib/regional-fuel-feeds.mjs';
import { regionalFuelEntries } from '../scripts/seed-fuel-prices.mjs';

const csv = readFileSync(new URL('./fixtures/regional-energy/fuelwatch-retail-2026-11-excerpt.csv', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-26T06:00:00Z');
const SMALL = { minStations: 15 };
const value = (points, area) => {
  const hits = points.filter(p => p.metric === 'fuel.retail_price' && p.area === area);
  assert.equal(hits.length, 1, area);
  return hits[0];
};
const [header, ...lines] = csv.split(/\r?\n/).filter(Boolean);
const withRows = rows => [header, ...rows].join('\n');
const row = (station, product, price, day = '25/11/2026') =>
  [day, `Station ${station}`, 'Brand', product, price, `${station} Main St`, 'PERTH', '6000', 'Central', 'Metro'].join(',');
const both = (station, price, day) => [row(station, 'ULP', price, day), row(station, 'Diesel', price, day)];
const ONE = { minStations: 1 };
const ulp = points => value(points, 'ULP; median of stations');

describe('Western Australia FuelWatch pump prices', () => {
  it('publishes the station median for the newest day in the file, in AUD/l', () => {
    const points = parseFuelWatchPrices(csv, NOW, SMALL);
    assert.equal(points.length, 4);
    assert.ok(points.every(p => p.unit === 'AUD/l' && p.period === '2026-11-25'));
    assert.equal(ulp(points).value, 2.099);
    assert.equal(value(points, 'PULP; median of stations').value, 2.229);
    assert.equal(value(points, '98 RON; median of stations').value, 2.319);
    assert.equal(value(points, 'Diesel; median of stations').value, 2.569);
  });

  it('ignores other products and days after today in Perth', () => {
    const lastDay = lines.filter(l => l.startsWith('25/11/2026'));
    const earlier = parseFuelWatchPrices(withRows(lines.filter(l => l.startsWith('24/11/2026'))), NOW, SMALL);
    assert.equal(ulp(earlier).value, 1.947);
    // 27 November is still tomorrow in Perth at 06:00Z on the 26th.
    const future = lastDay.map(l => l.replace('25/11/2026', '27/11/2026').replace(/,(\d+\.\d+),/, ',999.90,'));
    assert.deepEqual(parseFuelWatchPrices(withRows([...lines, ...future]), NOW, SMALL), parseFuelWatchPrices(csv, NOW, SMALL));
    assert.equal(ulp(parseFuelWatchPrices(withRows([...lines, ...future]), Date.parse('2026-11-26T16:00:00Z'), SMALL)).value, 9.999);
    const lpg = lastDay.filter(l => l.includes(',ULP,')).map(l => l.replace(',ULP,', ',LPG,').replace(/,(\d+\.\d+),/, ',999.90,'));
    assert.deepEqual(parseFuelWatchPrices(withRows([...lines, ...lpg]), NOW, SMALL), parseFuelWatchPrices(csv, NOW, SMALL));
  });

  it('counts a station once per product and day', () => {
    const rows = [...both(1, '100.0'), ...both(2, '200.0'), ...both(3, '300.0'), ...both(4, '400.0')];
    assert.equal(ulp(parseFuelWatchPrices(withRows(rows), NOW, ONE)).value, 2.5, 'even count: mean of the middle pair');
    assert.equal(ulp(parseFuelWatchPrices(withRows([...rows, row(4, 'ULP', '400.0')]), NOW, ONE)).value, 2.5);
  });

  it('omits a thin premium sample but fails on thin ULP or diesel', () => {
    const rows = [1, 2, 3].flatMap(s => both(s, `${s}00.0`));
    const points = parseFuelWatchPrices(withRows([...rows, row(1, 'PULP', '210.0')]), NOW, { minStations: 3 });
    assert.deepEqual(points.map(p => p.area).sort(), ['Diesel; median of stations', 'ULP; median of stations']);
    assert.throws(() => parseFuelWatchPrices(withRows(rows.filter(r => !r.includes('Station 3,Brand,Diesel'))), NOW, { minStations: 3 }), /station sample is incomplete/);
    assert.throws(() => parseFuelWatchPrices(csv, NOW), /station sample is incomplete/, 'default threshold needs 400 stations');
    // A partly written newest day falls back to the last complete one.
    const partial = [...[1, 2, 3].flatMap(s => both(s, `${s}00.0`, '24/11/2026')), ...both(1, '900.0')];
    const points2 = parseFuelWatchPrices(withRows(partial), NOW, { minStations: 3 });
    assert.equal(ulp(points2).period, '2026-11-24');
    assert.equal(ulp(points2).value, 2);
  });

  it('fails closed on changed columns and on more than 5% unreadable rows', () => {
    assert.throws(() => parseFuelWatchPrices(csv.replace('PRODUCT_PRICE', 'PRICE'), NOW, SMALL), /Changed FuelWatch price columns/);
    const stations = n => Array.from({ length: n }, (_, i) => both(i + 1, `${i + 1}00.0`)).flat();
    const bad = [row(90, 'ULP', 'n/a'), row(91, 'Diesel', '200.0', '2026-11-25')];
    assert.equal(parseFuelWatchPrices(withRows([...stations(19), ...bad]), NOW, ONE).length, 2, '2 of 40 rows');
    assert.throws(() => parseFuelWatchPrices(withRows([...stations(18), ...bad]), NOW, ONE), /Unreadable FuelWatch rows/, '2 of 38 rows');
    const ragged = [bad[0], '25/11/2026,Station 92,Brand,ULP'];
    assert.equal(parseFuelWatchPrices(withRows([...stations(19), ...ragged]), NOW, ONE).length, 2, 'a short row is one more unreadable row');
    assert.throws(() => parseFuelWatchPrices(withRows([...stations(18), ...ragged]), NOW, ONE), /Unreadable/);
  });

  it('reads this month in Perth time and falls back to last month only when the file is missing', async () => {
    assert.deepEqual(fuelWatchCsvUrls(Date.parse('2026-11-30T17:00:00Z')).map(u => u.split('/').at(-1)),
      ['FuelWatchRetail-12-2026.csv', 'FuelWatchRetail-11-2026.csv'], 'already 1 December in Perth');
    assert.deepEqual(fuelWatchCsvUrls(Date.parse('2027-01-01T03:00:00Z')).map(u => u.split('/').at(-1)),
      ['FuelWatchRetail-01-2027.csv', 'FuelWatchRetail-12-2026.csv']);

    const feed = feeds.find(f => f.id === 'fuelwatch');
    assert.equal(feed.countryCode, 'AU');
    assert.equal(feed.licence, 'CC-BY-4.0');
    // The fixture's stations are below the live threshold; serve copies with
    // distinct station names so the full path runs at the default.
    const big = withRows(Array.from({ length: 25 }, (_, copy) => lines.map(l => l.replace(/^([^,]*),([^,]*),/, (_, d, n) => `${d},${n} #${copy},`))).flat());
    const [current, previous] = fuelWatchCsvUrls(NOW);
    const serve = status => async (url, options) => {
      assert.match(options.headers['User-Agent'], /^WorldMonitor\/1\.0/);
      if (url === current) return new Response(status === 200 ? big : 'missing', { status });
      if (url === previous) return new Response(big);
      throw new Error(`unexpected request ${url}`);
    };
    const data = await fetchRegionalEnergyFeed('fuelwatch', { fetchFn: serve(200), nowMs: NOW });
    assert.deepEqual(data.dataUrls, [current]);
    assert.equal(data.observations.length, 4);
    assert.equal(value(data.observations, 'Diesel; median of stations').value, 2.569);
    const fallback = await fetchRegionalEnergyFeed('fuelwatch', { fetchFn: serve(404), nowMs: NOW });
    assert.deepEqual(fallback.dataUrls, [previous]);
    // A new month's file holding only its header is not yet a publication.
    const headerOnly = async (url, options) => url === current ? new Response(`${header}\n`) : serve(200)(url, options);
    const empty = await fetchRegionalEnergyFeed('fuelwatch', { fetchFn: headerOnly, nowMs: NOW });
    assert.deepEqual(empty.dataUrls, [current, previous]);
    assert.equal(empty.observations.length, 4);
    const renamed = async (url, options) => url === current ? new Response(big.replace('PRODUCT_PRICE', 'PRICE')) : serve(200)(url, options);
    await assert.rejects(fetchRegionalEnergyFeed('fuelwatch', { fetchFn: renamed, nowMs: NOW }), /Changed FuelWatch price columns/, 'a layout change is not masked by last month');
    await assert.rejects(fetchRegionalEnergyFeed('fuelwatch', { fetchFn: serve(503), nowMs: NOW }), /HTTP 503/);
    // A started file that turns corrupt fails the run, so the last good snapshot stays.
    const corrupt = body => async (url, options) => url === current ? new Response(body) : serve(200)(url, options);
    const unreadable = withRows(big.split('\n').slice(1).map(l => l.replace(/^((?:[^,]*,){4})[^,]*/, '$1n/a')));
    await assert.rejects(fetchRegionalEnergyFeed('fuelwatch', { fetchFn: corrupt(unreadable), nowMs: NOW }), /Unreadable FuelWatch rows/);
    await assert.rejects(fetchRegionalEnergyFeed('fuelwatch', { fetchFn: corrupt(`${big}\n"25/11/2026,unterminated`), nowMs: NOW }), /Invalid energy CSV/);
  });

  it('falls back to last month while the new file has no complete day', async () => {
    const [current, previous] = fuelWatchCsvUrls(NOW);
    const big = withRows(Array.from({ length: 25 }, (_, copy) => lines.map(l => l.replace(/^([^,]*),([^,]*),/, (_, d, n) => `${d},${n} #${copy},`))).flat());
    const partial = withRows(both(1, '199.9', '26/11/2026'));
    const fetchFn = async url => new Response(url === current ? partial : big);
    const data = await fetchRegionalEnergyFeed('fuelwatch', { fetchFn, nowMs: NOW });
    assert.deepEqual(data.dataUrls, [current, previous]);
    assert.equal(data.observations[0].period, '2026-11-25');
  });
});

describe('Western Australia fuel-price panel row', () => {
  const snapshot = { sourceId: 'fuelwatch', observations: parseFuelWatchPrices(csv, NOW, SMALL) };

  it('names the row for Western Australia and keeps the price day', () => {
    const [entry] = regionalFuelEntries({ fuelwatch: snapshot }, NOW);
    assert.equal(entry.code, 'AU');
    assert.equal(entry.name, 'Australia (Western Australia)');
    assert.equal(entry.currency, 'AUD');
    assert.deepEqual(entry.gasoline, { localPrice: 2.099, grade: 'ULP 91 (WA station median)', source: 'FuelWatch (WA)', observedAt: '2026-11-25' });
    assert.deepEqual(entry.diesel, { localPrice: 2.569, grade: 'Diesel (WA station median)', source: 'FuelWatch (WA)', observedAt: '2026-11-25' });
    assert.deepEqual(regionalFuelEntries({ fuelwatch: snapshot }, Date.parse('2026-12-01T00:00:00Z')), [], 'expires after 5 days');
  });
});
