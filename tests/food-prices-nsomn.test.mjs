import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CAPITAL_TABLE, AIMAG_TABLE, collect, parseNsoTable } from '../scripts/lib/food-prices-adapters/nsomn.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/food-prices/nsomn.json', import.meta.url), 'utf8'));
const find = (rows, item, market, date = '2026-10-26') => rows.find(row => row.item === item && row.market === market && row.date === date);

test('NSO capital table gives Ulaanbaatar weekly food prices in their published units, without fuel', () => {
  const rows = parseNsoTable(fixture()[CAPITAL_TABLE], { market: 'Ulaanbaatar' });
  assert.deepEqual(find(rows, 'Mutton', 'Ulaanbaatar'), { item: 'Mutton', market: 'Ulaanbaatar', marketType: 'retail', unit: 'kg', currency: 'MNT', date: '2026-10-26', price: 25434, origin: '' });
  assert.equal(find(rows, 'Mutton', 'Ulaanbaatar', '2026-10-19').price, 25480);
  assert.equal(find(rows, 'Tomatoes', 'Ulaanbaatar').price, 2274);
  assert.deepEqual([find(rows, 'Eggs (domestic)', 'Ulaanbaatar').price, find(rows, 'Eggs (domestic)', 'Ulaanbaatar').unit], [621, 'piece']);
  const milk = rows.filter(row => row.item === 'Milk (pasteurised)' && row.date === '2026-10-26');
  assert.deepEqual(milk.map(row => [row.unit, row.price]), [['500 g', 2468], ['litre', 5367]], 'each pack size is its own series');
  assert.equal(find(rows, 'Green tea (packaged)', 'Ulaanbaatar').unit, '90 g');
  assert.equal(find(rows, 'Apples', 'Ulaanbaatar').origin, 'China');
  assert.ok(!rows.some(row => /petrol|diesel|fuel|аи-92/i.test(row.item)), 'fuel is not food');
  assert.equal(new Set(rows.map(row => row.item + row.unit)).size, 27);
  assert.deepEqual([...new Set(rows.map(row => row.date))].sort(), ['2026-10-19', '2026-10-26']);
});

test('NSO aimag table indexes regions by code order, skips region totals, feed and fuel', () => {
  const rows = parseNsoTable(fixture()[AIMAG_TABLE], {});
  assert.equal(find(rows, 'Wheat flour (grade 1, packaged)', 'Khangai region'), undefined, 'region totals are not markets');
  assert.ok(!rows.some(row => /hay|petrol|diesel/i.test(row.item)));
  assert.equal(new Set(rows.map(row => row.market)).size, 21);
  assert.deepEqual(new Set(rows.map(row => row.item)), new Set(['Wheat flour (grade 1, packaged)', 'Milk (fresh, unpasteurised)', 'Beef', 'Mutton', 'Rice (packaged)', 'Sugar (imported, packaged)', 'Goat meat']));
  // The response lists regions in a different order from the metadata; the value index follows category.index.
  const table = fixture()[AIMAG_TABLE];
  const { index } = table.dimension['Бүс'].category;
  const productIndex = table.dimension['Бүтээгдэхүүн'].category.index;
  const code = Object.entries(table.dimension['Бүс'].category.label).find(([, label]) => label === 'Khovd')[0];
  const mutton = Object.entries(table.dimension['Бүтээгдэхүүн'].category.label).find(([, label]) => label === 'Mutton, kg')[0];
  const expected = table.value[(productIndex[mutton] * table.size[1] + index[code]) * table.size[2]];
  assert.equal(find(rows, 'Mutton', 'Khovd').price, expected);
});

test('NSO rejects a changed table shape or an unknown time label', () => {
  const table = fixture()[CAPITAL_TABLE];
  assert.throws(() => parseNsoTable({ ...table, id: ['Бүтээгдэхүүн'] }, { market: 'Ulaanbaatar' }), /format changed/);
  const badTime = structuredClone(table);
  badTime.dimension['Хугацаа'].category.label['0'] = 'week 43';
  assert.throws(() => parseNsoTable(badTime, { market: 'Ulaanbaatar' }), /format changed/);
  const renamed = structuredClone(table);
  for (const code of Object.keys(renamed.dimension['Бүтээгдэхүүн'].category.label)) renamed.dimension['Бүтээгдэхүүн'].category.label[code] = `Item ${code}`;
  assert.throws(() => parseNsoTable(renamed, { market: 'Ulaanbaatar' }), /format changed/);
  assert.throws(() => parseNsoTable({ ...table, value: table.value.slice(1) }, { market: 'Ulaanbaatar' }), /format changed/);
});

