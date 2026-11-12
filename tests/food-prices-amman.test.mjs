import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AMMAN_ITEMS, collect, parseAmman } from '../scripts/lib/food-prices-adapters/amman.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/food-prices/${name}`, import.meta.url), 'utf8');

test('Amman publishes the modal wholesale price, converting qirsh/kg to JOD/kg', () => {
  const rows = parseAmman(fixture('amman.html'), '2026-11-01');
  const lemon = rows.find(r => r.item === 'Lemon');
  assert.deepEqual(lemon, { item: 'Lemon', market: 'Amman Central Market', marketType: 'wholesale', unit: 'kg', currency: 'JOD', date: '2026-11-01', price: 0.5, origin: '' });
  assert.equal(rows.find(r => r.item === 'Orange (navel)').price, 0.7);
  assert.equal(rows.find(r => r.item === 'Mushroom').price, 4.5);
  assert.equal(rows.length, 21);
  assert.ok(rows.every(r => r.price > 0 && r.currency === 'JOD' && r.unit === 'kg' && r.date === '2026-11-01'));
  assert.ok(rows.every(r => !/[؀-ۿ]/.test(r.item)));
});

test('Amman drops a single row whose modal price breaks high >= mode >= low', () => {
  const skipped = [];
  const rows = parseAmman(fixture('amman-2026-10-25.html'), '2026-10-25', skipped);
  assert.equal(rows.find(r => r.item === 'Lemon'), undefined);
  assert.deepEqual(skipped, ['ليمون: high/mode/low out of order']);
  assert.equal(rows.find(r => r.item === 'Banana (local)').price, 0.6);
  assert.ok(rows.every(r => r.date === '2026-10-25'));
});

test('Amman rejects a date mismatch, swapped price columns, a changed unit and a missing title', () => {
  const html = fixture('amman.html');
  assert.throws(() => parseAmman(html, '2026-10-31'), /date mismatch/);
  const swapped = html.replaceAll('السعر الأغلب', 'TMP').replaceAll('السعر الأدنى', 'السعر الأغلب').replaceAll('TMP', 'السعر الأدنى');
  assert.throws(() => parseAmman(swapped, '2026-11-01'), /order changed/);
  assert.throws(() => parseAmman(html.replaceAll('قرش', 'دينار'), '2026-11-01'), /format changed/);
  assert.throws(() => parseAmman(html.replace('أسعار الخضار والفواكه', ''), '2026-11-01'), /format changed/);
  assert.deepEqual(parseAmman('<span> أسعار الخضار والفواكه 30-10-2026</span>', '2026-10-30'), []);
});

test('Amman card scan stays linear when headers have no card body', () => {
  // Every bare header used to rescan the rest of the page (CWE-1333).
  const hostile = `<span> أسعار الخضار والفواكه 01-11-2026</span>${'<div class="card-header bg-brown">x</div></div>'.repeat(20000)}`;
  const started = performance.now();
  assert.deepEqual(parseAmman(hostile, '2026-11-01'), []);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  const unclosed = `<span> أسعار الخضار والفواكه 01-11-2026</span>${'<div class="card-header bg-brown x'.repeat(20000)}`;
  assert.deepEqual(parseAmman(unclosed, '2026-11-01'), []);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  const html = fixture('amman.html');
  const at = html.indexOf('class="card-header bg-brown');
  assert.deepEqual(parseAmman(html.slice(0, at) + '<div class="card-header bg-brown">orphan</div>' + html.slice(at), '2026-11-01'), parseAmman(html, '2026-11-01'));
});

test('Amman item names are unique English labels', () => {
  const names = Object.values(AMMAN_ITEMS);
  assert.equal(new Set(names).size, names.length);
});

test('Amman collect posts back for the latest trading day and the same weekday a week earlier', async () => {
  const form = '<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="vs" /><input type="hidden" name="__VIEWSTATEGENERATOR" value="gen" /><input type="hidden" name="__EVENTVALIDATION" value="ev" />';
  const empty = date => `${form}<span> أسعار الخضار والفواكه ${date}</span>`;
  const latest = fixture('amman.html').replace(/01-11-2026/g, '31-10-2026');
  const calls = [];
  const ctx = {
    now: new Date('2026-11-01T05:00:00Z'),
    dated: (now, offset) => new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10),
    warn: () => {},
    get: async (url, options = {}) => {
      calls.push(options.body ? new URLSearchParams(options.body).get('ctl00$ContentPlaceHolder1$txtfromdate') : 'GET');
      if (!options.body) return empty('01-11-2026');
      const date = new URLSearchParams(options.body).get('ctl00$ContentPlaceHolder1$txtfromdate');
      assert.equal(new URLSearchParams(options.body).get('__VIEWSTATE'), 'vs');
      return date === '31-10-2026' ? `${form}${latest}` : empty(date);
    },
  };
  const result = await collect(ctx);
  assert.deepEqual(calls, ['GET', '31-10-2026', '24-10-2026']);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-31' }]);
  assert.ok(result.observations.every(r => r.date === '2026-10-31'));
});
