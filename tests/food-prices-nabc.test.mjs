import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NABC_BASKET, collect, nuxtData, parseNabcCommodity } from '../scripts/lib/food-prices-adapters/nabc.mjs';

const pages = JSON.parse(readFileSync(new URL('./fixtures/food-prices/nabc.json', import.meta.url), 'utf8'));
const payload = html => JSON.parse(/>(\[[\s\S]*\])<\/script>$/.exec(html)[1]);
const withPayload = (html, nodes) => html.replace(/>\[[\s\S]*\]<\/script>$/, `>${JSON.stringify(nodes)}</script>`);

test('NABC keeps OAE weekly national farm-gate averages for the latest week and the week before', () => {
  const { date, rows, missing } = parseNabcCommodity(pages['ข้าว'], 'ข้าว');
  assert.equal(date, '2026-10-26');
  assert.deepEqual(missing, []);
  const paddy = rows.filter(r => r.item === 'Paddy rice, white (15% moisture)');
  assert.deepEqual(paddy.map(r => [r.date, r.price]), [['2026-10-19', 8841.54], ['2026-10-26', 8754.63]]);
  assert.deepEqual({ ...paddy[1], price: 0 }, { item: 'Paddy rice, white (15% moisture)', market: 'National average', marketType: 'farmgate', unit: 'tonne', currency: 'THB', date: '2026-10-26', price: 0, origin: '' });
  assert.equal(rows.length, 8);
  const eggs = parseNabcCommodity(pages['ไข่ไก่'], 'ไข่ไก่').rows.find(r => r.item === 'Chicken eggs (mixed sizes)' && r.date === '2026-10-26');
  assert.equal(eggs.price, 392.86);
  assert.equal(eggs.unit, '100 eggs');
  assert.equal(parseNabcCommodity(pages['สุกร'], 'สุกร').rows.find(r => r.date === '2026-10-26').price, 68.84);
});

test('NABC parses every basket page with positive THB prices and only mapped varieties', () => {
  const rows = Object.keys(NABC_BASKET).flatMap(th => parseNabcCommodity(pages[th], th).rows);
  const items = new Set(Object.values(NABC_BASKET).flatMap(variants => Object.values(variants)));
  assert.equal(rows.length, 2 * items.size);
  assert.ok(rows.every(r => r.price > 0 && r.currency === 'THB' && items.has(r.item) && ['2026-10-19', '2026-10-26'].includes(r.date)));
  assert.equal(new Set(rows.map(r => `${r.item}|${r.date}`)).size, rows.length);
});

test('NABC fails closed when the page payload or series layout changes', () => {
  assert.throws(() => parseNabcCommodity('<html>blocked</html>', 'ข้าว'), /nabc page payload format changed/);
  assert.throws(() => parseNabcCommodity(pages['สุกร'], 'ข้าว'), /format changed/);
  const nodes = payload(pages['สุกร']);
  const unitAt = nodes.indexOf('บาท/กก.');
  assert.throws(() => parseNabcCommodity(withPayload(pages['สุกร'], nodes.map((n, i) => i === unitAt ? 'บาท/ตัว' : n)), 'สุกร'), /format changed/);
  const weekEnd = nodes.indexOf('2026-11-01');
  assert.throws(() => parseNabcCommodity(withPayload(pages['สุกร'], nodes.map((n, i) => i === weekEnd ? '2026-11-03' : n)), 'สุกร'), /week format changed/);
  const renamed = nodes.map(n => n === 'สุกรมีชีวิต น้ำหนักเกิน 100 กก.' ? 'Live hogs' : n);
  assert.throws(() => parseNabcCommodity(withPayload(pages['สุกร'], renamed), 'สุกร'), /no latest-week national prices/);
});

test('NABC payload decoder resolves Nuxt references and reactive wrappers', () => {
  const html = '<script type="application/json" id="__NUXT_DATA__">[["ShallowReactive",1],{"data":2},["ShallowReactive",3],{"k":4},{"a":5,"b":6},[7,7],null,"x"]</script>';
  assert.deepEqual(nuxtData(html, 'k'), { a: ['x', 'x'], b: null });
  assert.throws(() => nuxtData(html, 'missing'), /missing/);
});

test('NABC collect fetches one page per basket commodity and refreshes both weeks', async () => {
  const urls = [];
  const warnings = [];
  const result = await collect({
    get: async url => {
      urls.push(url);
      return pages[decodeURIComponent(new URL(url).pathname.split('/').pop())];
    },
    warn: message => warnings.push(message),
  });
  assert.equal(urls.length, Object.keys(NABC_BASKET).length);
  assert.deepEqual(urls.map(url => decodeURIComponent(url.slice('https://www.nabc.go.th/commodity/'.length))), Object.keys(NABC_BASKET));
  assert.deepEqual(result.refreshedReports.map(r => r.date).sort(), ['2026-10-19', '2026-10-26']);
  assert.equal(result.observations.length, 26);
  assert.deepEqual(warnings, []);
});
