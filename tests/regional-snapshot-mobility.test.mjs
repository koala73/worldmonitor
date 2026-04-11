// Tests for the Regional Intelligence Mobility v1 adapter (Phase 2 PR2).
// Pure-function unit tests; no Redis dependency. Run via:
//   npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  airportToSnapshotRegion,
  gpsjamRegionToSnapshotRegion,
  latLonToSnapshotRegion,
  buildAirports,
  buildAirspace,
  buildRerouteIntensity,
  buildNotamClosures,
  buildMobilityState,
} from '../scripts/regional-snapshot/mobility.mjs';

// ────────────────────────────────────────────────────────────────────────────
// airportToSnapshotRegion
// ────────────────────────────────────────────────────────────────────────────

describe('airportToSnapshotRegion', () => {
  it('routes US/Canada/Mexico airports to north-america', () => {
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'USA' }), 'north-america');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'Canada' }), 'north-america');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'Mexico' }), 'north-america');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'United States' }), 'north-america');
  });

  it('routes Latin American airports to latam', () => {
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'Brazil' }), 'latam');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'Argentina' }), 'latam');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'Colombia' }), 'latam');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AMERICAS', country: 'Chile' }), 'latam');
  });

  it('splits APAC by country between south-asia and east-asia', () => {
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_APAC', country: 'India' }), 'south-asia');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_APAC', country: 'Pakistan' }), 'south-asia');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_APAC', country: 'Bangladesh' }), 'south-asia');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_APAC', country: 'Japan' }), 'east-asia');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_APAC', country: 'China' }), 'east-asia');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_APAC', country: 'Singapore' }), 'east-asia');
  });

  it('routes europe/mena/africa directly', () => {
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_EUROPE', country: 'Germany' }), 'europe');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_MENA', country: 'UAE' }), 'mena');
    assert.equal(airportToSnapshotRegion({ region: 'AIRPORT_REGION_AFRICA', country: 'Kenya' }), 'sub-saharan-africa');
  });

  it('handles lowercase region labels (seeder-internal format)', () => {
    assert.equal(airportToSnapshotRegion({ region: 'americas', country: 'USA' }), 'north-america');
    assert.equal(airportToSnapshotRegion({ region: 'mena', country: 'Qatar' }), 'mena');
  });

  it('returns null for null/unknown inputs', () => {
    assert.equal(airportToSnapshotRegion(null), null);
    assert.equal(airportToSnapshotRegion({}), null);
    assert.equal(airportToSnapshotRegion({ region: 'UNKNOWN', country: 'X' }), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// gpsjamRegionToSnapshotRegion
// ────────────────────────────────────────────────────────────────────────────

describe('gpsjamRegionToSnapshotRegion', () => {
  it('maps MENA sub-regions', () => {
    assert.equal(gpsjamRegionToSnapshotRegion('iran-iraq'), 'mena');
    assert.equal(gpsjamRegionToSnapshotRegion('levant'), 'mena');
    assert.equal(gpsjamRegionToSnapshotRegion('israel-sinai'), 'mena');
    assert.equal(gpsjamRegionToSnapshotRegion('yemen-horn'), 'mena');
    assert.equal(gpsjamRegionToSnapshotRegion('turkey-caucasus'), 'mena');
  });

  it('maps Europe sub-regions', () => {
    assert.equal(gpsjamRegionToSnapshotRegion('ukraine-russia'), 'europe');
    assert.equal(gpsjamRegionToSnapshotRegion('russia-north'), 'europe');
    assert.equal(gpsjamRegionToSnapshotRegion('northern-europe'), 'europe');
    assert.equal(gpsjamRegionToSnapshotRegion('western-europe'), 'europe');
  });

  it('maps SSA sub-regions', () => {
    assert.equal(gpsjamRegionToSnapshotRegion('sudan-sahel'), 'sub-saharan-africa');
    assert.equal(gpsjamRegionToSnapshotRegion('east-africa'), 'sub-saharan-africa');
  });

  it('maps South Asia, East Asia, North America', () => {
    assert.equal(gpsjamRegionToSnapshotRegion('afghanistan-pakistan'), 'south-asia');
    assert.equal(gpsjamRegionToSnapshotRegion('southeast-asia'), 'east-asia');
    assert.equal(gpsjamRegionToSnapshotRegion('east-asia'), 'east-asia');
    assert.equal(gpsjamRegionToSnapshotRegion('north-america'), 'north-america');
  });

  it('returns null for "other" and unknown labels', () => {
    assert.equal(gpsjamRegionToSnapshotRegion('other'), null);
    assert.equal(gpsjamRegionToSnapshotRegion('antarctica'), null);
    assert.equal(gpsjamRegionToSnapshotRegion(undefined), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// latLonToSnapshotRegion
// ────────────────────────────────────────────────────────────────────────────

describe('latLonToSnapshotRegion', () => {
  it('classifies major cities to the right region', () => {
    assert.equal(latLonToSnapshotRegion(25.2532, 55.3657), 'mena'); // Dubai
    assert.equal(latLonToSnapshotRegion(32.0055, 34.8854), 'mena'); // Tel Aviv
    assert.equal(latLonToSnapshotRegion(51.4700, -0.4543), 'europe'); // LHR
    assert.equal(latLonToSnapshotRegion(55.9736, 37.4125), 'europe'); // Moscow SVO
    assert.equal(latLonToSnapshotRegion(35.5494, 139.7798), 'east-asia'); // Tokyo Haneda
    assert.equal(latLonToSnapshotRegion(28.5562, 77.1000), 'south-asia'); // Delhi
    assert.equal(latLonToSnapshotRegion(40.6413, -73.7781), 'north-america'); // JFK
    assert.equal(latLonToSnapshotRegion(-23.4356, -46.4731), 'latam'); // São Paulo
    assert.equal(latLonToSnapshotRegion(-1.3192, 36.9278), 'sub-saharan-africa'); // Nairobi
  });

  it('returns null for oceans and unmapped areas', () => {
    assert.equal(latLonToSnapshotRegion(-70, 0), null); // Antarctica
    assert.equal(latLonToSnapshotRegion(0, -150), null); // mid-Pacific
  });

  it('returns null for invalid inputs', () => {
    assert.equal(latLonToSnapshotRegion(null, null), null);
    assert.equal(latLonToSnapshotRegion(undefined, 0), null);
    assert.equal(latLonToSnapshotRegion(NaN, NaN), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildAirports
// ────────────────────────────────────────────────────────────────────────────

function alert(overrides = {}) {
  const iata = overrides.iata ?? 'ABC';
  return {
    id: `x-${iata}`,
    iata,
    icao: overrides.icao ?? `K${iata}`,
    name: overrides.name ?? iata,
    city: overrides.city ?? iata,
    country: overrides.country ?? 'USA',
    region: overrides.region ?? 'AIRPORT_REGION_AMERICAS',
    delayType: overrides.delayType ?? 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
    severity: overrides.severity ?? 'FLIGHT_DELAY_SEVERITY_MAJOR',
    avgDelayMinutes: overrides.avgDelayMinutes ?? 60,
    reason: overrides.reason ?? 'Weather',
    source: overrides.source ?? 'FLIGHT_DELAY_SOURCE_FAA',
  };
}

describe('buildAirports', () => {
  it('returns empty array when sources are missing', () => {
    assert.deepEqual(buildAirports('mena', {}), []);
    assert.deepEqual(buildAirports('mena', { 'aviation:delays:faa:v1': null }), []);
  });

  it('filters to airports in the requested region only', () => {
    const sources = {
      'aviation:delays:faa:v1': {
        alerts: [
          alert({ iata: 'JFK', icao: 'KJFK', country: 'USA' }),
          alert({ iata: 'LAX', icao: 'KLAX', country: 'USA' }),
        ],
      },
      'aviation:delays:intl:v3': {
        alerts: [
          alert({ iata: 'DXB', icao: 'OMDB', country: 'UAE', region: 'AIRPORT_REGION_MENA' }),
          alert({ iata: 'LHR', icao: 'EGLL', country: 'UK', region: 'AIRPORT_REGION_EUROPE' }),
        ],
      },
    };
    const na = buildAirports('north-america', sources);
    assert.equal(na.length, 2);
    assert.deepEqual(na.map((a) => a.icao).sort(), ['KJFK', 'KLAX']);

    const mena = buildAirports('mena', sources);
    assert.equal(mena.length, 1);
    assert.equal(mena[0].icao, 'OMDB');
  });

  it('filters out alerts below MAJOR severity', () => {
    const sources = {
      'aviation:delays:faa:v1': {
        alerts: [
          alert({ iata: 'JFK', severity: 'FLIGHT_DELAY_SEVERITY_MINOR' }),
          alert({ iata: 'LAX', severity: 'FLIGHT_DELAY_SEVERITY_MODERATE' }),
          alert({ iata: 'ORD', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR' }),
          alert({ iata: 'ATL', severity: 'FLIGHT_DELAY_SEVERITY_SEVERE' }),
        ],
      },
    };
    const na = buildAirports('north-america', sources);
    assert.equal(na.length, 2);
    assert.deepEqual(na.map((a) => a.name).sort(), ['ATL', 'ORD']);
  });

  it('maps severity to disrupted vs closed', () => {
    const sources = {
      'aviation:delays:faa:v1': {
        alerts: [
          alert({ iata: 'MAJOR', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR' }),
          alert({ iata: 'SEVERE', severity: 'FLIGHT_DELAY_SEVERITY_SEVERE' }),
        ],
      },
    };
    const na = buildAirports('north-america', sources);
    const byName = Object.fromEntries(na.map((a) => [a.name, a.status]));
    assert.equal(byName['MAJOR'], 'disrupted');
    assert.equal(byName['SEVERE'], 'closed');
  });

  it('carries disruption_reason from the alert', () => {
    const sources = {
      'aviation:delays:faa:v1': {
        alerts: [alert({ reason: 'Ground stop due to weather' })],
      },
    };
    const na = buildAirports('north-america', sources);
    assert.equal(na[0].disruption_reason, 'Ground stop due to weather');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildAirspace
// ────────────────────────────────────────────────────────────────────────────

describe('buildAirspace', () => {
  it('returns empty when no hexes are present', () => {
    assert.deepEqual(buildAirspace('mena', {}), []);
    assert.deepEqual(buildAirspace('mena', { 'intelligence:gpsjam:v2': { hexes: [] } }), []);
  });

  it('aggregates hexes for this region into ONE AirspaceStatus entry', () => {
    const sources = {
      'intelligence:gpsjam:v2': {
        hexes: [
          { h3: 'h1', lat: 30, lon: 45, level: 'high', region: 'iran-iraq' },
          { h3: 'h2', lat: 32, lon: 48, level: 'high', region: 'iran-iraq' },
          { h3: 'h3', lat: 31, lon: 36, level: 'medium', region: 'levant' },
          // Non-region hex — must be excluded
          { h3: 'h4', lat: 50, lon: 10, level: 'high', region: 'western-europe' },
        ],
      },
    };
    const out = buildAirspace('mena', sources);
    assert.equal(out.length, 1);
    assert.equal(out[0].airspace_id, 'gpsjam:mena');
    assert.equal(out[0].status, 'restricted');
    assert.match(out[0].reason, /iran-iraq.*levant|levant.*iran-iraq/);
    assert.match(out[0].reason, /2 high/);
    assert.match(out[0].reason, /1 medium/);
  });

  it('returns empty when region has no matching hexes', () => {
    const sources = {
      'intelligence:gpsjam:v2': {
        hexes: [
          { h3: 'h1', lat: 30, lon: 45, level: 'high', region: 'iran-iraq' },
        ],
      },
    };
    assert.deepEqual(buildAirspace('latam', sources), []);
  });

  it('handles low-only hexes as restricted (GPS jam affects RNAV)', () => {
    const sources = {
      'intelligence:gpsjam:v2': {
        hexes: [
          { h3: 'h1', lat: 30, lon: 45, level: 'low', region: 'iran-iraq' },
        ],
      },
    };
    const out = buildAirspace('mena', sources);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'restricted');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildRerouteIntensity
// ────────────────────────────────────────────────────────────────────────────

describe('buildRerouteIntensity', () => {
  it('returns 0 when no military flights', () => {
    assert.equal(buildRerouteIntensity('mena', {}), 0);
    assert.equal(buildRerouteIntensity('mena', { 'military:flights:v1': { flights: [] } }), 0);
  });

  it('counts only flights whose lat/lon maps to the requested region', () => {
    const sources = {
      'military:flights:v1': {
        flights: [
          { lat: 32, lon: 35, operator: 'iaf' },     // MENA
          { lat: 31, lon: 34, operator: 'iaf' },     // MENA
          { lat: 35, lon: 139, operator: 'jsdf' },   // East Asia
          { lat: 52, lon: 13, operator: 'gaf' },     // Europe
        ],
      },
    };
    const mena = buildRerouteIntensity('mena', sources);
    assert.ok(mena > 0 && mena < 1);
    // 2 flights / 50 = 0.04
    assert.equal(Math.round(mena * 1000) / 1000, 0.04);
  });

  it('saturates at 1.0 for large flight counts', () => {
    const flights = Array.from({ length: 100 }, () => ({ lat: 32, lon: 35 }));
    const sources = { 'military:flights:v1': { flights } };
    assert.equal(buildRerouteIntensity('mena', sources), 1);
  });

  it('ignores flights with missing lat/lon', () => {
    const sources = {
      'military:flights:v1': {
        flights: [
          { operator: 'x' }, // no coords
          { lat: null, lon: 35 },
          { lat: 32, lon: 35 },
        ],
      },
    };
    // Only the last flight counts (1/50 = 0.02)
    assert.equal(buildRerouteIntensity('mena', sources), 0.02);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildNotamClosures
// ────────────────────────────────────────────────────────────────────────────

describe('buildNotamClosures', () => {
  it('returns empty when no NOTAM source present', () => {
    assert.deepEqual(buildNotamClosures('mena', {}), []);
    assert.deepEqual(buildNotamClosures('mena', { 'aviation:notam:closures:v2': {} }), []);
  });

  it('emits reason strings for airports in the region that have NOTAMs', () => {
    const sources = {
      'aviation:notam:closures:v2': {
        closedIcaos: ['OMDB', 'EGLL'],
        restrictedIcaos: [],
        reasons: {
          OMDB: 'Runway closure until 06:00 UTC',
          EGLL: 'Fuel contamination alert',
        },
      },
      'aviation:delays:intl:v3': {
        alerts: [
          { iata: 'DXB', icao: 'OMDB', country: 'UAE', region: 'AIRPORT_REGION_MENA', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR', reason: 'x' },
          { iata: 'LHR', icao: 'EGLL', country: 'UK', region: 'AIRPORT_REGION_EUROPE', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR', reason: 'x' },
        ],
      },
    };
    const mena = buildNotamClosures('mena', sources);
    assert.equal(mena.length, 1);
    assert.match(mena[0], /OMDB.*Runway closure/);

    const europe = buildNotamClosures('europe', sources);
    assert.equal(europe.length, 1);
    assert.match(europe[0], /EGLL.*Fuel contamination/);
  });

  it('skips NOTAMs whose ICAO can\'t be attributed to a region', () => {
    const sources = {
      'aviation:notam:closures:v2': {
        closedIcaos: ['ZZZZ'],
        reasons: { ZZZZ: 'Unknown' },
      },
      // No airport alert maps ZZZZ to a region
    };
    assert.deepEqual(buildNotamClosures('mena', sources), []);
  });

  it('truncates very long reason strings to 200 chars', () => {
    const longReason = 'x'.repeat(500);
    const sources = {
      'aviation:notam:closures:v2': {
        closedIcaos: ['OMDB'],
        reasons: { OMDB: longReason },
      },
      'aviation:delays:intl:v3': {
        alerts: [
          { iata: 'DXB', icao: 'OMDB', country: 'UAE', region: 'AIRPORT_REGION_MENA', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR', reason: 'x' },
        ],
      },
    };
    const out = buildNotamClosures('mena', sources);
    // "OMDB: " prefix + 200 truncated chars
    assert.ok(out[0].length <= 'OMDB: '.length + 200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildMobilityState (top-level composer)
// ────────────────────────────────────────────────────────────────────────────

describe('buildMobilityState', () => {
  it('returns a fully-populated shape matching the proto', () => {
    const sources = {
      'aviation:delays:faa:v1': { alerts: [alert({ iata: 'JFK', severity: 'FLIGHT_DELAY_SEVERITY_MAJOR' })] },
      'aviation:delays:intl:v3': { alerts: [] },
      'aviation:notam:closures:v2': { closedIcaos: [], reasons: {} },
      'intelligence:gpsjam:v2': { hexes: [{ h3: 'h1', lat: 40, lon: -74, level: 'high', region: 'north-america' }] },
      'military:flights:v1': { flights: [{ lat: 40, lon: -74 }] },
    };
    const state = buildMobilityState('north-america', sources);
    assert.ok(Array.isArray(state.airspace));
    assert.equal(state.airspace.length, 1);
    assert.ok(Array.isArray(state.flight_corridors));
    assert.equal(state.flight_corridors.length, 0);
    assert.ok(Array.isArray(state.airports));
    assert.equal(state.airports.length, 1);
    assert.ok(typeof state.reroute_intensity === 'number');
    assert.ok(state.reroute_intensity >= 0 && state.reroute_intensity <= 1);
    assert.ok(Array.isArray(state.notam_closures));
  });

  it('returns empty shape when all sources are missing', () => {
    const state = buildMobilityState('mena', {});
    assert.deepEqual(state, {
      airspace: [],
      flight_corridors: [],
      airports: [],
      reroute_intensity: 0,
      notam_closures: [],
    });
  });

  it('never throws on malformed source objects', () => {
    const garbage = {
      'aviation:delays:faa:v1': 'not an object',
      'aviation:delays:intl:v3': 42,
      'aviation:notam:closures:v2': null,
      'intelligence:gpsjam:v2': { hexes: 'also not an array' },
      'military:flights:v1': { flights: null },
    };
    assert.doesNotThrow(() => buildMobilityState('mena', garbage));
    const state = buildMobilityState('mena', garbage);
    assert.deepEqual(state, {
      airspace: [],
      flight_corridors: [],
      airports: [],
      reroute_intensity: 0,
      notam_closures: [],
    });
  });

  it('isolates regions — data for one region does not leak into another', () => {
    const sources = {
      'aviation:delays:faa:v1': {
        alerts: [alert({ iata: 'JFK', icao: 'KJFK', country: 'USA' })],
      },
      'intelligence:gpsjam:v2': {
        hexes: [{ h3: 'h1', lat: 32, lon: 35, level: 'high', region: 'iran-iraq' }],
      },
      'military:flights:v1': {
        flights: [{ lat: 40, lon: -74 }, { lat: 32, lon: 35 }],
      },
    };
    const na = buildMobilityState('north-america', sources);
    const mena = buildMobilityState('mena', sources);
    // NA gets its airport and its military flight, MENA doesn't
    assert.equal(na.airports.length, 1);
    assert.equal(mena.airports.length, 0);
    // MENA gets its airspace and its military flight, NA doesn't get MENA airspace
    assert.equal(mena.airspace.length, 1);
    assert.equal(na.airspace.length, 0);
    assert.ok(na.reroute_intensity > 0);
    assert.ok(mena.reroute_intensity > 0);
  });
});
