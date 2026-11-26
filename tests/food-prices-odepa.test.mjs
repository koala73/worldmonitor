import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BASKET, DATASET_ID, collect, parseOdepaWeek } from '../scripts/lib/food-prices-adapters/odepa.mjs';
import { collectFoodSource } from '../scripts/lib/food-prices-fetch.mjs';
import { mergeFoodSnapshot } from '../scripts/lib/food-prices-seed.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/food-prices/odepa.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-23T08:00:00Z');
const dated = (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10);
const week = date => fixture().weeks[date].result.records;
const find = (rows, item, market, date = '2026-11-16') => rows.find(row => row.item === item && row.market === market && row.date === date);
const [RESOURCE_2026, RESOURCE_2025] = fixture().package.result.resources.map(resource => resource.id);

/**
 * A fake CKAN datastore. `years` maps a resource name year to { id, weeks: { monday: rows } }; the server answers
 * package_show, the newest-week probe and Fecha inicio + Producto filtered week reads the way datos.odepa.gob.cl does.
 */
function datastore(years, { requests = [], page = rows => rows } = {}) {
  return async url => {
    const target = new URL(url);
    requests.push(target);
    if (target.pathname.endsWith('/package_show')) {
      assert.equal(target.searchParams.get('id'), DATASET_ID);
      return JSON.stringify({ success: true, result: { resources: Object.entries(years).map(([year, { id }]) => ({ id, name: `Detalle de Precios Consumidor año ${year}`, datastore_active: true })) } });
    }
    assert.ok(target.pathname.endsWith('/datastore_search'));
    const resource = Object.values(years).find(year => year.id === target.searchParams.get('resource_id'));
    const all = Object.values(resource.weeks).flat();
    if (target.searchParams.get('sort') === 'Fecha inicio desc') {
      const newest = all.map(row => row['Fecha inicio']).sort().at(-1);
      return JSON.stringify({ success: true, result: { total: all.length, records: newest ? [{ 'Fecha inicio': newest }] : [] } });
    }
    const filters = JSON.parse(target.searchParams.get('filters'));
    const rows = all.filter(row => row['Fecha inicio'] === filters['Fecha inicio'] && filters.Producto.includes(row.Producto));
    return JSON.stringify({ success: true, result: { total: rows.length, records: page(rows) } });
  };
}
const live = () => ({ 2026: { id: RESOURCE_2026, weeks: { '2026-11-16': week('2026-11-16'), '2026-11-09': week('2026-11-09') } }, 2025: { id: RESOURCE_2025, weeks: {} } });
const run = (get, now = NOW, warnings = []) => collect({ now, dated, get, warn: message => warnings.push(message) });
const moved = (rows, date) => rows.map(row => ({ ...row, 'Fecha inicio': date }));

test('ODEPA weekly rows become Monday-dated CLP prices per region, sector and outlet type', () => {
  const rows = parseOdepaWeek(week('2026-11-16'), '2026-11-16');
  // Published mean "13262,333333" uses a comma decimal; the butcher and supermarket prices are separate series.
  assert.deepEqual(find(rows, 'Beef (posta negra) · butcher', 'Metropolitana · Oriente'), {
    item: 'Beef (posta negra) · butcher', market: 'Metropolitana · Oriente', marketType: 'retail', unit: 'kg', currency: 'CLP', date: '2026-11-16', price: expectedMean('Posta Negra', 'Oriente', 'Carnicería'), origin: '',
  });
  assert.ok(find(rows, 'Beef (posta negra) · supermarket', 'Metropolitana · Oriente'));
  assert.ok(find(rows, 'Marraqueta bread · bakery', 'Ñuble · Punilla'), 'Región de Ñuble is shortened to its name');
  assert.ok(rows.some(row => row.market === 'Metropolitana · Internet' && row.item.endsWith(' · online supermarket')));
  assert.equal(find(rows, 'Whole milk · supermarket', 'Metropolitana · Oriente').unit, '1 litre carton');
  assert.equal(find(rows, 'Lettuce (escarole, first grade) · street market', 'Metropolitana · Oriente').unit, 'piece');
  const eggs = rows.filter(row => row.item === 'Eggs (white, large) · street market' && row.market === 'Metropolitana · Oriente').map(row => row.unit).sort();
  assert.deepEqual(eggs, ['tray of 12', 'tray of 30'], 'each tray size is its own series');
  assert.ok(rows.every(row => row.date === '2026-11-16' && row.currency === 'CLP' && row.price > 0));
  assert.ok(rows.some(row => row.item.startsWith('Onions (')), 'onions are kept under their season label');
  const keys = rows.map(row => JSON.stringify([row.market, row.marketType, row.item, row.unit]));
  assert.equal(new Set(keys).size, keys.length);
});