test('NSO collect posts json-stat2 queries for both tables and refreshes both weeks', async () => {
  const fixtures = fixture();
  const requests = [];
  const result = await collect({
    now: new Date('2026-11-02T08:00:00Z'),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    get: async (url, options) => { requests.push({ url, options }); return JSON.stringify(fixtures[url.split('/').at(-1)]); },
    warn: () => {},
  });
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.match(url, /^https:\/\/data\.1212\.mn\/api\/v1\/en\/NSO\//);
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.response.format, 'json-stat2');
    assert.deepEqual(body.query.find(q => q.code === 'Хугацаа').selection, { filter: 'top', values: ['2'] });
  }
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-26' }, { date: '2026-10-19' }]);
  assert.ok(find(result.observations, 'Mutton', 'Ulaanbaatar') && find(result.observations, 'Mutton', 'Khovd'));
});

test('NSO collect fails when the newest week is in the future or weeks are not seven days apart', async () => {
  const fixtures = fixture();
  const run = (now, mutate = table => table) => collect({
    now: new Date(now),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    get: async url => JSON.stringify(mutate(structuredClone(fixtures[url.split('/').at(-1)]))),
    warn: () => {},
  });
  await assert.rejects(run('2026-10-20T00:00:00Z'), /future/);
  const result = await run('2026-11-02T08:00:00Z', table => { table.dimension['Хугацаа'].category.label['1'] = '2026-10-12'; return table; });
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-26' }]);
  assert.ok(!result.observations.some(row => row.date === '2026-10-12'), 'a non-adjacent week is not a baseline');
});

test('NSO collect refuses to publish when the two tables disagree on the newest week', async () => {
  const fixtures = fixture();
  // The aimag table lags a week: its newest two weeks are 2026-10-19 and 2026-10-12.
  const lagging = structuredClone(fixtures[AIMAG_TABLE]);
  lagging.dimension['Хугацаа'].category.label = { 0: '2026-10-19', 1: '2026-10-12' };
  await assert.rejects(collect({
    now: new Date('2026-11-02T08:00:00Z'),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    get: async url => JSON.stringify(url.endsWith(AIMAG_TABLE) ? lagging : fixtures[url.split('/').at(-1)]),
    warn: () => {},
  }), /aimag table newest week 2026-10-19 does not match capital week 2026-10-26/);
});

test('NSO rejects code lists that do not match the declared cube, so labels cannot multiply rows (CWE-770)', () => {
  // A one-cell cube whose product and time lists repeat known labels 2,000 times each would emit 4,000,000 rows.
  const repeated = (prefix, text) => ({
    label: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`${prefix}${i}`, text])),
    index: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`${prefix}${i}`, 0])),
  });
  const amplified = {
    id: ['Бүтээгдэхүүн', 'Хугацаа'], size: [1, 1], value: [100],
    dimension: { 'Бүтээгдэхүүн': { category: repeated('p', 'Mutton, kg') }, 'Хугацаа': { category: repeated('t', '2026-10-26') } },
  };
  const started = Date.now();
  assert.throws(() => parseNsoTable(amplified, { market: 'Ulaanbaatar' }), /format changed/);
  assert.ok(Date.now() - started < 1000);
  // A consistent but huge cube (1,000 products x 1,000 weeks) is refused before any row is built.
  const codes = (prefix, text) => ({
    label: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`${prefix}${i}`, text(i)])),
    index: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`${prefix}${i}`, i])),
  });
  const huge = {
    id: ['Бүтээгдэхүүн', 'Хугацаа'], size: [1000, 1000], value: new Array(1_000_000).fill(1),
    dimension: { 'Бүтээгдэхүүн': { category: codes('p', () => 'Mutton, kg') }, 'Хугацаа': { category: codes('t', i => new Date(Date.UTC(2000, 0, 1 + i * 7)).toISOString().slice(0, 10)) } },
  };
  const hugeStarted = Date.now();
  assert.throws(() => parseNsoTable(huge, { market: 'Ulaanbaatar' }), /format changed/);
  assert.ok(Date.now() - hugeStarted < 1000);
  const outside = structuredClone(fixture()[CAPITAL_TABLE]);
  outside.dimension['Хугацаа'].category.index = { 0: 0, 1: 5 };
  assert.throws(() => parseNsoTable(outside, { market: 'Ulaanbaatar' }), /format changed/, 'position outside the declared size');
});
