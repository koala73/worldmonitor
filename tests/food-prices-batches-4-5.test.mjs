import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseFews, FEWS_COUNTRIES } from '../scripts/lib/food-prices-adapters/fews.mjs';
import { parseTaiwan } from '../scripts/lib/food-prices-adapters/twmoa.mjs';
import { parseGeostat } from '../scripts/lib/food-prices-adapters/geostat.mjs';
import { parseCso } from '../scripts/lib/food-prices-adapters/cso.mjs';
import { parseStatec, collect as collectStatec } from '../scripts/lib/food-prices-adapters/statec.mjs';
import { parseLatvia } from '../scripts/lib/food-prices-adapters/csblv.mjs';
import { parseMakstat } from '../scripts/lib/food-prices-adapters/makstat.mjs';
import { parseFoag, FOAG_CUBES, observationQuery } from '../scripts/lib/food-prices-adapters/foag.mjs';
import { aggregatePrices, readPricecatcher, collect as collectPricecatcher } from '../scripts/lib/food-prices-adapters/pricecatcher.mjs';
import { parseMercado, readMercadoArchive, collect as collectMercado } from '../scripts/lib/food-prices-adapters/mcba.mjs';
import { cubeCells, csvRows } from '../scripts/lib/food-prices-adapters/monthly.mjs';
import { collectFoodSource } from '../scripts/lib/food-prices-fetch.mjs';
import { mergeFoodSnapshot } from '../scripts/lib/food-prices-seed.mjs';
import { FOOD_PRICE_ADAPTERS } from '../scripts/lib/food-prices-adapters/index.mjs';

const file = name => readFileSync(new URL(`./fixtures/food-prices/${name}`, import.meta.url));
const json = name => JSON.parse(file(`${name}.json`));
const now = new Date('2026-11-05T02:00:00Z');

for (const [id, country] of Object.entries(FEWS_COUNTRIES)) test(`${id}: public food only, normalised local-currency units and collecting organisation`, () => {
  const payload = json(`fews-${country.toLowerCase()}`);
  const rows = parseFews(payload, country);
  assert.ok(rows.length);
  for (const row of rows) {
    assert.ok(['kg', 'litre'].includes(row.unit));
    assert.ok(payload.some(raw => raw.product === row.item && raw.period_date === row.date && raw.common_unit_price === row.price && raw.currency === row.currency));
    assert.match(row.market, /\(.+\)$/);
  }
  const original = payload[0];
  assert.throws(() => parseFews([{ ...original, product: 'Diesel' }], country), /no public/);
  assert.throws(() => parseFews([{ ...original, data_usage_policy: 'Private' }], country), /no public/);
  assert.throws(() => parseFews(payload, 'XX'), /no public/);
});

test('Taiwan uses the ROC date and weighted transaction average, with separate crop and market codes', () => {
  const payload = json('twmoa');
  const rows = parseTaiwan(payload);
  const raw = payload.find(row => /^(?:甘藍|番茄|香蕉)/.test(row['作物名稱'] ?? ''));
  assert.equal(rows[0].date, '2026-11-05');
  assert.equal(rows[0].price, raw['平均價']);
  assert.equal(rows[0].currency, 'TWD');
  assert.match(rows[0].item, new RegExp(raw['作物代號']));
  assert.equal(parseTaiwan([{ ...raw, '交易日期': '115.02.30' }]).length, 0);
  assert.equal(parseTaiwan([{ ...raw, '交易量': 0 }]).length, 0);
});

test('Georgia and North Macedonia publish dated CPI summaries rather than currency prices', () => {
  const georgia = parseGeostat(json('geostat'));
  assert.equal(georgia.referenceDate, '2026-10-01');
  assert.match(georgia.title, /0\.0% month-on-month/);
  assert.doesNotMatch(georgia.title, /-0\.0/);
  const macedonia = parseMakstat(json('makstat'));
  assert.equal(macedonia.referenceDate, '2026-09-01');
  assert.match(macedonia.title, /year-on-year \(indices, not prices\)/);
  assert.throws(() => parseGeostat([[['different table']]]), /format changed/);
  const bad = json('makstat'); bad.value = bad.value.slice(1);
  assert.throws(() => parseMakstat(bad), /size changed/);
});

test('Ireland retains food pack sizes and excludes fuel, tobacco, alcohol and service rows', () => {
  const rows = parseCso(file('cso.csv').toString());
  assert.equal(rows.length, 44);
  assert.deepEqual(rows.find(row => row.item === 'Large eggs per half dozen'), {
    item: 'Large eggs per half dozen', market: 'National average', marketType: 'retail', unit: 'half dozen', currency: 'EUR', date: '2026-09-01', price: 2.471, origin: '',
  });
  assert.ok(!rows.some(row => /diesel|petrol|cigarettes|whiskey|cinema/i.test(row.item)));
  assert.throws(() => parseCso('other,value\nrice,2'), /format changed/);
});