function expectedMean(product, sector, outlet) {
  const row = week('2026-11-16').find(row => row.Producto === product && row.Sector === sector && row['Tipo de punto monitoreo'] === outlet);
  return Math.round(Number(row['Precio promedio'].replace(',', '.')));
}

test('ODEPA keeps the article in region names and rounds means to whole pesos', () => {
  const base = week('2026-11-16').find(row => row.Producto === 'Marraqueta');
  const at = Region => parseOdepaWeek([{ ...base, Region, 'Precio minimo': '1000', 'Precio maximo': '2000', 'Precio promedio': '1727,272727' }], '2026-11-16')[0];
  assert.equal(at('Región de Los Lagos').market, `Los Lagos · ${base.Sector}`);
  assert.equal(at('Región de La Araucanía').market, `La Araucanía · ${base.Sector}`);
  assert.equal(at('Región del Maule').market, `Maule · ${base.Sector}`);
  assert.equal(at('Región de Arica y Parinacota').market, `Arica y Parinacota · ${base.Sector}`);
  assert.equal(at('Región Metropolitana de Santiago').price, 1727);
});

test('ODEPA skips products and units outside the basket and wholesale markets keep their market type', () => {
  const base = week('2026-11-16')[0];
  const rows = parseOdepaWeek([
    { ...base, Producto: 'Queso Gauda', Unidad: '$/envase 1 kilo' },
    { ...base, Producto: 'Marraqueta', Unidad: '$/caja 180 unidades' },
    { ...base, Producto: 'Tomate|Larga vida|Primera', Unidad: '$/kilo', Sector: 'Mercado Lo Valledor', 'Tipo de punto monitoreo': 'Mercado Mayorista', 'Precio minimo': '900', 'Precio maximo': '1100', 'Precio promedio': '1000' },
  ], '2026-11-16');
  assert.deepEqual(rows.map(row => [row.item, row.market, row.marketType]), [['Tomatoes (long-life, first grade) · wholesale market', 'Metropolitana · Mercado Lo Valledor', 'wholesale']]);
});

test('ODEPA rejects moved columns, unknown outlets, bad prices, duplicate series and a mismatched week', () => {
  const rows = week('2026-11-16');
  const base = rows.find(row => row.Producto === 'Marraqueta');
  const reject = (row, pattern) => assert.throws(() => parseOdepaWeek([row], '2026-11-16'), pattern);
  reject({ ...base, 'Precio promedio': '99999' }, /outside its range/);
  reject({ ...base, 'Precio minimo': '99999' }, /outside its range/);
  reject({ ...base, 'Precio promedio': '2.067,00' }, /price format changed/);
  reject({ ...base, 'Precio promedio': '' }, /price format changed/);
  reject({ ...base, 'Tipo de punto monitoreo': 'Minimarket' }, /outlet type Minimarket format changed/);
  reject({ ...base, 'Fecha inicio': '2026-11-09' }, /week date mismatch/);
  const { Region: _dropped, ...noRegion } = base;
  reject(noRegion, /columns format changed/);
  assert.throws(() => parseOdepaWeek([base, base], '2026-11-16'), /duplicate series/);
  assert.deepEqual(parseOdepaWeek([], '2026-11-16'), []);
});

