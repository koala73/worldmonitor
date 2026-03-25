import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallsign, toIataCallsign, icaoToIata } from '../server/_shared/airline-codes.ts';
import { getWingbitsLiveFlight } from '../server/worldmonitor/military/v1/get-wingbits-live-flight.ts';

const ECS_BASE = 'https://ecs-api.wingbits.com/v1/flights';
const PHOTOS_BASE = 'https://api.planespotters.net/pub/photos/hex';
const originalFetch = globalThis.fetch;

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

describe('getWingbitsLiveFlight — IATA schedule fallback', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('falls back to IATA callsign when ICAO schedule returns 404, populates airline fields', async () => {
    const fetchedUrls = [];

    globalThis.fetch = async (url) => {
      const u = url.toString();
      fetchedUrls.push(u);

      // Live flight endpoint
      if (u === `${ECS_BASE}/ae1234`) {
        return jsonResp({
          flight: { h: 'ae1234', f: 'UAE528', la: 25.2, lo: 55.3, ab: 35000, gs: 500, tr: 180, rs: 0, og: false, ra: '2024-01-01T12:00:00Z' },
        });
      }
      // ICAO schedule — miss
      if (u === `${ECS_BASE}/schedule/UAE528`) {
        return new Response('Not Found', { status: 404 });
      }
      // IATA schedule fallback — hit
      if (u === `${ECS_BASE}/schedule/EK528`) {
        return jsonResp({
          schedule: { depIata: 'DXB', arrIata: 'LHR', depTimeUtc: '2024-01-01T10:00:00Z', arrTimeUtc: '2024-01-01T18:00:00Z', status: 'en-route', duration: 480 },
        });
      }
      // Photo — skip cleanly
      if (u.startsWith(PHOTOS_BASE)) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response('Unexpected URL', { status: 500 });
    };

    const result = await getWingbitsLiveFlight({}, { icao24: 'ae1234' });

    assert.ok(result.flight, 'flight should be present');
    // Airline fields populated from ICAO→IATA lookup
    assert.equal(result.flight.callsignIata, 'EK528');
    assert.equal(result.flight.airlineName, 'Emirates');
    // Schedule populated via IATA fallback
    assert.equal(result.flight.depIata, 'DXB');
    assert.equal(result.flight.arrIata, 'LHR');
    assert.equal(result.flight.flightStatus, 'en-route');
    assert.equal(result.flight.flightDurationMin, 480);
    // IATA fallback URL was fetched (not just ICAO)
    assert.ok(fetchedUrls.some(u => u.includes('/schedule/EK528')), 'should have fetched IATA schedule');
    // Cache key uses ICAO callsign (uppercase), not IATA
    assert.ok(fetchedUrls.some(u => u.includes('/schedule/UAE528')), 'should have tried ICAO schedule first');
  });

  it('uses ICAO schedule when available, skips IATA fallback', async () => {
    const fetchedUrls = [];

    globalThis.fetch = async (url) => {
      const u = url.toString();
      fetchedUrls.push(u);

      if (u === `${ECS_BASE}/ae1234`) {
        return jsonResp({
          flight: { h: 'ae1234', f: 'UAE528', la: 25.2, lo: 55.3, ab: 35000, gs: 500, tr: 180, rs: 0, og: false, ra: '2024-01-01T12:00:00Z' },
        });
      }
      if (u === `${ECS_BASE}/schedule/UAE528`) {
        return jsonResp({ schedule: { depIata: 'DXB', arrIata: 'LHR', status: 'en-route', duration: 480 } });
      }
      if (u.startsWith(PHOTOS_BASE)) return new Response('Not Found', { status: 404 });
      return new Response('Unexpected URL', { status: 500 });
    };

    const result = await getWingbitsLiveFlight({}, { icao24: 'ae1234' });

    assert.ok(result.flight);
    assert.equal(result.flight.depIata, 'DXB');
    // IATA fallback should NOT have been fetched
    assert.ok(!fetchedUrls.some(u => u.includes('/schedule/EK528')), 'should not fetch IATA schedule when ICAO succeeds');
  });

  it('returns no flight for unknown icao24', async () => {
    const result = await getWingbitsLiveFlight({}, { icao24: '' });
    assert.equal(result.flight, undefined);
  });

  it('returns no flight for invalid icao24 format', async () => {
    const result = await getWingbitsLiveFlight({}, { icao24: 'ZZZZZZ' });
    assert.equal(result.flight, undefined);
  });
});
