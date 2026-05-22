import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregate,
  classifyVessel,
  analyzeMmsi,
  geoToCountry,
  normalizeCountryName,
} from '../scripts/seed-military-cii.mjs';

test('geoToCountry resolves points inside a TIER1 bbox', () => {
  assert.equal(geoToCountry(39, -98), 'US');
  assert.equal(geoToCountry(31.5, 35), 'IL');
  assert.equal(geoToCountry(55.7, 37.6), 'RU'); // Moscow
  assert.equal(geoToCountry(0, -150), null); // open Pacific
  assert.equal(geoToCountry(NaN, 35), null);
});

test('normalizeCountryName maps names/abbreviations to ISO2', () => {
  assert.equal(normalizeCountryName('USA'), 'US');
  assert.equal(normalizeCountryName('China'), 'CN');
  assert.equal(normalizeCountryName('UK'), 'GB');
  assert.equal(normalizeCountryName('Russia'), 'RU');
  assert.equal(normalizeCountryName('Narnia'), null);
  assert.equal(normalizeCountryName(''), null);
});

test('analyzeMmsi flags military by pattern, suffix, and MID', () => {
  // explicit US Navy MMSI prefix pattern
  assert.deepEqual(analyzeMmsi('369970123'), { isPotentialMilitary: true, country: 'USA' });
  // 00/99 suffix heuristic + MID country (273 = Russia)
  assert.deepEqual(analyzeMmsi('273009999'), { isPotentialMilitary: true, country: 'Russia' });
  // plain civilian MMSI under a known MID — not flagged, but country still resolved
  assert.deepEqual(analyzeMmsi('338123456'), { isPotentialMilitary: false, country: 'USA' });
  // too short
  assert.deepEqual(analyzeMmsi('123'), { isPotentialMilitary: false });
});

test('classifyVessel: military by pattern / known name / ship type, civilian rejected', () => {
  assert.deepEqual(classifyVessel({ mmsi: '369970123', name: '', shipType: 0 }), { operatorCountry: 'USA' });
  assert.deepEqual(classifyVessel({ mmsi: '', name: 'USS Nimitz underway', shipType: 0 }), { operatorCountry: 'USA' });
  // AIS ship type 35 = military ops; no MID country → operatorCountry null
  assert.deepEqual(classifyVessel({ mmsi: '111111111', name: 'X', shipType: 35 }), { operatorCountry: null });
  // ordinary cargo vessel — not military
  assert.equal(classifyVessel({ mmsi: '111111111', name: 'Cargo', shipType: 70 }), null);
});

test('aggregate splits own vs foreign presence and buckets AIS disruptions', () => {
  const agg = aggregate(
    // a US-operated flight physically over Israel
    [{ operatorCountry: 'USA', lat: 31.5, lon: 35 }],
    // a US Navy vessel in US waters
    [{ mmsi: '369970123', name: '', lat: 39, lon: -98, shipType: 0 }],
    [
      { lat: 31.5, lon: 35, severity: 'high' },
      { lat: 39, lon: -98, severity: 'elevated' },
      { lat: 39, lon: -98, severity: 'low' },
    ],
  );
  assert.equal(agg.byCountry.US.ownFlights, 1);
  assert.equal(agg.byCountry.US.foreignFlights, 0);
  assert.equal(agg.byCountry.IL.foreignFlights, 1); // US flight counts as foreign presence in IL
  assert.equal(agg.byCountry.US.ownVessels, 1);
  assert.equal(agg.byCountry.IL.aisDisruptionHigh, 1);
  assert.equal(agg.byCountry.US.aisDisruptionElevated, 1);
  assert.equal(agg.byCountry.US.aisDisruptionLow, 1);
  assert.equal(agg.militaryVesselCount, 1);
});

test('aggregate emits a record for every TIER1 country, zeroed by default', () => {
  const agg = aggregate([], [], []);
  assert.equal(Object.keys(agg.byCountry).length, 31);
  for (const rec of Object.values(agg.byCountry) as Array<Record<string, number>>) {
    assert.equal(rec.ownFlights + rec.foreignFlights + rec.ownVessels
      + rec.foreignVessels + rec.aisDisruptionHigh, 0);
  }
});
