// src/data/aircraftClass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAircraft, CLASS_SCALE_2D, CLASS_SCALE_3D, CLASS_MODEL_URL, CLASS_MODEL_REAL } from './aircraftClass.js';

test('type-code classification (military layer path)', () => {
  assert.equal(classifyAircraft({ typeCode: 'F16' }), 'fastjet');
  assert.equal(classifyAircraft({ typeCode: 'EC35' }), 'helicopter');
  assert.equal(classifyAircraft({ typeCode: 'B744' }), 'quadjet');
  assert.equal(classifyAircraft({ typeCode: 'B77W' }), 'widebody');
  assert.equal(classifyAircraft({ typeCode: 'C17' }), 'widebody');
  assert.equal(classifyAircraft({ typeCode: 'AT76' }), 'turboprop');
  assert.equal(classifyAircraft({ typeCode: 'C172' }), 'light');
  assert.equal(classifyAircraft({ typeCode: 'b738' }), 'airliner'); // case-insensitive default-jet
});

test('bizjet + uav classes (2026-08-16 Hangar fleet)', () => {
  assert.equal(classifyAircraft({ typeCode: 'C25A' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'C56X' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'GLF5' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'CL60' }), 'bizjet');
  // SF50 Cirrus Vision Jet is a JET — it must NOT fall back to the light/prop class.
  assert.equal(classifyAircraft({ typeCode: 'SF50' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'MQ9' }), 'uav');
  assert.equal(classifyAircraft({ typeCode: 'Q4' }), 'uav');
  assert.equal(classifyAircraft({ typeCode: 'TB2' }), 'uav');
});

test('category fallback (flights layer path — OpenSky extended int)', () => {
  assert.equal(classifyAircraft({ category: 8 }), 'helicopter');
  assert.equal(classifyAircraft({ category: 6 }), 'widebody');
  assert.equal(classifyAircraft({ category: 7 }), 'fastjet');
  assert.equal(classifyAircraft({ category: 2 }), 'light');
  assert.equal(classifyAircraft({ category: 9 }), 'glider');
  assert.equal(classifyAircraft({ category: 4 }), 'airliner');
});

test('ADS-B emitter string categories', () => {
  assert.equal(classifyAircraft({ category: 'A7' }), 'helicopter');
  assert.equal(classifyAircraft({ category: 'A5' }), 'widebody');
  assert.equal(classifyAircraft({ category: 'A1' }), 'light');
  assert.equal(classifyAircraft({ category: 'B1' }), 'glider');
});

test('typeCode outranks category; unknown → airliner', () => {
  assert.equal(classifyAircraft({ typeCode: 'F18', category: 6 }), 'fastjet');
  assert.equal(classifyAircraft({}), 'airliner');
  assert.equal(classifyAircraft({ typeCode: null, category: 0 }), 'airliner');
});

test('scale/url tables cover every class', () => {
  for (const kind of ['light','glider','turboprop','airliner','widebody','quadjet','helicopter','fastjet','bizjet','uav']) {
    assert.ok(Number.isFinite(CLASS_SCALE_2D[kind]), kind);
    assert.ok(CLASS_SCALE_3D[kind] >= 0.75 && CLASS_SCALE_3D[kind] <= 1.45, kind);
    assert.ok(typeof CLASS_MODEL_URL[kind] === 'string', kind);
  }
});

test('CLASS_MODEL_REAL entries carry the fields the layers consume', () => {
  for (const [kind, spec] of Object.entries(CLASS_MODEL_REAL)) {
    assert.ok(spec.url.startsWith('/models/') && spec.url.endsWith('.glb'), kind);
    assert.ok(spec.radiusM > 0 && spec.bellyM > 0, kind);
    // every real-model class must also exist in the classifier tables
    assert.ok(Number.isFinite(CLASS_SCALE_2D[kind]), kind);
  }
});
