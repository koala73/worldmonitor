import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NABC_BASKET, NABC_FARM_PRICES_URL, collect, nuxtData, parseNabcFarmPrices } from '../scripts/lib/food-prices-adapters/nabc.mjs';

// NABC closed its weekly /commodity pages (HTTP 410 since 2026-11-02). The
// fixture is an excerpt of /dashboard/farm-prices fetched on 2026-11-03: real
// values, with each daily series cut to its last 15 points and each market list
// to two rows, re-encoded in the page's Nuxt reference format.
const page = readFileSync(new URL('./fixtures/food-prices/nabc-farm-prices-2026-11-03.html', import.meta.url), 'utf8');
const detail = () => nuxtData(page, 'farm-prices-detail');
const encode = value => {
  const nodes = [['ShallowReactive', 1], { data: 2 }, ['ShallowReactive', 3], { 'farm-prices-detail': 4 }];
  const add = item => {
    const index = nodes.length;
    nodes.push(null);
    nodes[index] = Array.isArray(item) ? item.map(add)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, add(v)]))
        : item;
    return index;
  };
  add(value);
  return `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(nodes)}</script>`;
};
const withProducts = edit => encode({ ...detail(), products: edit(detail().products) });

test('NABC reads the median price major markets paid farmers on the latest day and a week earlier', () => {
  const { date, rows, missing } = parseNabcFarmPrices(page);
  assert.equal(date, '2026-11-03');
  const rice = rows.filter(r => r.item === 'Paddy rice, Hom Mali 105');
  assert.deepEqual(rice.map(r => [r.date, r.price]), [['2026-10-27', 17900], ['2026-11-03', 15350]]);
  assert.deepEqual(rice[1], {
    item: 'Paddy rice, Hom Mali 105', market: 'Major buying markets (median)', marketType: 'farmgate',
    unit: 'tonne', currency: 'THB', date: '2026-11-03', price: 15350, origin: '',
  });
  assert.equal(rows.find(r => r.item === 'Chicken eggs' && r.date === '2026-11-03').unit, '100 eggs');
  assert.equal(rows.find(r => r.item === 'Live hogs (over 100 kg)' && r.date === '2026-11-03').price, 74);
  assert.equal(rows.find(r => r.item === 'Feed maize grain (14.5% moisture)' && r.date === '2026-10-27').price, 9.5);
  assert.deepEqual(missing, ['Oil palm fresh fruit bunches (over 15 kg)']);
  assert.ok(!rows.some(r => r.item.startsWith('Oil palm')), 'a product a day behind is left out rather than dated differently');
  assert.ok(!rows.some(r => /rubber/i.test(r.item)), 'rubber is not a food price');
  assert.equal(rows.length, 12);
  assert.ok(rows.every(r => r.currency === 'THB' && r.price > 0 && ['2026-10-27', '2026-11-03'].includes(r.date)));
});

test('NABC maps every food product the dashboard publishes', () => {
  const published = detail().products.map(p => p.key).filter(key => key !== 'rubber_sheet3').sort();
  assert.deepEqual(Object.keys(NABC_BASKET).sort(), published);
});

test('NABC fails closed when the dashboard payload or a product layout changes', () => {
  assert.throws(() => parseNabcFarmPrices('<html>closed</html>'), /nabc page payload format changed/);
  assert.throws(() => parseNabcFarmPrices(withProducts(ps => ps.map(p => p.key === 'swine' ? { ...p, unit_en: 'THB/head' } : p))), /nabc swine format changed/);
  assert.throws(() => parseNabcFarmPrices(withProducts(ps => ps.map(p => p.key === 'egg' ? { ...p, series: p.series.map(s => ({ ...s, d: '03/11/2026' })) } : p))), /nabc egg format changed/);
  assert.throws(() => parseNabcFarmPrices(withProducts(ps => ps.filter(p => p.key === 'rubber_sheet3'))), /nabc has no food prices/);
  const renamed = parseNabcFarmPrices(withProducts(ps => ps.map(p => p.key === 'broiler' ? { ...p, key: 'broiler_live' } : p)));
  assert.ok(renamed.missing.includes('Live broilers'));
});

test('NABC skips a non-positive median instead of publishing it', () => {
  const { rows, missing } = parseNabcFarmPrices(withProducts(ps => ps.map(p => p.key === 'egg'
    ? { ...p, series: p.series.map(s => s.d === '2026-11-03' ? { ...s, med: 0 } : s) } : p)));
  assert.ok(!rows.some(r => r.item === 'Chicken eggs' && r.date === '2026-11-03'));
  assert.ok(missing.includes('Chicken eggs'));
});

test('NABC payload decoder resolves Nuxt references and reactive wrappers', () => {
  const html = '<script type="application/json" id="__NUXT_DATA__">[["ShallowReactive",1],{"data":2},["ShallowReactive",3],{"k":4},{"a":5,"b":6},[7,7],null,"x"]</script>';
  assert.deepEqual(nuxtData(html, 'k'), { a: ['x', 'x'], b: null });
  assert.throws(() => nuxtData(html, 'missing'), /missing/);
});

test('NABC collect fetches the dashboard once and refreshes both dates', async () => {
  const urls = [];
  const warnings = [];
  const result = await collect({
    get: async url => { urls.push(url); return page; },
    warn: message => warnings.push(message),
  });
  assert.deepEqual(urls, [NABC_FARM_PRICES_URL]);
  assert.equal(NABC_FARM_PRICES_URL, 'https://www.nabc.go.th/dashboard/farm-prices');
  assert.deepEqual(result.refreshedReports.map(r => r.date).sort(), ['2026-10-27', '2026-11-03']);
  assert.equal(result.observations.length, 12);
  assert.equal(result.reportUrl, NABC_FARM_PRICES_URL);
  assert.deepEqual(warnings, ['2026-11-03 lacks Oil palm fresh fruit bunches (over 15 kg)']);
});
