import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aircraftRegistrationCountry } from '../scripts/shared/aircraft-registration-country.mjs';

describe('aircraftRegistrationCountry', () => {
  it('maps OFAC tail numbers to their state of registry', () => {
    for (const [tail, code] of [
      ['EP-MMH', 'IR'], ['RA-89049', 'RU'], ['RF-94591', 'RU'], ['EW-001PA', 'BY'], ['YK-AYA', 'SY'],
      ['P-632', 'KP'], ['P4-MGU', 'AW'], ['3A-MGU', 'MC'], ['M-IABU', 'IM'], ['9XR-WK', 'RW'], ['A4O-AA', 'OM'],
    ]) assert.equal(aircraftRegistrationCountry(tail), code, tail);
  });

  it('reads the registries written without a hyphen only before a digit', () => {
    for (const [tail, code] of [['N200VR', 'US'], ['YV2040', 'VE'], ['YV378T', 'VE'], ['JA8089', 'JP'], ['HL7611', 'KR']]) {
      assert.equal(aircraftRegistrationCountry(tail), code, tail);
    }
    for (const tail of ['P4MGU', 'EPMMH', 'NABC']) assert.equal(aircraftRegistrationCountry(tail), null, tail);
  });

  it('splits sub-allocated and shared marks', () => {
    for (const [tail, code] of [
      ['VP-BKA', 'BM'], ['VP-CAB', 'KY'], ['VQ-BOS', 'BM'], ['B-1234', 'CN'], ['B-18101', 'TW'], ['B-HNR', 'HK'], ['B-MAX', 'MO'],
    ]) assert.equal(aircraftRegistrationCountry(tail), code, tail);
    assert.equal(aircraftRegistrationCountry('SU-AOA'), 'EG');
    for (const tail of ['VP-XYZ', 'PJ-ABC', 'SU-YAA', '', 'EP-', 'Unknown']) assert.equal(aircraftRegistrationCountry(tail), null, tail);
  });
});
