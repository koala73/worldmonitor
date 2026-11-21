import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, discoverMadrReports, parseMadr } from '../scripts/lib/food-prices-adapters/madr.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/food-prices/madr.json', import.meta.url), 'utf8'));
const find = (rows, item) => rows.find(row => row.item === item);

test('MADR reads the national retail mean for each product in its published unit', () => {
  const rows = parseMadr(fixture().pages['2026-11-02'], '2026-11-02');
  assert.equal(rows.length, 19);
  assert.deepEqual(find(rows, 'Potatoes'), { item: 'Potatoes', market: 'National average', marketType: 'retail', unit: 'kg', currency: 'DZD', date: '2026-11-02', price: 95, origin: '' });
  assert.equal(find(rows, 'Tomatoes').price, 138);
  assert.equal(find(rows, 'Beef (local)').price, 2224);
  assert.equal(find(rows, 'Chicken (broiler)').price, 467);
  assert.deepEqual([find(rows, 'Eggs').price, find(rows, 'Eggs').unit], [22, 'piece']);
  assert.deepEqual([find(rows, 'Cow milk').price, find(rows, 'Cow milk').unit], [94, 'litre']);
  assert.ok(rows.every(row => row.price > 0 && row.market === 'National average'));
});

test('MADR rejects a different date, a moved price column or an unrelated PDF', () => {
  const page = fixture().pages['2026-11-02'];
  assert.throws(() => parseMadr(page, '2026-10-26'), /date mismatch/);
  assert.throws(() => parseMadr(page.filter(item => item.text !== 'Moyenne'), '2026-11-02'), /format changed/);
  assert.throws(() => parseMadr(page.map(item => item.text === 'Moyenne' ? { ...item, x: item.x + 200 } : item), '2026-11-02'), /format changed/);
  assert.throws(() => parseMadr([{ text: 'Communiqué', x: 0, y: 0 }], '2026-11-02'), /format changed/);
});

test('MADR rejects a product row whose mean is outside its minimum and maximum', () => {
  const page = fixture().pages['2026-11-02'].map(item => (item.text === '95' && Math.round(item.y) === 358 ? { ...item, text: '950' } : item));
  assert.throws(() => parseMadr(page, '2026-11-02'), /mean outside its range/);
});

test('MADR rejects an oversized product label in linear time (CWE-1333)', () => {
  const page = fixture().pages['2026-11-02'].map(item => (item.text === 'Tomate' ? { ...item, text: `Tomate ${'('.repeat(1)}${' a'.repeat(200_000)}` } : item));
  const started = Date.now();
  assert.throws(() => parseMadr(page, '2026-11-02'), /format changed/);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
});

test('MADR discovers dated price PDFs from the WordPress media list, whatever the file-name suffix', () => {
  const reports = discoverMadrReports(fixture().media);
  assert.equal(reports[0].date, '2026-11-02');
  assert.ok(reports.some(report => report.date === '2026-10-25' && /Prix_25_Oct_2026_MADRP\.pdf$/.test(report.url)), 'capitalised title');
  assert.ok(reports.some(report => report.date === '2026-10-21' && /MCIRMN\.pdf$/.test(report.url)), 'co-branded suffix');
  assert.ok(reports.some(report => report.date === '2026-09-30') && reports.some(report => report.date === '2026-09-23'), 'titles without the underscore before the year (prix_30_Sept2026)');
  assert.ok(reports.some(report => report.date === '2026-09-28'), 'Sept with the underscore');
  assert.deepEqual(discoverMadrReports([
    { title: { rendered: 'prix_02_Nov_2026_MADRP' }, mime_type: 'application/pdf', source_url: 'https://example.com/wp-content/uploads/2026/11/prix_02_Nov_2026_MADRP.pdf' },
    { title: { rendered: 'prix_02_Nov_2026_MADRP' }, mime_type: 'image/png', source_url: 'https://madr.gov.dz/wp-content/uploads/2026/11/x.png' },
    { title: { rendered: 'prix_31_Feb_2026_MADRP' }, mime_type: 'application/pdf', source_url: 'https://madr.gov.dz/wp-content/uploads/2026/02/x.pdf' },
  ]), []);
});

test('MADR collect reads the latest report and the one seven days earlier', async () => {
  const { media, pages } = fixture();
  const fetched = [];
  const result = await collect({
    now: new Date('2026-11-02T18:00:00Z'),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    get: async url => { fetched.push(url); return url.includes('/wp-json/') ? JSON.stringify(media) : url; },
    pdfPages: async url => [pages[url.includes('26_Oct') ? '2026-10-26' : '2026-11-02']],
    warn: () => {},
  });
  assert.match(fetched[0], /^https:\/\/madr\.gov\.dz\/wp-json\/wp\/v2\/media\?/);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-11-02' }, { date: '2026-10-26' }]);
  assert.equal(find(result.observations.filter(row => row.date === '2026-10-26'), 'Potatoes').price, 91);
  assert.match(result.reportUrl, /prix_02_Nov_2026_MADRP\.pdf$/);
});
