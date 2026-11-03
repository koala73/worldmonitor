import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, discoverMitReports, parseMit } from '../scripts/lib/food-prices-adapters/mit.mjs';

const page = () => JSON.parse(readFileSync(new URL('./fixtures/food-prices/mit.json', import.meta.url), 'utf8'))[0];

test('MIT keeps each market min and max as separate low/high wholesale rows', () => {
  const rows = parseMit(page(), '2026-10-28');
  const maize = rows.filter(r => r.market === 'Ilala, Dar es Salaam' && r.item.startsWith('Maize'));
  assert.deepEqual(maize.map(r => [r.item, r.price]), [['Maize (low)', 90000], ['Maize (high)', 100000]]);
  assert.equal(rows.find(r => r.market === 'Majengo, Dodoma' && r.item === 'Irish potatoes (high)').price, 70000);
  assert.equal(rows.find(r => r.market === 'Sumbawangwa, Rukwa' && r.item === 'Beans (low)').price, 200000);
  assert.ok(rows.some(r => r.market === 'Majengo, Katavi'), 'same-named markets keep their region');
  assert.ok(rows.some(r => r.market === 'Morogoro'));
  assert.equal(rows.find(r => r.market === 'Ilala, Dar es Salaam' && r.item.startsWith('Wheat grain')), undefined, 'NA cells are omitted');
  assert.ok(rows.every(r => r.price > 0 && r.currency === 'TZS' && r.unit === '100 kg' && r.marketType === 'wholesale' && r.date === '2026-10-28'));
});

test('MIT rejects a different date or a changed layout', () => {
  assert.throws(() => parseMit(page(), '2026-10-21'), /date mismatch/);
  assert.throws(() => parseMit(page().filter(item => item.text !== 'Rice (Mchele)'), '2026-10-28'), /format changed/);
  assert.throws(() => parseMit(page().filter(item => item.text !== 'Max Price' || item.x > 200), '2026-10-28'), /format changed/);
  assert.throws(() => parseMit([{ text: 'Unrelated PDF', x: 0, y: 0 }], '2026-10-28'), /format changed/);
});

test('MIT discovers report dates from the changing upload file names', () => {
  const reports = discoverMitReports([
    { url: 'https://www.viwanda.go.tz/uploads/documents/sw-1793199894-Wholesale%20Price%2021th%20October,%202026-1.pdf' },
    { url: 'https://www.viwanda.go.tz/uploads/documents/sw-1793200429-Wholesale%20Price%2028th%20October,%202026.pdf' },
    { url: 'https://www.viwanda.go.tz/uploads/documents/sw-1779436614-HOTUBA%20YA%20BAJETI.pdf' },
    { url: 'https://example.com/uploads/documents/Wholesale%20Price%2030th%20October,%202026.pdf' },
  ]);
  assert.deepEqual(reports.map(r => r.date), ['2026-10-28', '2026-10-21']);
});

test('MIT collect reads the latest report and the same weekday one week earlier', async () => {
  const fetched = [];
  const index = ['28th', '26th', '21th'].map(day => `<a href="https://www.viwanda.go.tz/uploads/documents/sw-1-Wholesale Price ${day} October, 2026.pdf">x</a>`).join('');
  const prior = page().map(item => ({ ...item, text: item.text.replace('28 OKTOBA', '21 OKTOBA') }));
  const result = await collect({
    now: new Date('2026-11-01T06:00:00Z'),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    links: html => [...html.matchAll(/href="([^"]+)"/g)].map(m => ({ url: new URL(m[1]).href, text: '' })),
    get: async url => { fetched.push(decodeURIComponent(url)); return url.endsWith('.pdf') ? url : '<html>' + index; },
    pdfPages: async url => [decodeURIComponent(url).includes('21th') ? prior : page()],
    warn: () => {},
  });
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-28' }, { date: '2026-10-21' }]);
  assert.ok(fetched.some(url => url.includes('21th')) && !fetched.some(url => url.includes('26th')));
  assert.ok(result.observations.some(r => r.date === '2026-10-21'));
});