test('Luxembourg is a June annual food benchmark with published pack sizes', () => {
  const rows = parseStatec(json('statec'));
  assert.equal(rows.length, 13);
  assert.ok(rows.every(row => row.date === '2026-06-01' && row.currency === 'EUR'));
  assert.equal(rows.find(row => /Potatoes/.test(row.item)).unit, '5 kg');
  assert.ok(!rows.some(row => /diesel|fuel|ticket|newspaper|medical/i.test(row.item)));
  const bad = json('statec'); bad.structure.name = 'Different survey';
  assert.throws(() => parseStatec(bad), /format changed/);
});

test('Luxembourg sends an explicit language instead of the Node fetch wildcard that causes languageTag1', async () => {
  const result = await collectStatec({ now, get: async (_url, options) => {
    assert.equal(options.headers['Accept-Language'], 'en');
    assert.equal(options.headers.Accept, 'application/json');
    return JSON.stringify(json('statec'));
  } });
  assert.equal(result.observations.length, 13);
});

test('Latvia reads category.index in response dimension order and preserves units', () => {
  const rows = parseLatvia(json('csblv'));
  assert.ok(rows.length > 100);
  assert.equal(rows.find(row => row.item === 'Rice' && row.date === '2026-09-01').price, 2.54);
  assert.equal(rows.find(row => row.item === 'Eggs').unit, '10 pcs');
  const bad = json('csblv'); bad.dimension.GOODS_SERVICES.category.index = { a: 0, b: 0 };
  assert.throws(() => parseLatvia(bad), /index changed/);
  assert.throws(() => cubeCells({ id: ['a'], size: [100_000], value: [] }, ['a']), /size changed/);
});

test('all Swiss cubes preserve series dimensions and convert centimes to CHF', () => {
  const fixture = json('foag');
  const labels = new Map();
  for (const row of fixture.labels) if (!labels.has(row.uri.value) || row.label['xml:lang'] === 'en') labels.set(row.uri.value, row.label.value);
  for (const cube of Object.values(FOAG_CUBES)) {
    const rows = parseFoag(fixture.observations[cube], labels);
    assert.ok(rows.length);
    assert.ok(rows.every(row => row.currency === 'CHF' && row.date === '2026-09-01'));
    assert.match(rows[0].item, /incl\. VAT/);
  }
  assert.equal(parseFoag(fixture.observations.Eggs, labels)[0].price, 1.0197);
  assert.throws(() => parseFoag(fixture.observations.Eggs, new Map()), /label missing/);
  const bad = structuredClone(fixture.observations.Eggs); bad[0].v3.value = 'https://agriculture.ld.admin.ch/foag/currency/USD';
  assert.throws(() => parseFoag(bad, labels), /currency changed/);
  assert.match(observationQuery('Eggs', '2026-09'), /LIMIT 5001/);
  assert.throws(() => observationQuery('other', '2026-09'), /unknown/);
});

test('Malaysia decodes the publisher Brotli parquet and computes per-item medians across unique premises', async () => {
  const rows = await readPricecatcher(file('pricecatcher.parquet'));
  const lookup = new Map(csvRows(file('pricecatcher-items.csv').toString(), ['item_code', 'unit']).map(row => [row.item_code, row]));
  const prices = aggregatePrices(rows, lookup, { before: '2026-11-05', since: '2026-11-01' });
  assert.equal(prices.find(row => row.date === '2026-11-04' && row.item === 'Eggs (grade A)').unit, '30 pieces');
  assert.equal(prices.find(row => row.date === '2026-11-04' && row.item === 'Tomatoes').price, 5.5);
  assert.ok(aggregatePrices(rows, lookup, { before: '2026-11-04', since: '2026-11-01' }).every(row => row.date < '2026-11-04'));
  assert.equal(aggregatePrices(rows.slice(0, 1), lookup, { before: '2026-11-05', since: '2026-11-01' }).length, 0);
  const wrong = new Map(lookup); wrong.set('1', { unit: 'piece' });
  assert.throws(() => aggregatePrices(rows, wrong, { before: '2026-11-05', since: '2026-11-01' }), /unit or product changed/);
});

test('Malaysia chooses current and previous archives by local month and tolerates an unpublished current file', async () => {
  const calls = [];
  await assert.rejects(collectPricecatcher({ now: new Date('2026-10-31T20:00:00Z'),
    dated: (date, offset) => new Date(+date + offset * 86400000).toISOString().slice(0, 10), warn: () => {},
    get: async url => {
      calls.push(url);
      if (url.endsWith('.csv')) return file('pricecatcher-items.csv').toString();
      if (url.endsWith('2026-11.parquet')) throw new Error('pricecatcher HTTP 404');
      return file('pricecatcher.parquet');
    },
  }), /no prices/); // The November fixture has no completed October day; publishing must fail.
  assert.ok(calls.some(url => url.endsWith('2026-10.parquet')));
  assert.ok(!calls.some(url => url.endsWith('2026-09.parquet')));
});

