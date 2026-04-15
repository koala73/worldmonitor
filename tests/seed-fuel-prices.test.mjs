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

const HEALTHY_COUNTRIES = [
  { code: 'US' }, { code: 'GB' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
  ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
];

test('validateFuel accepts healthy snapshot (all sources fresh, 33 countries, US+GB+MY present)', () => {
  assert.equal(validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: [] }), true);
});

test('validateFuel rejects when an untolerated source failed (no silent degraded publishes)', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Mexico'] }),
    false,
    'a non-tolerated source failure must block publish; cache TTL serves last healthy snapshot',
  );
});

test('validateFuel accepts when only a TOLERATED source (Brazil) failed', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Brazil'] }),
    true,
    'Brazil ANP is structurally unreachable from Railway; must not gate publish or Railway crash-loops',
  );
});

test('validateFuel rejects when country count < 30', () => {
  const countries = [
    { code: 'US' }, { code: 'GB' }, { code: 'MY' },
    ...Array.from({ length: 25 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, '28 countries should fail >=30');
});

test('validateFuel rejects when critical source US is missing', () => {
  const countries = [
    { code: 'GB' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing US fails gate');
});

test('validateFuel rejects when critical source GB is missing', () => {
  const countries = [
    { code: 'US' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing GB fails gate');
});

test('validateFuel rejects when critical source MY is missing', () => {
  const countries = [
    { code: 'US' }, { code: 'GB' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing MY fails gate');
});

test('validateFuel rejects null/undefined/empty', () => {
  assert.equal(validateFuel(null), false);
  assert.equal(validateFuel(undefined), false);
  assert.equal(validateFuel({}), false);
  assert.equal(validateFuel({ countries: [] }), false);
});
