import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, magaItem, parseMaga } from '../scripts/lib/food-prices-adapters/maga.mjs';

const html = readFileSync(new URL('./fixtures/food-prices/maga.html', import.meta.url), 'utf8');

test('MAGA keeps La Terminal wholesale prices with the printed date and published units', () => {
  const { date, observations } = parseMaga(html);
  assert.equal(date, '2026-10-30');
  assert.deepEqual(observations.find(r => r.item === 'Beans (black, 1st grade)'), {
    item: 'Beans (black, 1st grade)', market: 'La Terminal', marketType: 'wholesale', unit: 'Quintal', currency: 'GTQ', date: '2026-10-30', price: 625, origin: '',
  });
  assert.equal(observations.find(r => r.item === 'Eggs (white, large)').unit, 'Caja (360 unidades)');
  assert.equal(observations.find(r => r.item === 'Eggs (white, large)').price, 400);
  assert.equal(observations.find(r => r.item === 'Shrimp (large, headless, farmed, 1st grade)').price, 4400);
  assert.equal(observations.length, 29);
  assert.ok(observations.every(r => r.market === 'La Terminal' && r.currency === 'GTQ' && r.price > 0 && r.date === date));
  assert.ok(observations.every(r => !/de primera|de segunda/.test(r.item)));
  assert.equal(magaItem('Producto nuevo, de primera'), 'Producto nuevo, de primera');
});

test('MAGA omits missing prices and conflicting duplicate rows instead of guessing', () => {
  const row = (name, unit, value) => `<tr><td>${name}</td><td>La Terminal</td><td>${unit}</td><td>${value}</td></tr>`;
  const page = html.replace('<tbody class="diarios">', `<tbody class="diarios">${row('Sorgo blanco, de primera', 'Quintal', '')}${row('Loroco de primera', 'Quintal', '0.00')}${row('Queso fresco', 'Libra', '25.00')}${row('Queso fresco', 'Libra', '27.00')}`);
  const { observations } = parseMaga(page);
  assert.equal(observations.length, 29);
  assert.ok(!observations.some(r => /Sorghum|Loroco|Fresh cheese/.test(r.item)));
});

test('MAGA throws when the publisher layout changes', () => {
  assert.throws(() => parseMaga(html.replace('<h5>30/10/2026</h5>', '<h5>Viernes</h5>')), /maga report date format changed/);
  assert.throws(() => parseMaga(html.replace('<th>Medida</th>', '<th>Unidad</th>')), /maga table header format changed/);
  assert.throws(() => parseMaga(html.replace('al mayorista en quetzales', 'al detallista en quetzales')), /maga daily wholesale table format changed/);
  assert.throws(() => parseMaga(html.replaceAll('La Terminal', 'Otro')), /maga has no La Terminal prices/);
  assert.throws(() => parseMaga('<html><body>maintenance</body></html>'), /format changed/);
});

test('MAGA collect reads the daily page once and refreshes only its printed date', async () => {
  const requested = [];
  const ctx = { now: new Date('2026-11-01T12:00:00Z'), dated: (now, offset) => new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10), get: async url => { requested.push(url); return html; } };
  const result = await collect(ctx);
  assert.deepEqual(requested, ['https://precios.maga.gob.gt/diarios/diarios.html']);
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-30' }]);
  assert.equal(result.observations.length, 29);
  await assert.rejects(collect({ ...ctx, now: new Date('2026-10-29T12:00:00Z') }), /future/);
});
