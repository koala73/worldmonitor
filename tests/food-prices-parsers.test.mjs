import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parsePihps, parsePbs, parseDa, parseCbsl, parseSniim, parseOnagri,
  parseGiews, mergeHistory, discoverReports, giewsCountries,
} from '../scripts/lib/food-prices.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/food-prices/${name}`, import.meta.url), 'utf8');

test('PIHPS retains national dated prices, without interpreting missing values as zero', () => {
  const rows = parsePihps(JSON.parse(fixture('pihps.json')), { name: 'Beras', denomination: 'kg' });
  assert.equal(rows.find(r => r.date === '2026-10-29').price, 16500);
  assert.equal(rows.find(r => r.date === '2026-10-22').price, 16400);
  assert.ok(rows.every(r => r.market === 'Semua Provinsi' && r.currency === 'IDR'));
  assert.deepEqual(parsePihps({ data: [{ level: 0, name: 'National', '29/10/2026': '-' }] }, { name: 'Rice', denomination: 'kg' }), []);
});

test('PBS keeps each city average and published package size', () => {
  const rows = parsePbs(JSON.parse(fixture('pbs.json')));
  const flour = rows.find(r => r.market === 'Islamabad (01)' && r.item === 'Wheat Flour Bag');
  assert.equal(flour.price, 3286.54);
  assert.equal(flour.unit, '20 Kg');
  assert.equal(flour.date, '2026-10-22');
  assert.ok(rows.some(r => /Karachi/.test(r.market)));
  assert.ok(rows.every(r => r.price > 0 && r.currency === 'PKR'));
});

test('DA parses market rows with source column identities and excludes NOT AVAILABLE', () => {
  const pages = JSON.parse(fixture('da.json'));
  const rows = parseDa(pages, '2026-10-29');
  const rice = rows.find(r => r.market === 'Agora Public Market/San Juan' && r.item === 'Premium Rice (Imported)');
  assert.equal(rice.price, 52);
  assert.equal(rice.unit, 'kg');
  assert.equal(rows.find(r => r.market === rice.market && r.item === 'Well-milled Rice (Imported)'), undefined);
  assert.ok(rows.some(r => r.item === 'Sugar (Refined)'));
  assert.ok(rows.every(r => r.price > 0));
  assert.throws(() => parseDa([[{ text: 'Unrelated PDF', x: 0, y: 0 }]], '2026-10-29'), /format|date mismatch/);
});

test('CBSL selects Today columns and separates retail and wholesale markets', () => {
  const rows = parseCbsl(JSON.parse(fixture('cbsl.json')), '2026-10-29');
  const beans = rows.filter(r => r.item === 'Beans');
  assert.equal(beans.find(r => r.market === 'Pettah' && r.marketType === 'wholesale').price, 500);
  assert.ok(beans.some(r => r.market === 'Narahenpita' && r.marketType === 'retail'));
  assert.ok(rows.every(r => r.currency === 'LKR' && r.unit === 'kg'));
});

test('SNIIM retains destination, origin and frequent kilogram price', () => {
  const rows = parseSniim(fixture('sniim.html'), 'Cebolla Bola - Primera');
  assert.equal(rows[0].date, '2026-10-21');
  assert.equal(rows[0].price, 34);
  assert.equal(rows[0].origin, 'Baja California');
  assert.match(rows[0].market, /La Paz/);
  assert.equal(rows[0].unit, 'kg');
  assert.equal(rows[0].marketType, 'wholesale');
});

test('ONAGRI is a monthly wholesale context and converts millimes to TND', () => {
  const rows = parseOnagri(fixture('onagri.html'), '2026-07-01');
  assert.equal(rows[0].item, 'تين');
  assert.equal(rows[0].price, 8);
  assert.equal(rows[0].currency, 'TND');
  assert.equal(rows[0].date, '2026-07-01');
});

test('GIEWS preserves the reference date rather than the fetch date', () => {
  const context = parseGiews(fixture('giews.html'), { code: 'BGD', name: 'Bangladesh' });
  assert.equal(context.referenceDate, '2026-09-04');
  assert.equal(context.country, 'Bangladesh');
  assert.match(context.url, /code=BGD/);
  assert.throws(() => parseGiews('<h1>Blocked</h1>', { code: 'BGD', name: 'Bangladesh' }), /reference date/);
  assert.deepEqual(giewsCountries('<option value="country.jsp?lang=en&code=BGD">Bangladesh</option>'), [{ code: 'BGD', name: 'Bangladesh' }]);
});

