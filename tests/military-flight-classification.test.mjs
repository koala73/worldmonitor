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
  });
});
