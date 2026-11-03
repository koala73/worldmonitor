import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, parseTcb, parseTcbIndex } from '../scripts/lib/food-prices-adapters/tcb.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/food-prices/tcb.json', import.meta.url), 'utf8'));
const DAY = 86400000;
const dated = (now, offset) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);

test('TCB index lists dated daily retail workbooks newest first', () => {
  const reports = parseTcbIndex(fixture.index);
  assert.equal(reports.length, 10);
  assert.deepEqual(reports[0], { date: '2026-11-01', url: 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/office-tcb/2026/10/cba80358-9e31-431b-9804-180ffe85e040.xlsx' });
  assert.ok(reports.some(r => r.date === '2026-10-25' && r.url.endsWith('92ee6ef9-5873-4989-bff3-252c98b2d5ba.xlsx')));
});

test('TCB keeps Dhaka low/high retail prices with published units and omits zero quotes', () => {
  const rows = parseTcb(fixture.reports['2026-11-01']);
  const coarse = rows.filter(r => r.item.startsWith('Rice (coarse'));
  assert.deepEqual(coarse.map(r => [r.item, r.unit, r.price]), [['Rice (coarse, Swarna/China IRRI) (low)', 'kg', 50], ['Rice (coarse, Swarna/China IRRI) (high)', 'kg', 55]]);
  assert.equal(rows.find(r => r.item === 'Soybean oil (bottled) (high)' && r.unit === '5 litre').price, 1000);
  assert.equal(rows.find(r => r.item === 'Eggs (farm) (low)').unit, 'hali (4 pieces)');
  assert.equal(rows.find(r => r.item === 'Wheat flour (atta, packet) (low)').unit, 'kg packet');
  assert.equal(rows.find(r => r.item.startsWith('Onion (imported)')), undefined);
  assert.equal(rows.find(r => r.item.startsWith('Hilsa')), undefined);
  assert.equal(rows.find(r => /rod|paper/i.test(r.item)), undefined);
  assert.ok(rows.every(r => r.price > 0 && r.currency === 'BDT' && r.market === 'Dhaka' && r.marketType === 'retail' && r.date === '2026-11-01'));
  const prior = parseTcb(fixture.reports['2026-10-25']);
  assert.equal(prior.find(r => r.item === 'Green chilli (low)').price, 120);
  assert.ok(prior.every(r => r.date === '2026-10-25'));
});

test('TCB rejects a changed layout or inconsistent report date', () => {
  const sheets = structuredClone(fixture.reports['2026-11-01']);
  const header = sheets[0].findIndex(row => String(row[2]).startsWith('অদ্যকার'));
  const moved = structuredClone(sheets);
  moved[0][header + 2][2] = 'গড়';
  assert.throws(() => parseTcb(moved), /tcb workbook format changed/);
  const redated = structuredClone(sheets);
  redated[0][header + 1][2] = '2026-10-31T00:00:00.000Z';
  assert.throws(() => parseTcb(redated), /report date mismatch/);
  assert.throws(() => parseTcb([[['Unrelated sheet']]]), /tcb workbook format changed/);
  const unknown = [];
  const renamed = structuredClone(sheets);
  renamed[0][header + 3][0] = 'নতুন পণ্য';
  parseTcb(renamed, name => unknown.push(name));
  assert.deepEqual(unknown, ['নতুন পণ্য / প্রতি কেজি']);
});

test('TCB collect reads the latest report and the one exactly seven days earlier', async () => {
  const fetched = [];
  const urls = Object.fromEntries(parseTcbIndex(fixture.index).map(r => [r.url, r.date]));
  const result = await collect({
    now: new Date('2026-11-01T09:00:00Z'), dated, warn: () => {},
    get: async (url, options = {}) => { fetched.push(url); return options.binary ? urls[url] : fixture.index; },
    readWorkbook: async date => fixture.reports[date],
  });
  assert.equal(fetched.length, 3);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-11-01' }, { date: '2026-10-25' }]);
  assert.match(result.reportUrl, /cba80358/);
  assert.deepEqual([...new Set(result.observations.map(r => r.date))], ['2026-11-01', '2026-10-25']);
});

test('TCB collect falls back to the trailing-slash index when the bare index URL errors', async () => {
  const fetched = [];
  const urls = Object.fromEntries(parseTcbIndex(fixture.index).map(r => [r.url, r.date]));
  const result = await collect({
    now: new Date('2026-11-01T09:00:00Z'), dated, warn: () => {},
    get: async (url, options = {}) => {
      fetched.push(url);
      if (url === 'https://tcb.gov.bd/pages/daily-rmps') throw new Error('tcb HTTP 500');
      return options.binary ? urls[url] : fixture.index;
    },
    readWorkbook: async date => fixture.reports[date],
  });
  assert.equal(fetched[1], 'https://tcb.gov.bd/pages/daily-rmps/');
  assert.equal(result.refreshedReports.length, 2);
});
