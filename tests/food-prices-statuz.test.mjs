import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, parseStatuz } from '../scripts/lib/food-prices-adapters/statuz.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/food-prices/statuz.json', import.meta.url), 'utf8'));

test('stat.uz keeps the latest month of national average prices with published units', () => {
  const rows = parseStatuz(fixture());
  assert.equal(rows.length, 37);
  assert.ok(rows.every(r => r.date === '2026-09-01' && r.currency === 'UZS' && r.price > 0));
  assert.ok(rows.every(r => r.market === 'National average' && r.marketType === 'retail' && r.origin === ''));
  assert.deepEqual(rows.find(r => r.item === 'Rice'), { item: 'Rice', market: 'National average', marketType: 'retail', unit: 'kg', currency: 'UZS', date: '2026-09-01', price: 16029.8, origin: '' });
  assert.equal(rows.find(r => r.item === 'Eggs').unit, '10 pieces');
  assert.equal(rows.find(r => r.item === 'Eggs').price, 13452.6);
  assert.equal(rows.find(r => r.item === 'Milk (fresh)').unit, 'litre');
  assert.equal(rows.find(r => r.item === 'Wheat flour (first grade)').price, 6607.3);
  assert.equal(new Set(rows.map(r => r.item)).size, 37);
});

test('stat.uz omits missing seasonal prices and falls back to the latest filled month', () => {
  const payload = fixture();
  for (const row of payload[0].data) delete row['2026-M09'];
  payload[0].data.find(row => row.Klassifikator_ru === 'Арбуз')['2026-M08'] = null;
  const rows = parseStatuz(payload);
  assert.ok(rows.every(r => r.date === '2026-08-01'));
  assert.equal(rows.length, 36);
  assert.equal(rows.find(r => r.item === 'Watermelon'), undefined);
});

test('stat.uz rejects a changed dataset, unit or product layout', () => {
  const swapped = fixture();
  swapped[0].metadata.find(m => m.name_en === 'Indicator identification number (code)').value_en = '1.11.03.0002';
  assert.throws(() => parseStatuz(swapped), /format changed/);
  const unit = fixture();
  unit[0].metadata.find(m => m.name_en === 'Unit of measurement').value_en = 'In thousand soums for kilogram';
  assert.throws(() => parseStatuz(unit), /format changed/);
  const qualifier = fixture();
  qualifier[0].data[0].Klassifikator_ru = 'Рис (5 кг)';
  assert.throws(() => parseStatuz(qualifier), /unit format changed/);
  assert.throws(() => parseStatuz({ data: [] }), /format changed/);
});

test('stat.uz collect returns a monthly context dated to the first of the month', async () => {
  const text = readFileSync(new URL('./fixtures/food-prices/statuz.json', import.meta.url), 'utf8');
  const result = await collect({ get: async url => { assert.match(url, /^https:\/\/api\.siat\.stat\.uz\//); return text; } });
  assert.equal(result.observations.length, 37);
  assert.deepEqual(result.contexts, [{ countryCode: 'UZ', country: 'Uzbekistan', referenceDate: '2026-09-01', title: 'Average prices of selected goods in markets and stores', url: 'https://stat.uz/ru/ofitsialnaya-statistika/prices-and-indexes' }]);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-09-01' }]);
});

test('stat.uz attribution says the prices were modified, as CC BY 4.0 requires', () => {
  for (const copy of ['../shared/food-price-sources.json', '../scripts/shared/food-price-sources.json']) {
    const uz = JSON.parse(readFileSync(new URL(copy, import.meta.url), 'utf8')).find(source => source.id === 'statuz');
    assert.match(uz.attribution, /CC BY 4\.0/, copy);
    assert.match(uz.attribution, /translated/i, copy);
    assert.match(uz.attribution, /animal feed/i, copy);
  }
});
