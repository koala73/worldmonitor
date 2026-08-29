// src/data/firmsHeatmap.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Pure function — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAnalystRecord } from './firmsHeatmap.js';

const FULL_FIRE = {
  index: 7,
  lat: 30.51,
  lon: -98.21,
  frp: 1520.4,
  confidence: 0.9,
  satellite: 'N21',
  sensor: 'VIIRS',
  acqMs: 1_753_600_000_000,
};

test('firms analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_FIRE);
  assert.deepEqual(r, {
    id: 'FIRE-00007',
    lat: 30.51,
    lon: -98.21,
    frp: 1520.4,
    confidence: 0.9,
    satellite: 'N21',
    acqTime: 1_753_600_000_000,
  });
});

test('firms analyst record: id matches the layer pick-id convention (5-digit pad)', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, index: 0 }).id, 'FIRE-00000');
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, index: 12345 }).id, 'FIRE-12345');
});

test('firms analyst record: blank satellite falls back to sensor, then null', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, satellite: '' }).satellite, 'VIIRS');
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, satellite: '', sensor: '' }).satellite, null);
});

test('firms analyst record: unparseable acq time (0 sentinel) becomes null', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, acqMs: 0 }).acqTime, null);
});

test('firms analyst record: empty record yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord(undefined);
  assert.equal(r.id, 'FIRE-00000');
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('firms analyst record: output is JSON-safe (no Cesium types leak)', () => {
  const r = mapAnalystRecord({ ...FULL_FIRE, contextEntity: {}, position: { x: 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal('position' in r, false);
});
