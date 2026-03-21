import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallsign, toIataCallsign, icaoToIata } from '../server/_shared/airline-codes.ts';

describe('parseCallsign', () => {
  it('parses standard 3-letter ICAO prefix + number', () => {
    assert.deepEqual(parseCallsign('UAE528'), { prefix: 'UAE', number: '528' });
    assert.deepEqual(parseCallsign('BAW61'), { prefix: 'BAW', number: '61' });
    assert.deepEqual(parseCallsign('EZY13BU'), { prefix: 'EZY', number: '13BU' });
    assert.deepEqual(parseCallsign('DAL123'), { prefix: 'DAL', number: '123' });
  });

  it('parses 2-letter prefixes', () => {
    assert.deepEqual(parseCallsign('LH123'), { prefix: 'LH', number: '123' });
  });

  it('parses 4-letter prefixes', () => {
    assert.deepEqual(parseCallsign('DUKE41'), { prefix: 'DUKE', number: '41' });
  });

  it('normalizes whitespace', () => {
    assert.deepEqual(parseCallsign('  UAE528  '), { prefix: 'UAE', number: '528' });
  });

  it('normalizes to uppercase', () => {
    assert.deepEqual(parseCallsign('uae528'), { prefix: 'UAE', number: '528' });
    assert.deepEqual(parseCallsign('ezy13bu'), { prefix: 'EZY', number: '13BU' });
  });

  it('returns null for callsigns starting with letter+digit (N-numbers)', () => {
    assert.equal(parseCallsign('N123AB'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseCallsign(''), null);
  });

  it('returns null for whitespace-only', () => {
    assert.equal(parseCallsign('   '), null);
  });

  it('returns null for pure alpha (no number suffix)', () => {
    assert.equal(parseCallsign('ABCD'), null);
  });
});

describe('icaoToIata', () => {
  it('returns IATA mapping for known prefixes', () => {
    assert.deepEqual(icaoToIata('UAE'), { iata: 'EK', name: 'Emirates' });
    assert.deepEqual(icaoToIata('BAW'), { iata: 'BA', name: 'British Airways' });
    assert.deepEqual(icaoToIata('EZY'), { iata: 'U2', name: 'easyJet' });
  });

  it('is case-insensitive', () => {
    assert.deepEqual(icaoToIata('uae'), { iata: 'EK', name: 'Emirates' });
    assert.deepEqual(icaoToIata('Baw'), { iata: 'BA', name: 'British Airways' });
  });

  it('returns undefined for unknown prefixes', () => {
    assert.equal(icaoToIata('DUKE'), undefined);
    assert.equal(icaoToIata('XYZ'), undefined);
    assert.equal(icaoToIata(''), undefined);
  });
});

describe('toIataCallsign', () => {
  it('converts ICAO callsign to IATA equivalent', () => {
    assert.deepEqual(toIataCallsign('UAE528'), { callsign: 'EK528', name: 'Emirates' });
    assert.deepEqual(toIataCallsign('BAW61'), { callsign: 'BA61', name: 'British Airways' });
    assert.deepEqual(toIataCallsign('EZY13BU'), { callsign: 'U213BU', name: 'easyJet' });
    assert.deepEqual(toIataCallsign('THY123'), { callsign: 'TK123', name: 'Turkish Airlines' });
  });

  it('handles whitespace and lowercase input', () => {
    assert.deepEqual(toIataCallsign('  uae528  '), { callsign: 'EK528', name: 'Emirates' });
  });

  it('returns null for unknown ICAO prefix (military/charter)', () => {
    assert.equal(toIataCallsign('DUKE41'), null);
    assert.equal(toIataCallsign('RCH123'), null);
  });

  it('returns null for non-standard format', () => {
    assert.equal(toIataCallsign('N123AB'), null);
  });

  it('returns null for empty or whitespace input', () => {
    assert.equal(toIataCallsign(''), null);
    assert.equal(toIataCallsign('   '), null);
  });
});