test('ODEPA collect reads the newest week and the week before by Monday date, filtered to the basket', async () => {
  const requests = [];
  const warnings = [];
  const result = await run(datastore(live(), { requests }), NOW, warnings);
  assert.deepEqual(warnings, []);
  assert.ok(requests.every(url => url.origin === 'https://datos.odepa.gob.cl' && url.pathname.startsWith('/api/3/action/')));
  const reads = requests.filter(url => url.searchParams.has('filters')).map(url => JSON.parse(url.searchParams.get('filters')));
  assert.deepEqual(reads.map(filter => filter['Fecha inicio']), ['2026-11-16', '2026-11-09']);
  assert.ok(reads.every(filter => Object.keys(BASKET).every(product => filter.Producto.includes(product))));
  assert.deepEqual(result.refreshedReports, [{ date: '2026-11-16' }, { date: '2026-11-09' }]);
  const latest = find(result.observations, 'Marraqueta bread · supermarket', 'Metropolitana · Oriente');
  const prior = find(result.observations, 'Marraqueta bread · supermarket', 'Metropolitana · Oriente', '2026-11-09');
  assert.ok(latest && prior && latest.price > 0 && prior.price > 0);
  assert.deepEqual(result.contexts, []);
});

test('ODEPA collect takes the prior week from the previous year, and an empty new year from the old one', async () => {
  // First week of 2027: its Monday is 2027-01-04 and the prior Monday 2026-12-28 lives in the 2026 resource.
  const rollover = {
    2027: { id: '11111111-2222-3333-4444-555555555555', weeks: { '2027-01-04': moved(week('2026-11-16'), '2027-01-04') } },
    2026: { id: RESOURCE_2026, weeks: { '2026-12-28': moved(week('2026-11-09'), '2026-12-28') } },
    2025: { id: RESOURCE_2025, weeks: {} },
  };
  const requests = [];
  const result = await run(datastore(rollover, { requests }), new Date('2027-01-11T08:00:00Z'));
  assert.deepEqual(result.refreshedReports, [{ date: '2027-01-04' }, { date: '2026-12-28' }]);
  assert.equal(requests.filter(url => url.searchParams.get('resource_id') === RESOURCE_2025).length, 0, 'only the newest two years are read');
  // The 2027 resource exists but has no rows yet: the newest week is the last 2026 week.
  const early = { 2027: { id: '11111111-2222-3333-4444-555555555555', weeks: {} }, ...live() };
  const fallback = await run(datastore(early));
  assert.deepEqual(fallback.refreshedReports, [{ date: '2026-11-16' }, { date: '2026-11-09' }]);
});

test('ODEPA collect warns when the prior week is missing and fails closed on partial, future, non-Monday or relabelled data', async () => {
  const warnings = [];
  const gap = await run(datastore({ 2026: { id: RESOURCE_2026, weeks: { '2026-11-16': week('2026-11-16') } }, 2025: { id: RESOURCE_2025, weeks: {} } }), NOW, warnings);
  assert.deepEqual(gap.refreshedReports, [{ date: '2026-11-16' }]);
  assert.deepEqual(warnings, ['no week dated 2026-11-09']);
  await assert.rejects(run(datastore(live(), { page: rows => rows.slice(1) })), /returned \d+ of \d+ rows/);
  await assert.rejects(run(datastore(live()), new Date('2026-11-13T08:00:00Z')), /in the future/);
  await assert.rejects(run(datastore({ 2026: { id: RESOURCE_2026, weeks: { '2026-11-17': moved(week('2026-11-16'), '2026-11-17') } } })), /not a Monday/);
  // A publisher relabel makes the server-side product filter return almost nothing.
  const relabelled = week('2026-11-16').map(row => (row.Producto === 'Marraqueta' || row.Producto.startsWith('Cebolla') ? row : { ...row, Producto: `${row.Producto} (nuevo)` }));
  await assert.rejects(run(datastore({ 2026: { id: RESOURCE_2026, weeks: { '2026-11-16': relabelled } } })), /basket labels format changed/);
  await assert.rejects(run(async () => JSON.stringify({ success: false })), /dataset format changed/);
});

