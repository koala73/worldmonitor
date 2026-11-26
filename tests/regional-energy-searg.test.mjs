// Argentina Secretaría de Energía pump prices (Res. 314/2016, #11154). The
// fixture is a verbatim excerpt (the first 40 stations) of the "precios
// vigentes" CSV as archived on 2024-02-06; expected medians were computed from
// it independently (see tests/fixtures/regional-energy/README.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchRegionalEnergyFeed } from '../scripts/_regional-energy-source.mjs';
import feeds from '../scripts/shared/regional-energy-feeds.json' with { type: 'json' };
import { SEARG_CSV_URL, parseSeArgentinaPrices } from '../scripts/lib/regional-fuel-feeds.mjs';
import { regionalFuelEntries, regionalFuelHasUsableFx } from '../scripts/seed-fuel-prices.mjs';

const csv = readFileSync(new URL('./fixtures/regional-energy/searg-surtidor-2024-02-06.csv', import.meta.url), 'utf8');
const NOW = Date.parse('2024-02-06T12:00:00Z');
const SMALL = { minStations: 20 };
const value = (points, area) => {
  const hits = points.filter(p => p.metric === 'fuel.retail_price' && p.area === area);
  assert.equal(hits.length, 1, area);
  return hits[0];
};
const [header, ...lines] = csv.replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean);
const withRows = rows => [header, ...rows].join('\n');

