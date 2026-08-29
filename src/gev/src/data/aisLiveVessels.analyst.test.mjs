// src/data/aisLiveVessels.analyst.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Separate file from aisLiveVessels.test.mjs (feed-status helper) by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAnalystRecord } from './aisLiveVessels.js';

const FULL_RECORD = {
  mmsi: '353136000',
  name: 'EVER GIVEN',
  lat: 29.55,
  lon: -94.98,
  speed: 12.3,
  course: 214.0,
  type: 'Cargo',
  destination: 'OAKLAND',
};

test('ais analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_RECORD);
  assert.deepEqual(r, {
    id: 'EVER GIVEN',
    mmsi: '353136000',
    name: 'EVER GIVEN',
    lat: 29.55,
    lon: -94.98,
    speedKts: 12.3,
    courseDeg: 214.0,
    shipType: 'Cargo',
    destination: 'OAKLAND',
    navStatus: null, // /api/ais-live does not surface NavigationalStatus
  });
});

test('ais analyst record: nameless vessel falls back to mmsi id', () => {
  const r = mapAnalystRecord({ ...FULL_RECORD, name: '  ' });
  assert.equal(r.id, '353136000');
  assert.equal(r.name, null);
});

test('ais analyst record: empty strings and NaN become null, never undefined', () => {
  const r = mapAnalystRecord({ mmsi: '', name: 'TUG', speed: NaN, type: '', destination: '' });
  assert.equal(r.mmsi, null);
  assert.equal(r.speedKts, null);
  assert.equal(r.shipType, null);
  assert.equal(r.destination, null);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('ais analyst record: output is JSON-safe (no Cesium types leak from the record)', () => {
  // Real records carry Cesium positions/billboards — the mapper must not copy them.
  const r = mapAnalystRecord({ ...FULL_RECORD, position: { x: 1 }, billboard: {}, normal: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal('position' in r, false);
});