test('Argentina decodes real legacy XLS, uses modal per-kg prices and omits conflicting duplicates and unweighed rows', () => {
  for (const name of ['mcba-vegetables', 'mcba-fruit']) {
    const reports = readMercadoArchive(file(`${name}.zip`));
    assert.ok(reports.some(rows => rows[0].date === '2026-07-01'), 'archive filename is not the report date');
    assert.ok(reports.some(rows => rows[0].date === '2026-11-04'));
    assert.ok(reports.flat().every(row => row.unit === 'kg' && row.currency === 'ARS'));
  }
  const header = ['ESP', 'VAR', 'PROC', 'ENV', 'KG', 'CAL', 'TAM', 'GRADO', 'MA041126', 'MO041126', 'MI041126', 'MAPK', 'MOPK', 'MIPK'];
  const row = ['PAPA', 'NEGRA', 'BS. AS.', 'BO', 20, '1A', '', '', 200, 180, 160, 10, 9, 8];
  const other = [...row]; other[0] = 'TOMATE';
  const conflict = [...row]; conflict[12] = 9.5;
  assert.deepEqual(parseMercado([header, row, conflict, other]).map(row => row.item), ['TOMATE · NEGRA · BO 20 kg · 1A']);
  assert.equal(parseMercado([header, row])[0].price, 9);
});

test('Argentina falls back to the previous archive when current-month archives are unpublished', async () => {
  for (const currentLinked of [false, true]) {
    const calls = [];
    const result = await collectMercado({ now: new Date('2026-12-02T12:00:00Z'), warn: () => {},
      dated: (date, offset) => new Date(+date + offset * 86400000).toISOString().slice(0, 10),
      links: () => [{ url: 'https://mercadocentral.gob.ar/unrelated%zz' }, ...['NOVIEMBRE', ...(currentLinked ? ['DICIEMBRE'] : [])].flatMap(month => ['FRUT', 'HORTALIZ'].map(kind => ({ url: `https://mercadocentral.gob.ar/${kind}_${month}_2026.ZIP` })))],
      get: async url => {
        calls.push(url);
        if (!url.endsWith('.ZIP')) return '';
        if (url.includes('DICIEMBRE')) throw new Error('mcba HTTP 404');
        return file(url.includes('HORTALIZ') ? 'mcba-vegetables.zip' : 'mcba-fruit.zip');
      },
    });
    assert.ok(result.observations.length);
    assert.ok(result.observations.every(row => row.date === '2026-11-04'));
    assert.ok(calls.some(url => url.includes('NOVIEMBRE')));
  }
});

test('a regressed country brief retains its last-good context while other countries advance', () => {
  const old = { countryCode: 'AFG', referenceDate: '2026-10-01', title: 'Last good' };
  const fresh = { countryCode: 'SDN', referenceDate: '2026-11-01', title: 'New brief' };
  const result = mergeFoodSnapshot({ contexts: [old] }, { observations: [], contexts: [{ ...old, referenceDate: '2026-09-01', title: 'Older' }, fresh] });
  assert.deepEqual(result.contexts, [{ ...old, fetchFailed: true }, fresh]);
});

test('CPI-only sources traverse the real collector; empty, changed and future reports fail closed', async () => {
  const payload = json('makstat');
  const collect = data => collectFoodSource('makstat', { now, pause: async () => {}, fetchFn: async (_url, options) => {
    if (options.method === 'POST') assert.deepEqual(JSON.parse(options.body).query[0].selection, { filter: 'item', values: ['2026M09'] });
    return new Response(JSON.stringify(options.method === 'POST' ? data : { variables: [{ code: 'Година', values: ['2015M01', '2026M09'] }] }));
  } });
  const result = await collect(payload);
  assert.equal(result.observations.length, 0);
  assert.equal(result.contexts[0].countryCode, 'MK');
  const future = json('makstat');
  const renamed = future.dimension['Година'].category;
  renamed.index = { '2099M01': 0, '2099M02': 1 };
  renamed.label = { '2099M01': '2099M01', '2099M02': '2099M02' };
  await assert.rejects(collect(future), /future/);
  await assert.rejects(collect({}), /dimensions changed/);
  const context = { countryCode: 'MK', referenceDate: '2026-10-01' };
  assert.throws(() => mergeFoodSnapshot({ contexts: [context] }, { observations: [], contexts: [{ ...context, referenceDate: '2026-09-01' }] }), /regressed/);
});

test('all new sources have identical browser/worker registration and real collectors', () => {
  const sources = JSON.parse(readFileSync(new URL('../shared/food-price-sources.json', import.meta.url)));
  assert.deepEqual(JSON.parse(readFileSync(new URL('../scripts/shared/food-price-sources.json', import.meta.url))), sources);
  const ids = [...Object.keys(FEWS_COUNTRIES), 'twmoa', 'geostat', 'pricecatcher', 'mcba', 'cso', 'statec', ...Object.keys(FOAG_CUBES), 'csblv', 'makstat'];
  assert.equal(ids.length, 15);
  for (const id of ids) {
    const source = sources.find(source => source.id === id);
    assert.ok(source && typeof FOOD_PRICE_ADAPTERS[id].collect === 'function', id);
    assert.equal(source.contextOnly, !['twmoa', 'pricecatcher', 'mcba'].includes(id));
    assert.match(readFileSync(new URL(`../scripts/seed-food-prices-${id}.mjs`, import.meta.url), 'utf8'), new RegExp(`runFoodPriceSource\\('${id}'`));
  }
});