describe('Argentina Secretaría de Energía pump prices', () => {
  it('publishes the daytime median of stations that declared within 30 days of the newest declaration', () => {
    const points = parseSeArgentinaPrices(csv, NOW, SMALL);
    assert.equal(points.length, 4);
    assert.ok(points.every(p => p.unit === 'ARS/l' && p.period === '2024-02-05'), 'dated by the newest declaration');
    assert.equal(value(points, 'Nafta (súper) entre 92 y 95 Ron; median of stations').value, 826);
    assert.equal(value(points, 'Nafta (premium) de más de 95 Ron; median of stations').value, 1010);
    assert.equal(value(points, 'Gas Oil Grado 2; median of stations').value, 906);
    assert.equal(value(points, 'Gas Oil Grado 3; median of stations').value, 1063);
  });

  it('ignores night tariffs, CNG, future-dated and unpriced rows, and keeps each station once', () => {
    const superRow = lines.find(l => /,2,Nafta \(súper\) entre 92 y 95 Ron,2,Diurno,/.test(l));
    const night = superRow.replace(',2,Diurno,', ',3,Nocturno,').replace(/,Diurno,[\d.]+,/, ',Nocturno,99999.0,');
    const future = superRow.replace(/,(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),/, ',2024-03-01 00:00:00,').replace(/,Diurno,[\d.]+,/, ',Diurno,99999.0,');
    const unpriced = superRow.replace(/,Diurno,[\d.]+,/, ',Diurno,,');
    const base = parseSeArgentinaPrices(csv, NOW, SMALL);
    const noisy = parseSeArgentinaPrices(withRows([...lines, night, future, unpriced]), NOW, SMALL);
    assert.deepEqual(noisy, base);
  });

  it('dates the window by the newest declaration, not by the run clock', () => {
    const later = parseSeArgentinaPrices(csv, Date.parse('2024-04-01T00:00:00Z'), SMALL);
    assert.deepEqual(later, parseSeArgentinaPrices(csv, NOW, SMALL));
  });

  it('fails closed on a renamed product, a changed tariff code, missing columns or a thin sample', () => {
    assert.throws(() => parseSeArgentinaPrices(csv.replaceAll('Gas Oil Grado 2', 'Gasoil Grado 2'), NOW, SMALL), /Changed Secretaría de Energía product 19/);
    assert.throws(() => parseSeArgentinaPrices(csv.replaceAll(',2,Diurno,', ',2,Día,'), NOW, SMALL), /Changed Secretaría de Energía tariff/);
    assert.throws(() => parseSeArgentinaPrices(csv.replace('fecha_vigencia', 'fecha'), NOW, SMALL), /Changed Secretaría de Energía price columns/);
    assert.throws(() => parseSeArgentinaPrices(csv, NOW), /Secretaría de Energía station sample is incomplete/, 'default threshold needs 200 stations');
    assert.throws(() => parseSeArgentinaPrices(withRows(lines.map(l => l.replace(/,Diurno,[\d.]+,/, ',Diurno,n/a,'))), NOW, SMALL), /Unreadable Secretaría de Energía rows/);
  });

  // Synthetic rows hold only the columns the parser reads.
  const NAMES = { 2: 'Nafta (súper) entre 92 y 95 Ron', 3: 'Nafta (premium) de más de 95 Ron', 19: 'Gas Oil Grado 2', 21: 'Gas Oil Grado 3' };
  const row = (station, product, price, when, night = false) =>
    [station, product, NAMES[product], night ? 3 : 2, night ? 'Nocturno' : 'Diurno', price, when].join(',');
  const synthetic = rows => ['idempresa,idproducto,producto,idtipohorario,tipohorario,precio,fecha_vigencia', ...rows].join('\n');
  const both = (station, price, when, night) => [row(station, 2, price, when, night), row(station, 19, price, when, night)];
  const ONE = { minStations: 1 };
  const superMedian = points => value(points, 'Nafta (súper) entre 92 y 95 Ron; median of stations');

  it('keeps only each station\'s newest daytime declaration, whatever the file order', () => {
    const rows = [
      ...both(1, '5000.0', '2024-01-20 09:00:00'), // superseded by the station's newer price
      ...both(1, '100.0', '2024-02-01 10:00:00'),
      ...both(2, '200.0', '2024-02-01 10:00:00'),
      ...both(3, '300.0', '2024-02-01 10:00:00'),
      ...both(3, '99999.0', '2024-02-03 22:00:00', true), // a newer night tariff never counts
      ...both(4, '400.0', '2024-02-01 10:00:00'),
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const median = superMedian(parseSeArgentinaPrices(synthetic(ordered), NOW, ONE));
      assert.equal(median.value, 250, 'even count: mean of the middle pair');
      assert.equal(median.period, '2024-02-01');
    }
  });

  it('counts a station declared exactly 30 days before the newest one, not a second earlier', () => {
    const rows = [
      ...both(1, '100.0', '2024-02-01 00:00:00'),
      ...both(2, '200.0', '2024-01-02 00:00:00'),
      ...both(3, '900.0', '2024-01-01 23:59:59'),
    ];
    assert.equal(superMedian(parseSeArgentinaPrices(synthetic(rows), NOW, ONE)).value, 150);
  });

  it('anchors the window on the newest declaration of any product, premium and grade 3 included', () => {
    const rows = [
      ...both(1, '100.0', '2024-01-02 10:00:00'), // 34 days before the premium price, outside the window
      ...both(2, '300.0', '2024-01-31 10:00:00'),
      row(3, 3, '900.0', '2024-02-05 10:00:00'),
    ];
    const points = parseSeArgentinaPrices(synthetic(rows), NOW, ONE);
    assert.equal(superMedian(points).value, 300);
    assert.ok(points.every(p => p.period === '2024-02-05'), 'dated by the premium declaration');
  });

  it('omits a thin premium or grade 3 sample but fails on a thin headline product', () => {
    const rows = [1, 2, 3].flatMap(s => both(s, `${s}00.0`, '2024-02-01 10:00:00'));
    const points = parseSeArgentinaPrices(synthetic([...rows, row(1, 3, '400.0', '2024-02-01 10:00:00'), row(1, 21, '500.0', '2024-02-01 10:00:00')]), NOW, { minStations: 3 });
    assert.deepEqual(points.map(p => p.area).sort(), ['Gas Oil Grado 2; median of stations', 'Nafta (súper) entre 92 y 95 Ron; median of stations']);
    const thinDiesel = rows.filter(r => !r.startsWith('3,19,'));
    assert.throws(() => parseSeArgentinaPrices(synthetic(thinDiesel), NOW, { minStations: 3 }), /station sample is incomplete/);
  });

  it('tolerates up to 5% unreadable daytime rows, counting bad prices and bad dates', () => {
    const bad = [row(90, 2, 'n/a', '2024-02-01 10:00:00'), row(91, 19, '800.0', '01/02/2024')];
    const stations = n => Array.from({ length: n }, (_, i) => both(i + 1, `${i + 1}00.0`, '2024-02-01 10:00:00')).flat();
    assert.equal(parseSeArgentinaPrices(synthetic([...stations(19), ...bad]), NOW, ONE).length, 2, '2 of 40 rows');
    assert.throws(() => parseSeArgentinaPrices(synthetic([...stations(18), ...bad]), NOW, ONE), /Unreadable/, '2 of 38 rows');
    const ragged = [bad[0], '92,2,Nafta (súper) entre 92 y 95 Ron,2,Diurno'];
    assert.equal(parseSeArgentinaPrices(synthetic([...stations(19), ...ragged]), NOW, ONE).length, 2, 'a short row is one more unreadable row');
    assert.throws(() => parseSeArgentinaPrices(synthetic([...stations(18), ...ragged]), NOW, ONE), /Unreadable/);
  });

  it('reads the CSV through the regional feed with the shared provenance', async () => {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push(url);
      assert.match(options.headers['User-Agent'], /^WorldMonitor\/1\.0/);
      if (url !== SEARG_CSV_URL) throw new Error(`unexpected request ${url}`);
      return new Response(csv);
    };
    const feed = feeds.find(f => f.id === 'searg');
    assert.equal(feed.countryCode, 'AR');
    assert.equal(feed.licence, 'CC-BY-4.0');
    // The fixture's 25 in-window stations are below the live threshold; serve
    // nine copies with distinct station ids so the full path runs at the default.
    const stations = [];
    for (let copy = 0; copy < 9; copy++) for (const l of lines) stations.push(l.replace(/^([^,]*),(\d+),/, (_, t, id) => `${t},${id}${copy},`));
    const big = withRows(stations);
    const data = await fetchRegionalEnergyFeed('searg', { fetchFn: async (url, options) => { await fetchFn(url, options); return new Response(big); }, nowMs: NOW });
    assert.deepEqual(calls, [SEARG_CSV_URL]);
    assert.equal(data.sourceId, 'searg');
    assert.equal(data.observations.length, 4);
    assert.equal(value(data.observations, 'Gas Oil Grado 2; median of stations').value, 906);
  });
});

