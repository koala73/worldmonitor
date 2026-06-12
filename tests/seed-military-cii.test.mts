import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregate,
  classifyVessel,
  analyzeMmsi,
  geoToCountry,
  normalizeCountryName,
  readMilitaryFlights,
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
  // 00-suffix heuristic fires only when the MID resolves to a known country (273 = Russia)
  assert.deepEqual(analyzeMmsi('273009999'), { isPotentialMilitary: true, country: 'Russia' });
  // 00-suffix under an UNKNOWN MID is NOT trusted — civilian false-positive guard
  assert.deepEqual(analyzeMmsi('999009999'), { isPotentialMilitary: false, country: undefined });
  // plain civilian MMSI under a known MID — not flagged, but country still resolved
  assert.deepEqual(analyzeMmsi('338123456'), { isPotentialMilitary: false, country: 'USA' });
  // non-numeric / letter-padded MMSI is rejected outright — shape-consistent
  // with the other branches (always carries a `country` key, undefined here)
  assert.deepEqual(analyzeMmsi('ABC009999'), { isPotentialMilitary: false, country: undefined });
  // too short
  assert.deepEqual(analyzeMmsi('123'), { isPotentialMilitary: false, country: undefined });
});

test('classifyVessel: military by pattern / known name / ship type, civilian rejected', () => {
  // classifyVessel resolves the operator straight to ISO2
  assert.deepEqual(classifyVessel({ mmsi: '369970123', name: '', shipType: 0 }), { operatorIso2: 'US' });
  assert.deepEqual(classifyVessel({ mmsi: '', name: 'USS Nimitz underway', shipType: 0 }), { operatorIso2: 'US' });
  // AIS ship type 35 = military ops; no operator known → operatorIso2 null
  assert.deepEqual(classifyVessel({ mmsi: '111111111', name: 'X', shipType: 35 }), { operatorIso2: null });
  // hull number '16' alone must NOT classify a civilian vessel as the carrier Liaoning
  assert.equal(classifyVessel({ mmsi: '111111111', name: 'CONTAINER 16', shipType: 70 }), null);
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

test('aggregate: a domestic flight is own-only, never double-counted as foreign', () => {
  const agg = aggregate([{ operatorCountry: 'USA', lat: 39, lon: -98 }], [], []);
  assert.equal(agg.byCountry.US.ownFlights, 1);
  assert.equal(agg.byCountry.US.foreignFlights, 0); // loc === op → the `loc !== op` guard holds
});

test('aggregate: an unknown-operator military vessel is local presence, not x2 foreign', () => {
  // shipType 35 (military ops) but an MMSI resolving no country → classifyVessel operatorIso2 null.
  const agg = aggregate([], [{ mmsi: '111111111', name: '', lat: 39, lon: -98, shipType: 35 }], []);
  assert.equal(agg.byCountry.US.ownVessels, 1, 'counted once as local military presence');
  assert.equal(agg.byCountry.US.foreignVessels, 0, 'not x2 foreign — the operator is unknown');
});

test('aggregate: an unknown-operator military flight is local presence, not x2 foreign', () => {
  // seed-military-flights emits operatorCountry: 'Unknown' for low-confidence matches
  // (and 'NATO' / non-TIER1 names also fall through normalizeCountryName) — they must
  // not inflate the location country's foreignFlights x2 weight.
  const agg = aggregate([{ operatorCountry: 'Unknown', lat: 39, lon: -98 }], [], []);
  assert.equal(agg.byCountry.US.ownFlights, 1, 'counted once as local military presence');
  assert.equal(agg.byCountry.US.foreignFlights, 0, 'not x2 foreign — the operator is unknown');
});

test('aggregate: AIS disruption with unknown/missing severity falls into the low bucket', () => {
  const agg = aggregate([], [], [
    { lat: 39, lon: -98, severity: 'minor' },
    { lat: 39, lon: -98 },
  ]);
  assert.equal(agg.byCountry.US.aisDisruptionLow, 2);
  assert.equal(agg.byCountry.US.aisDisruptionHigh, 0);
  assert.equal(agg.byCountry.US.aisDisruptionElevated, 0);
});

test('aggregate emits a record for every TIER1 country, zeroed by default', () => {
  const agg = aggregate([], [], []);
  assert.equal(Object.keys(agg.byCountry).length, 31);
  for (const rec of Object.values(agg.byCountry) as Array<Record<string, number>>) {
    assert.equal(rec.ownFlights + rec.foreignFlights + rec.ownVessels
      + rec.foreignVessels + rec.aisDisruptionHigh, 0);
  }
});

test('readMilitaryFlights fails closed on missing or empty flights payloads', async () => {
  assert.deepEqual(
    await readMilitaryFlights(async () => null),
    { ok: false, flights: [] },
    'missing military:flights:v1 must not be treated as a fresh zero-flight payload',
  );
  assert.deepEqual(
    await readMilitaryFlights(async () => ({ flights: [] })),
    { ok: false, flights: [] },
    'empty military:flights:v1 must preserve/skip instead of clearing last-good flight counts',
  );
});

test('readMilitaryFlights reports thrown Redis reads as not ok', async () => {
  const result = await readMilitaryFlights(async () => {
    throw new Error('redis unavailable');
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.flights, []);
  assert.match(String(result.error), /redis unavailable/);
});

test('main preserves last-good CII payload before returning on flights-read failure', () => {
  const source = readFileSync(new URL('../scripts/seed-military-cii.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /if \(!flightsRead\.ok\) \{[\s\S]{0,500}?await preserveLastGoodMilitaryCii\(url, token, reason\);[\s\S]{0,80}?return;/,
    'main must preserve/skip instead of aggregating a zero-flight payload when military:flights:v1 is unavailable',
  );
});

test('producer operatorCountry vocabulary: every TIER1-mapped string resolves to its ISO2', () => {
  // Locks down the seed COUNTRY_KEYWORDS table against drift from the producer
  // (scripts/seed-military-flights.mjs). If that script adds a new operatorCountry
  // string that maps to a TIER1 country, the seed must resolve it — otherwise the
  // flight silently buckets to "unknown operator" (local presence, not x2 foreign).
  // Non-TIER1 operator strings (Australia/Canada/Kuwait/NATO) are intentionally not
  // covered — they have nowhere to land in the TIER1-only score and should fall
  // through to the unknown-operator branch.
  const PRODUCER_TIER1_OPERATORS: Array<[string, string]> = [
    ['USA', 'US'], ['UK', 'GB'], ['China', 'CN'], ['France', 'FR'], ['Germany', 'DE'],
    ['Israel', 'IL'], ['Japan', 'JP'], ['Pakistan', 'PK'], ['Qatar', 'QA'],
    ['Russia', 'RU'], ['Saudi Arabia', 'SA'], ['South Korea', 'KR'],
    ['Turkey', 'TR'], ['UAE', 'AE'], ['Egypt', 'EG'],
  ];
  for (const [operatorString, expectedIso2] of PRODUCER_TIER1_OPERATORS) {
    assert.equal(
      normalizeCountryName(operatorString),
      expectedIso2,
      `producer emits operatorCountry='${operatorString}' but seed COUNTRY_KEYWORDS no longer resolves it to ${expectedIso2}`,
    );
  }
});
