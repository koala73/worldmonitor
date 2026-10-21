import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  identifyCommercialCallsign,
  detectAircraftTypeFromSourceMeta,
  deriveSourceHints,
  deriveOperatorFromSourceMeta,
  filterMilitaryFlights,
} from '../scripts/seed-military-flights.mjs';

function makeState({
  icao24,
  callsign,
  country = '',
  lon = 0,
  lat = 0,
  sourceMeta,
}) {
  return [
    icao24,
    callsign,
    country,
    null,
    Date.now() / 1000,
    lon,
    lat,
    0,
    false,
    0,
    0,
    0,
    null,
    null,
    null,
    sourceMeta || {},
  ];
}

describe('military flight classification', () => {
  it('identifies commercial callsigns beyond the static 3-letter set', () => {
    assert.ok(identifyCommercialCallsign('CLX283'));
    assert.ok(identifyCommercialCallsign('QR3251'));
    assert.ok(identifyCommercialCallsign('QTR8VG'));
  });

  it('derives military hints and aircraft type from source metadata', () => {
    const sourceMeta = {
      operatorName: 'US Air Force',
      aircraftTypeLabel: 'KC-135 tanker',
      aircraftModel: 'Boeing KC-135R',
    };
    const hints = deriveSourceHints(sourceMeta);
    assert.equal(hints.militaryHint, true);
    assert.equal(detectAircraftTypeFromSourceMeta(sourceMeta), 'tanker');
  });

  it('does not mark military airlift metadata as commercial just because it includes cargo language', () => {
    const sourceMeta = {
      operatorName: 'Qatar Emiri Air Force',
      aircraftTypeLabel: 'military cargo transport',
      aircraftModel: 'C-17 Globemaster',
    };
    const hints = deriveSourceHints(sourceMeta);
    assert.equal(hints.militaryHint, true);
    assert.equal(hints.militaryOperatorHint, true);
    assert.equal(hints.commercialHint, false);
  });

  it('does not trigger military hints from short acronyms embedded in unrelated words', () => {
    const hints = deriveSourceHints({
      operatorName: 'Civil Aircraft Leasing',
      aircraftTypeLabel: 'aircraft transport',
      registration: 'G-RAFT',
      aircraftDescription: 'airplane support platform',
    });
    assert.equal(hints.militaryHint, false);
    assert.equal(hints.militaryOperatorHint, false);
  });

  it('detects additional high-signal source aircraft types', () => {
    assert.equal(detectAircraftTypeFromSourceMeta({
      aircraftTypeLabel: 'A330 MRTT tanker transport',
    }), 'tanker');
    assert.equal(detectAircraftTypeFromSourceMeta({
      aircraftTypeLabel: 'E-2 early warning aircraft',
    }), 'awacs');
    assert.equal(detectAircraftTypeFromSourceMeta({
      aircraftTypeLabel: 'A400M military airlift',
    }), 'transport');
    assert.equal(detectAircraftTypeFromSourceMeta({
      aircraftTypeLabel: 'ISR surveillance platform',
    }), 'reconnaissance');
  });

  it('rejects commercial-looking flights even when they match an ambiguous hex range', () => {
    const state = makeState({
      icao24: '06A250',
      callsign: 'QTR8VG',
      country: 'Qatar',
      lon: 51.6,
      lat: 25.2,
    });

    const { flights, audit } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 0);
    assert.equal(audit.rejectedByReason.commercial_callsign_override, 1);
  });

  it('rejects ambiguous hex-only flights without supporting source metadata', () => {
    const state = makeState({
      icao24: '06A255',
      callsign: '',
      country: 'Qatar',
      lon: 51.6,
      lat: 25.2,
    });

    const { flights, audit } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 0);
    assert.equal(audit.rejectedByReason.ambiguous_hex_without_support, 1);
  });

  it('keeps trusted military hex matches and records admission reason', () => {
    const state = makeState({
      icao24: 'ADF800',
      callsign: '',
      country: 'United States',
      lon: 120.7,
      lat: 15.1,
    });

    const { flights, audit } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].admissionReason, 'hex_trusted');
    assert.equal(audit.admittedByReason.hex_trusted, 1);
  });

  it('admits ambiguous hex matches when source metadata clearly indicates military context', () => {
    const state = makeState({
      icao24: '06A255',
      callsign: '',
      country: 'Qatar',
      lon: 25.1,
      lat: 51.6,
      sourceMeta: {
        operatorName: 'Qatar Emiri Air Force',
        aircraftTypeLabel: 'military transport',
        aircraftModel: 'C-17 Globemaster',
      },
    });

    const { flights } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].admissionReason, 'hex_supported_by_source');
    assert.equal(flights[0].aircraftType, 'transport');
    assert.equal(flights[0].classificationReason, 'source_metadata');
    assert.equal(flights[0].operator, 'qeaf');
    assert.equal(flights[0].operatorCountry, 'Qatar');
  });

  it('derives a stable operator identity from source metadata for ambiguous military ranges', () => {
    const sourceMeta = {
      operatorName: 'Qatar Emiri Air Force',
      aircraftTypeLabel: 'military transport',
      aircraftModel: 'C-17 Globemaster',
    };
    const operator = deriveOperatorFromSourceMeta(sourceMeta);
    assert.deepEqual(operator, {
      operator: 'qeaf',
      operatorCountry: 'Qatar',
      reason: 'source_operator',
      confidence: 'high',
    });
  });

  it('derives stable operator identities for major military operators from source metadata', () => {
    assert.deepEqual(deriveOperatorFromSourceMeta({
      operatorName: 'United States Air Force',
      aircraftTypeLabel: 'KC-135 tanker',
    }), {
      operator: 'usaf',
      operatorCountry: 'USA',
      reason: 'source_operator',
      confidence: 'high',
    });

    assert.deepEqual(deriveOperatorFromSourceMeta({
      operatorName: "People's Liberation Army Air Force",
      aircraftTypeLabel: 'fighter aircraft',
    }), {
      operator: 'plaaf',
      operatorCountry: 'China',
      reason: 'source_operator',
      confidence: 'high',
    });
  });

  it('admits exact validated PLA aircraft without adding a China-wide hex range', () => {
    const fixtures = [
      { hex: '7A4262', type: 'reconnaissance' },
      { hex: '7A444F', type: 'tanker' },
      { hex: '7A446F', type: 'transport' },
      { hex: '7A4403', type: 'transport' },
    ];

    for (const fixture of fixtures) {
      const { flights } = filterMilitaryFlights([makeState({
        icao24: fixture.hex,
        callsign: '',
        country: 'China',
        lon: 120,
        lat: 25,
      })]);
      assert.equal(flights.length, 1, `${fixture.hex} should classify by exact record`);
      assert.equal(flights[0].operator, 'plaaf');
      assert.equal(flights[0].operatorCountry, 'China');
      assert.equal(flights[0].aircraftType, fixture.type);
      assert.equal(flights[0].confidence, 'high');
      assert.equal(flights[0].admissionReason, 'hex_exact');
    }
  });

  it('admits explicit trusted PLAAF and PLAN operator metadata on otherwise-unclassified hexes', () => {
    const fixtures = [
      { hex: '780123', operatorCode: 'PLAAF', expected: 'plaaf', type: 'J-16 fighter' },
      { hex: '781234', operatorCode: 'PLAN', expected: 'plan', type: 'Y-9 patrol aircraft' },
    ];

    for (const fixture of fixtures) {
      const { flights } = filterMilitaryFlights([makeState({
        icao24: fixture.hex,
        callsign: '',
        country: 'China',
        lon: 120,
        lat: 25,
        sourceMeta: {
          operatorCode: fixture.operatorCode,
          aircraftTypeLabel: fixture.type,
        },
      })]);
      assert.equal(flights.length, 1, `${fixture.operatorCode} metadata should be trusted`);
      assert.equal(flights[0].operator, fixture.expected);
      assert.equal(flights[0].operatorCountry, 'China');
      assert.equal(flights[0].admissionReason, 'source_operator_trusted');
      assert.equal(flights[0].operatorInferenceReason, 'source_metadata');
    }
  });

  it('keeps Chinese airlines and arbitrary national-allocation hexes non-military', () => {
    const fixtures = [
      { hex: '780101', callsign: 'CCA123' }, // Air China
      { hex: '780102', callsign: 'CSN456' }, // China Southern
      { hex: '780103', callsign: 'CHH789' }, // Hainan Airlines
      { hex: '7A4000', callsign: '' },        // arbitrary China allocation
    ];

    const { flights } = filterMilitaryFlights(fixtures.map((fixture) => makeState({
      icao24: fixture.hex,
      callsign: fixture.callsign,
      country: 'China',
      lon: 120,
      lat: 25,
    })));
    assert.deepEqual(flights, []);
  });

  it('does not false-positive short operator acronyms inside unrelated words', () => {
    assert.equal(deriveOperatorFromSourceMeta({
      operatorName: 'Civil Aircraft Leasing',
      aircraftTypeLabel: 'aircraft transport',
      registration: 'G-RAFT',
      aircraftDescription: 'airplane traffic platform',
    }), null);

    assert.equal(deriveOperatorFromSourceMeta({
      operatorName: 'General planning systems',
      aircraftTypeLabel: 'airplane transport',
      aircraftDescription: 'airplane support',
    }), null);
  });

  it('preserves source metadata and source-based inference in accepted flight records', () => {
    const state = makeState({
      icao24: 'ADF800',
      callsign: 'VIPER17',
      country: 'United States',
      lon: 120.7,
      lat: 15.1,
      sourceMeta: {
        source: 'wingbits',
        operatorName: 'United States Air Force',
        operatorCode: 'USAF',
        aircraftTypeLabel: 'F-16 fighter',
        aircraftModel: 'F-16C',
        registration: '84-1256',
      },
    });

    const { flights } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].sourceMeta.operatorName, 'United States Air Force');
    assert.equal(flights[0].sourceMeta.aircraftTypeCode, '');
    assert.equal(flights[0].operator, 'usaf');
    assert.equal(flights[0].operatorInferenceReason, 'callsign_pattern');
    assert.equal(flights[0].aircraftTypeInferenceReason, 'callsign_pattern');
  });

  it('reports source-backed operator inference and richer audit samples', () => {
    const state = makeState({
      icao24: '06A255',
      callsign: '',
      country: 'Qatar',
      lon: 25.1,
      lat: 51.6,
      sourceMeta: {
        source: 'wingbits',
        rawKeys: ['operatorName', 'operatorCode', 'registration'],
        rawPreview: {
          operatorName: 'Qatar Emiri Air Force',
          registration: 'QA-202',
        },
        operatorName: 'Qatar Emiri Air Force',
        operatorCode: 'QEAF',
        aircraftTypeLabel: 'military transport',
        aircraftModel: 'C-17 Globemaster',
        registration: 'QA-202',
      },
    });

    const { flights, audit } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 1);
    assert.equal(audit.typedBySource, 1);
    assert.equal(audit.sourceOperatorInferred, 1);
    assert.equal(audit.operatorOtherRate, 0);
    assert.equal(audit.samples.accepted[0].operatorInferenceReason, 'source_metadata');
    assert.equal(audit.samples.accepted[0].sourceMeta.operatorCode, 'QEAF');
    assert.equal(audit.samples.accepted[0].sourceMeta.registration, 'QA-202');
    assert.equal(audit.stageWaterfall.rawStates, 1);
    assert.equal(audit.stageWaterfall.positionEligible, 1);
    assert.equal(audit.stageWaterfall.sourceMetaAttached, 1);
    assert.equal(audit.stageWaterfall.callsignPresent, 0);
    assert.equal(audit.stageWaterfall.hexMatched, 1);
    assert.equal(audit.stageWaterfall.candidateStates, 1);
    assert.equal(audit.stageWaterfall.admittedFlights, 1);
    assert.equal(audit.stageWaterfall.typedFlights, 1);
    assert.equal(audit.stageWaterfall.operatorResolved, 1);
    assert.equal(audit.sourceCoverage.operatorNamePresent, 1);
    assert.equal(audit.sourceCoverage.operatorCodePresent, 1);
    assert.equal(audit.sourceCoverage.registrationPresent, 1);
    assert.equal(audit.sourceCoverage.militaryHint, 1);
    assert.equal(audit.sourceCoverage.militaryOperatorHint, 1);
    assert.equal(audit.sourceCoverage.sourceOperatorCandidateHits, 1);
    assert.equal(audit.sourceCoverage.sourceTypeCandidateHits, 1);
    assert.equal(audit.sourceCoverage.rawKeyOnlyCandidates, 0);
    assert.deepEqual(audit.sourceCoverage.topRawKeys, [
      { key: 'operatorCode', count: 1 },
      { key: 'operatorName', count: 1 },
      { key: 'registration', count: 1 },
    ]);
    assert.deepEqual(audit.sourceCoverage.sourceShapeSamples[0].rawPreview, {
      operatorName: 'Qatar Emiri Air Force',
      registration: 'QA-202',
    });
  });

  it('surfaces raw-key-only source candidates when normalized source fields are empty', () => {
    const state = makeState({
      icao24: 'ADF800',
      callsign: '',
      country: 'United States',
      lon: 120.7,
      lat: 15.1,
      sourceMeta: {
        source: 'wingbits',
        rawKeys: ['operator', 'description'],
      },
    });

    const { audit } = filterMilitaryFlights([state]);
    assert.equal(audit.sourceCoverage.rawKeyOnlyCandidates, 1);
    assert.deepEqual(audit.sourceCoverage.rawKeyOnlySamples, [
      {
        callsign: '',
        rawKeys: ['description', 'operator'],
      },
    ]);
  });
});
