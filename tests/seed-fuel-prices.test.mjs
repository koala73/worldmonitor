import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCREStationPrices, validateFuel } from '../scripts/seed-fuel-prices.mjs';

test('parseCREStationPrices extracts regular + diesel per-station prices from CRE XML', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<places>
  <place place_id="1">
    <gas_price type="regular">22.95</gas_price>
    <gas_price type="premium">26.91</gas_price>
  </place>
  <place place_id="2">
    <gas_price type="regular">24.7</gas_price>
    <gas_price type="diesel">29.5</gas_price>
  </place>
</places>`;
  const { regular, diesel } = parseCREStationPrices(xml);
  assert.deepEqual(regular, [22.95, 24.7]);
  assert.deepEqual(diesel, [29.5]);
});

test('parseCREStationPrices filters out-of-range prices', () => {
  // 0.01 and 1000.0 are clearly bad (placeholder/test rows); 15 and 50 are valid MXN/L.
  const xml = `<places>
    <place><gas_price type="regular">0.01</gas_price></place>
    <place><gas_price type="regular">15</gas_price></place>
    <place><gas_price type="regular">1000.0</gas_price></place>
    <place><gas_price type="regular">50</gas_price></place>
  </places>`;
  const { regular } = parseCREStationPrices(xml);
  assert.deepEqual(regular, [15, 50]);
});

test('parseCREStationPrices handles empty XML', () => {
  const { regular, diesel } = parseCREStationPrices('<places></places>');
  assert.deepEqual(regular, []);
  assert.deepEqual(diesel, []);
});

test('validateFuel rejects when country count < 25', () => {
  const data = {
    countries: [
      { code: 'US' }, { code: 'GB' }, { code: 'MY' },
      ...Array.from({ length: 20 }, (_, i) => ({ code: `X${i}` })),
    ],
  };
  assert.equal(validateFuel(data), false, '23 countries should fail the >=25 floor');
});

test('validateFuel rejects when a critical source (US/GB/MY) is missing', () => {
  const countries = Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` }));
  countries.push({ code: 'GB' }, { code: 'MY' }); // US missing
  assert.equal(validateFuel({ countries }), false, 'missing US should fail');
});

test('validateFuel rejects when a critical source is only present as stale-carried', () => {
  const countries = [
    { code: 'US', stale: true },
    { code: 'GB' },
    { code: 'MY' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries }), false, 'stale US does not count as fresh critical anchor');
});

test('validateFuel accepts healthy snapshot (all critical fresh + 25+ countries)', () => {
  const countries = [
    { code: 'US' },
    { code: 'GB' },
    { code: 'MY' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries }), true);
});

test('validateFuel accepts snapshot with some stale-carried non-critical entries', () => {
  const countries = [
    { code: 'US' },
    { code: 'GB' },
    { code: 'MY' },
    { code: 'BR', stale: true },
    { code: 'MX', stale: true },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries }), true, 'stale BR/MX is OK as long as US/GB/MY are fresh');
});

test('validateFuel rejects null/undefined/empty', () => {
  assert.equal(validateFuel(null), false);
  assert.equal(validateFuel(undefined), false);
  assert.equal(validateFuel({}), false);
  assert.equal(validateFuel({ countries: [] }), false);
});