test('report discovery distinguishes food from tobacco and uses source dates', () => {
  const html = '<a href="/Daily-Cigarette-Price-Monitoring-October-29-2026.pdf">October 29, 2026</a>'
    + '<a href="/Price-Monitoring-October-29-2026.pdf">October 29, 2026</a>'
    + '<a href="/Price-Monitoring-October-22-2026.pdf">October 22, 2026</a>';
  const reports = discoverReports(html, 'da');
  assert.equal(reports.length, 2);
  assert.equal(reports[0].date, '2026-10-29');
  assert.equal(reports[1].date, '2026-10-22');
  assert.ok(!reports[0].url.includes('Cigarette'));
  assert.deepEqual(discoverReports('<a href="https://evil.example/Price-Monitoring-October-29-2026.pdf">October 29, 2026</a>', 'da'), []);
});

test('history merges idempotently and retains different markets and origins', () => {
  const row = { date: '2026-10-22', market: 'Market', marketType: 'retail', item: 'Rice', unit: 'kg', currency: 'PHP', price: 50, origin: '' };
  const next = { ...row, date: '2026-10-29', price: 55 };
  const rows = mergeHistory([row, { ...row, date: '2025-01-01' }], [next, { ...next, origin: 'Imported' }]);
  assert.equal(rows.length, 3);
  assert.deepEqual(mergeHistory(rows, [next, { ...next, origin: 'Imported' }]), rows);
  assert.deepEqual(mergeHistory(rows, [next]), [row, next]);
  assert.ok(!rows.some(r => r.date === '2025-01-01'));
});

test('PBS archive discovers real annex URLs independently of inaccurate post slugs', () => {
  const reports = discoverReports('annexureExcel: "wp-content/uploads/2026/10/Annex_15.10.2026.xlsx"', 'pbs');
  assert.equal(reports[0].date, '2026-10-15');
  assert.equal(reports[0].url, 'https://www.pbs.gov.pk/wp-content/uploads/2026/10/Annex_15.10.2026.xlsx');
  const mixed = discoverReports('annexureExcel: "wp-content/uploads/2026/10/Annex_22.10.2026.xlsx" <a href="/weekly-sensitive-price-indicator-23-10-2026/">newer post</a>', 'pbs');
  assert.deepEqual(mixed.map(report => report.date), ['2026-10-22']);
});

test('SNIIM single-day tables omit date cells, and paginated responses cannot silently truncate', () => {
  const html = 'Registros del 28/10/2026 al 28/10/2026 <table><tr><td>Kilogramo</td><td>Origin</td><td>Market</td><td>20</td><td>40</td><td>35</td><td></td></tr></table>';
  assert.equal(parseSniim(html, 'Onion', '2026-10-28')[0].price, 35);
  assert.throws(() => parseSniim(html, 'Onion', '2026-10-29'), /date mismatch/);
  assert.throws(() => parseSniim(html + '<p>Página 1 de 10</p>', 'Onion'), /paginated/);
});

test('PDF dates must agree with discovered report dates', () => {
  assert.throws(() => parseDa(JSON.parse(fixture('da.json')), '2026-10-28'), /date mismatch/);
  assert.throws(() => parseCbsl(JSON.parse(fixture('cbsl.json')), '2026-10-28'), /date mismatch/);
});

test('PBS food classification excludes toilet soap despite its oil substring', () => {
  const sheets = JSON.parse(fixture('pbs.json'));
  for (const rows of sheets) {
    const food = rows.find(row => typeof row[0] === 'number' && row[1] === 'Wheat Flour Bag');
    if (food) rows.push([999, 'Toilet Soap LIFEBUOY 115 gm', ...food.slice(2)]);
  }
  assert.ok(parsePbs(sheets).every(row => !row.item.includes('Soap')));
});

test('DA accepts both publisher date layouts without accepting a different report day', () => {
  const pages = JSON.parse(fixture('da.json'));
  for (const page of pages) for (const item of page) item.text = item.text.replace('Thursday, October 29, 2026', 'Thursday, 29 October 2026');
  assert.ok(parseDa(pages, '2026-10-29').length > 0);
  assert.throws(() => parseDa(pages, '2026-10-22'), /date mismatch/);
});

test('PDF parsers reject reordered or shifted price-column headers', () => {
  const da = JSON.parse(fixture('da.json'));
  const tomato = da[1].find(item => item.text === 'Tomato');
  const cabbage = da[1].find(item => item.text === 'Cabbage');
  [tomato.x, cabbage.x] = [cabbage.x, tomato.x];
  assert.throws(() => parseDa(da, '2026-10-29'), /column layout changed/);
  const cbsl = JSON.parse(fixture('cbsl.json'));
  cbsl[0].filter(item => item.text === 'Today').forEach(item => { item.x -= 40; });
  assert.throws(() => parseCbsl(cbsl, '2026-10-29'), /column layout changed/);
});