test('ODEPA collect names staples missing from the newest week and flags a week with fewer markets', async () => {
  // Three of nineteen staples gone stays above the 80% gate; four does not.
  const without = labels => week('2026-11-16').filter(row => !labels.includes(row.Producto));
  const three = ['Azúcar', 'Lentejas 6 mm', 'Posta Negra'];
  const warnings = [];
  const thin = await run(datastore({ 2026: { id: RESOURCE_2026, weeks: { '2026-11-16': without(three), '2026-11-09': week('2026-11-09') } } }), NOW, warnings);
  assert.ok(thin.observations.length > 0);
  assert.deepEqual(warnings, ['odepa week 2026-11-16 has no prices for Sugar, Lentils (6 mm), Beef (posta negra)']);
  await assert.rejects(run(datastore({ 2026: { id: RESOURCE_2026, weeks: { '2026-11-16': without([...three, 'Spaghetti N°5']) } } })), /basket labels format changed \(15 of 19\)/);
  // A newest week still being loaded upstream: one sector of three is in.
  const partial = [];
  await run(datastore({ 2026: { id: RESOURCE_2026, weeks: { '2026-11-16': week('2026-11-16').filter(row => row.Sector === 'Oriente'), '2026-11-09': week('2026-11-09') } } }), NOW, partial);
  assert.deepEqual(partial, ['odepa week 2026-11-16 covers 1 markets, 2026-11-09 covered 3']);
});

test('ODEPA collect ignores inactive, malformed and pre-2008 year resources', async () => {
  const resources = [
    { id: RESOURCE_2026, name: 'Detalle de Precios Consumidor año 2026', datastore_active: true },
    { id: '99999999-9999-9999-9999-999999999999', name: 'Detalle de Precios Consumidor año 2027', datastore_active: false },
    { id: 'not-a-uuid', name: 'Detalle de Precios Consumidor año 2028', datastore_active: true },
    { id: '88888888-8888-8888-8888-888888888888', name: 'Detalle de Precios Consumidor año 1999', datastore_active: true },
    { id: '77777777-7777-7777-7777-777777777777', name: 'Diccionario de datos', datastore_active: true },
  ];
  const store = datastore(live());
  const requests = [];
  const result = await run(async url => {
    requests.push(new URL(url));
    return url.includes('package_show') ? JSON.stringify({ success: true, result: { resources } }) : store(url);
  });
  assert.deepEqual(result.refreshedReports, [{ date: '2026-11-16' }, { date: '2026-11-09' }]);
  assert.deepEqual([...new Set(requests.map(url => url.searchParams.get('resource_id')).filter(Boolean))], [RESOURCE_2026]);
  await assert.rejects(run(async url => (url.includes('package_show') ? JSON.stringify({ success: true, result: { resources: [] } }) : '{}')), /yearly resources missing/);
});

test('ODEPA runs through the registered collector and merges into a two-week history', async () => {
  const get = datastore(live());
  const result = await collectFoodSource('odepa', { now: NOW, pause: async () => {}, fetchFn: async url => new Response(await get(url)) });
  assert.ok(result.observations.length > 100);
  const merged = mergeFoodSnapshot(undefined, result);
  assert.deepEqual([...new Set(merged.observations.map(row => row.date))].sort(), ['2026-11-09', '2026-11-16']);
  await assert.rejects(collectFoodSource('odepa', { now: NOW, pause: async () => {}, fetchFn: async () => new Response(null, { status: 302, headers: { location: 'https://datos.gob.cl/api/3/action/package_show' } }) }), /left its publisher/);
});
