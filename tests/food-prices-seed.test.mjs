import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFoodSource } from '../scripts/lib/food-prices-fetch.mjs';
import { mergeFoodSnapshot } from '../scripts/lib/food-prices-seed.mjs';

const context = { countryCode: 'AFG', country: 'Afghanistan', referenceDate: '2026-09-15', fetchedAt: '2026-10-28T12:00:00Z' };
test('a failed country fetch retains its last-good brief without advancing its fetch clock', () => {
  const merged = mergeFoodSnapshot({ contexts: [context] }, { contexts: [{ countryCode: 'AFG', referenceDate: '', fetchedAt: '', fetchFailed: true }], observations: [], fetchedAt: '2026-10-29T12:00:00Z' });
  assert.equal(merged.contexts[0].referenceDate, '2026-09-15');
  assert.equal(merged.contexts[0].fetchedAt, context.fetchedAt);
  assert.equal(merged.contexts[0].fetchFailed, true);
});
test('transport errors, cross-host redirects and oversized bodies fail before publishing', async () => {
  for (const response of [new Response('blocked', { status: 403 }), new Response(null, { status: 302, headers: { location: 'https://evil.example/report' } }), new Response('large', { headers: { 'content-length': '9000000' } })]) {
    await assert.rejects(collectFoodSource('da', { fetchFn: async () => response, pause: async () => {} }), /HTTP|publisher|size/);
  }
});
test('seed history retains the prior week and incoming corrections replace old values', () => {
  const row = { date: '2026-10-22', market: 'A', marketType: 'retail', item: 'Rice', unit: 'kg', currency: 'PHP', price: 50 };
  const next = { ...row, date: '2026-10-29', price: 55 };
  const result = mergeFoodSnapshot({ observations: [row] }, { observations: [next], contexts: [] });
  assert.equal(result.observations.length, 2);
  const corrected = mergeFoodSnapshot(result, { observations: [{ ...next, price: 56 }], contexts: [] });
  assert.equal(corrected.observations.length, 2);
  assert.equal(corrected.observations.at(-1).price, 56);
});

test('a report rollback cannot replace a newer successful price snapshot', () => {
  const row = { date: '2026-10-29', item: 'Rice', market: 'A', marketType: 'retail', unit: 'kg', currency: 'PHP', price: 50 };
  assert.throws(() => mergeFoodSnapshot({ observations: [row] }, { observations: [{ ...row, date: '2026-10-22' }], contexts: [] }), /regressed/);
});

test('a missing prior-week annex does not suppress current prices', async () => {
  const { readFileSync } = await import('node:fs');
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  const sheets = JSON.parse(readFileSync(new URL('./fixtures/food-prices/pbs.json', import.meta.url), 'utf8'));
  for (const [index, rows] of sheets.entries()) book.addWorksheet(`Sheet${index}`).addRows(rows.map(row => row.map(cell => cell?.result ?? cell)));
  const bytes = await book.xlsx.writeBuffer();
  const result = await collectFoodSource('pbs', {
    now: new Date('2026-10-29T12:00:00Z'), pause: async () => {},
    fetchFn: async url => {
      if (url.endsWith('/price-statistics/')) return new Response('annexureExcel: "wp-content/uploads/2026/10/Annex_22.10.2026.xlsx", annexureExcel: "wp-content/uploads/2026/10/Annex_15.10.2026.xlsx"');
      if (url.endsWith('Annex_22.10.2026.xlsx')) return new Response(bytes);
      return new Response('not found', { status: 404 });
    },
  });
  assert.ok(result.observations.length > 0);
  assert.ok(result.observations.every(row => row.date === '2026-10-22'));
});