describe('Argentina fuel-price panel row', () => {
  const snapshot = { sourceId: 'searg', observations: parseSeArgentinaPrices(csv, NOW, SMALL) };

  it('maps the súper and grado 2 medians and keeps the declaration date', () => {
    const [entry] = regionalFuelEntries({ searg: snapshot }, NOW);
    assert.equal(entry.code, 'AR');
    assert.equal(entry.currency, 'ARS');
    assert.deepEqual(entry.gasoline, { localPrice: 826, grade: 'Súper (92–95 RON)', source: 'datos.energia.gob.ar', observedAt: '2024-02-05' });
    assert.deepEqual(entry.diesel, { localPrice: 906, grade: 'Grado 2', source: 'datos.energia.gob.ar', observedAt: '2024-02-05' });
    assert.deepEqual(regionalFuelEntries({ searg: snapshot }, Date.parse('2024-02-20T00:00:00Z')), [], 'expires after 14 days');
  });

  it('needs a live ARS quote: the static fallback is not trusted for the peso', () => {
    const [entry] = regionalFuelEntries({ searg: snapshot }, NOW);
    assert.equal(regionalFuelHasUsableFx(entry, { ARS: 0.0006, fallbackCurrencies: [] }), true);
    assert.equal(regionalFuelHasUsableFx(entry, { ARS: 0.00084, fallbackCurrencies: ['ARS'] }), false);
    assert.equal(regionalFuelHasUsableFx(entry, {}), false);
    const [uruguay] = regionalFuelEntries({ ursea: { sourceId: 'ursea', observations: [
      { metric: 'fuel.retail_price', period: '2024-02-01', value: 90, unit: 'UYU/l', area: 'Gasolina Súper 95' },
    ] } }, NOW);
    assert.equal(regionalFuelHasUsableFx(uruguay, {}), true, 'other feeds keep the shared fallback');
  });
});
