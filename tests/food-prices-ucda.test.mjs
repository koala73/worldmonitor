import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, discoverUcdaReport, parseUcda, ucdaReportUrl } from '../scripts/lib/food-prices-adapters/ucda.mjs';

const page = () => JSON.parse(readFileSync(new URL('./fixtures/food-prices/ucda.json', import.meta.url), 'utf8'))[0];

test('UCDA keeps farmgate ranges as low/high rows and FOT prices in USD per lb', () => {
  const rows = parseUcda(page(), '2026-10-30');
  const kiboko = rows.filter(r => r.item.startsWith('Robusta Kiboko'));
  assert.deepEqual(kiboko.map(r => [r.item, r.price, r.unit, r.currency, r.marketType]), [
    ['Robusta Kiboko (low)', 5000, 'kg', 'UGX', 'farmgate'], ['Robusta Kiboko (high)', 6000, 'kg', 'UGX', 'farmgate'],
  ]);
  assert.equal(rows.find(r => r.item === 'Robusta FAQ (high)').price, 12500);
  assert.equal(rows.find(r => r.item === 'Arabica Drugar (clean) (low)').price, 14000);
  const screen18 = rows.find(r => r.item === 'Robusta Screen 18');
  assert.deepEqual([screen18.price, screen18.unit, screen18.currency, screen18.marketType, screen18.market], [1.594, 'lb', 'USD', 'export', 'Kampala (FOT)']);
  assert.equal(rows.find(r => r.item === 'Arabica Bugisu PB').price, 2.8445);
  assert.equal(rows.length, 17);
  assert.ok(rows.every(r => r.price > 0 && r.date === '2026-10-30' && ['UGX', 'USD'].includes(r.currency)));
  assert.ok(!rows.some(r => /registered|futures/i.test(r.item)));
  const ordinal = page().map(item => (item.text === 'th' ? { ...item, text: 'nd' } : item));
  assert.equal(parseUcda(ordinal, '2026-10-30').length, 17, 'any ordinal suffix item is ignored in the date line');
});

test('UCDA rejects a different date or a changed layout', () => {
  assert.throws(() => parseUcda(page(), '2026-10-23'), /date mismatch/);
  assert.throws(() => parseUcda(page().filter(item => item.text !== 'Kiboko'), '2026-10-30'), /format changed/);
  assert.throws(() => parseUcda(page().filter(item => item.text !== 'WUGAR'), '2026-10-30'), /grades changed/);
  assert.throws(() => parseUcda([{ text: 'Unrelated PDF', x: 0, y: 0 }], '2026-10-30'), /format changed/);
});

test('UCDA discovers the homepage report and derives the prior-week file name', () => {
  const latest = discoverUcdaReport([{ url: 'https://ugandacoffee.go.ug/sites/default/files/2026-10/Daily%20Coffee%20Market%20Report%20%28October%2030th%202026%29.pdf' }]);
  assert.equal(latest.date, '2026-10-30');
  assert.equal(decodeURIComponent(ucdaReportUrl('2026-10-23')), 'https://ugandacoffee.go.ug/sites/default/files/2026-10/Daily Coffee Market Report (October 23rd 2026).pdf');
  assert.equal(decodeURIComponent(ucdaReportUrl('2026-11-02', '2026-11')).split('/').pop(), 'Daily Coffee Market Report (November 2nd 2026).pdf');
  assert.equal(discoverUcdaReport([{ url: 'https://ugandacoffee.go.ug/sites/default/files/2026-10/12%20September%202026%20Report.pdf' }]), null);
  // A malformed escape in an unrelated homepage link must not hide the report link after it.
  assert.equal(discoverUcdaReport([{ url: 'https://ugandacoffee.go.ug/files/100%ZZ.pdf' }, { url: 'https://ugandacoffee.go.ug/sites/default/files/2026-10/Daily%20Coffee%20Market%20Report%20%28October%2030th%202026%29.pdf' }]).date, '2026-10-30');
});

test('UCDA collect tolerates a missing prior-week file but not a missing latest report', async () => {
  const warnings = [];
  const ctx = {
    now: new Date('2026-11-01T06:00:00Z'),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    links: () => [{ url: 'https://ugandacoffee.go.ug/sites/default/files/2026-10/Daily%20Coffee%20Market%20Report%20%28October%2030th%202026%29.pdf' }],
    get: async url => { if (url.includes('23rd')) throw new Error('ucda HTTP 404'); return url; },
    pdfPages: async () => [page()],
    warn: message => warnings.push(message),
  };
  const result = await collect(ctx);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-30' }]);
  assert.equal(result.observations.length, 17);
  assert.match(warnings[0], /prior-week report unavailable/);
  await assert.rejects(collect({ ...ctx, links: () => [] }), /no daily report link/);
});
