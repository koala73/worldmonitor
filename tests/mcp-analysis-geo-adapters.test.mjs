import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  earthquakesToGeoEvents,
  MCP_GEO_PLACES,
  militaryFlightsToGeoEvents,
  unrestEventsToGeoEvents,
  usniVesselsToGeoEvents,
} from '../shared/analysis-mcp-adapters.ts';
import { GeoConvergenceEngine } from '../shared/analysis-geo-convergence.ts';

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('geo-convergence seed adapters', () => {
  const unrest = () => ({
    events: [
      { id: 'acled-1', location: { latitude: 32.4, longitude: 35.2 }, occurredAt: NOW - 2 * HOUR },
      { id: 'acled-2', location: { latitude: 32.9, longitude: 35.8 }, occurredAt: NOW - 5 * HOUR },
    ],
  });

  const flights = () => ({
    flights: [
      { id: 'opensky-ae1', lat: 32.1, lon: 35.4, lastSeenMs: NOW - 10 * MIN, aircraftType: 'fighter' },
      { id: 'opensky-ae2', lat: 32.7, lon: 35.1, lastSeenMs: NOW - 20 * MIN, aircraftType: 'tanker' },
    ],
    fetchedAt: NOW - 5 * MIN,
  });

  const quakes = () => ({
    earthquakes: [
      { id: 'us1', location: { latitude: 32.2, longitude: 35.9 }, occurredAt: NOW - 3 * HOUR, magnitude: 4.1 },
    ],
  });

  const fleet = () => ({
    vessels: [
      { name: 'USS Example', hullNumber: 'DDG-1', vesselType: 'destroyer', region: 'Mediterranean Sea', regionLat: 32.5, regionLon: 35.5 },
    ],
    timestamp: NOW - 90 * MIN,
  });

  it('maps every seeded domain onto the core GeoEventInput shape', () => {
    assert.deepEqual(unrestEventsToGeoEvents(unrest(), { now: NOW }), [
      { lat: 32.4, lon: 35.2, time: NOW - 2 * HOUR },
      { lat: 32.9, lon: 35.8, time: NOW - 5 * HOUR },
    ]);
    assert.deepEqual(militaryFlightsToGeoEvents(flights(), { now: NOW }), [
      { lat: 32.1, lon: 35.4, time: NOW - 10 * MIN },
      { lat: 32.7, lon: 35.1, time: NOW - 20 * MIN },
    ]);
    assert.deepEqual(earthquakesToGeoEvents(quakes(), { now: NOW }), [
      { lat: 32.2, lon: 35.9, time: NOW - 3 * HOUR },
    ]);
    assert.deepEqual(usniVesselsToGeoEvents(fleet(), { now: NOW }), [
      { lat: 32.5, lon: 35.5, time: NOW - 90 * MIN },
    ]);
  });

  it('returns [] for null, empty and wrong-shaped payloads', () => {
    for (const adapter of [unrestEventsToGeoEvents, militaryFlightsToGeoEvents, earthquakesToGeoEvents, usniVesselsToGeoEvents]) {
      assert.deepEqual(adapter(null, { now: NOW }), []);
      assert.deepEqual(adapter(undefined, { now: NOW }), []);
      assert.deepEqual(adapter({}, { now: NOW }), []);
      assert.deepEqual(adapter({ events: 'nope', flights: 'nope', earthquakes: 'nope', vessels: 'nope' }, { now: NOW }), []);
      assert.deepEqual(adapter([], { now: NOW }), []);
    }
  });

  it('drops malformed coordinates, out-of-range values and null-island entries', () => {
    const payload = {
      events: [
        { location: { latitude: 'x', longitude: 35 }, occurredAt: NOW },
        { location: { latitude: 32, longitude: null }, occurredAt: NOW },
        { location: null, occurredAt: NOW },
        null,
        { location: { latitude: 91, longitude: 10 }, occurredAt: NOW },
        { location: { latitude: 10, longitude: 181 }, occurredAt: NOW },
        { location: { latitude: 0, longitude: 0 }, occurredAt: NOW },
        { location: { latitude: 32.4, longitude: 35.2 }, occurredAt: NOW },
      ],
    };
    assert.deepEqual(unrestEventsToGeoEvents(payload, { now: NOW }), [
      { lat: 32.4, lon: 35.2, time: NOW },
    ]);
  });

  it('drops events older than the convergence window', () => {
    const payload = {
      earthquakes: [
        { location: { latitude: 32.2, longitude: 35.9 }, occurredAt: NOW - 40 * HOUR },
        { location: { latitude: 32.3, longitude: 35.8 }, occurredAt: NOW - 3 * HOUR },
      ],
    };
    assert.deepEqual(earthquakesToGeoEvents(payload, { now: NOW }), [
      { lat: 32.3, lon: 35.8, time: NOW - 3 * HOUR },
    ]);
  });

  it('falls back to the payload timestamp when a record carries no usable time', () => {
    const payload = { flights: [{ lat: 32.1, lon: 35.4 }], fetchedAt: NOW - 7 * MIN };
    assert.deepEqual(militaryFlightsToGeoEvents(payload, { now: NOW }), [
      { lat: 32.1, lon: 35.4, time: NOW - 7 * MIN },
    ]);
  });

  it('feeds a real engine to a real multi-domain convergence alert', () => {
    const engine = new GeoConvergenceEngine({ now: () => NOW, convergenceThreshold: 3 });
    engine.ingestEvents(unrestEventsToGeoEvents(unrest(), { now: NOW }), 'protest');
    engine.ingestEvents(militaryFlightsToGeoEvents(flights(), { now: NOW }), 'military_flight');
    engine.ingestEvents(earthquakesToGeoEvents(quakes(), { now: NOW }), 'earthquake');
    engine.ingestEvents(usniVesselsToGeoEvents(fleet(), { now: NOW }), 'military_vessel');

    const alerts = engine.detect(new Set());
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].cellId, '32,35');
    assert.deepEqual([...alerts[0].types].sort(), ['earthquake', 'military_flight', 'military_vessel', 'protest']);
    assert.equal(alerts[0].totalEvents, 6);
  });

  it('exposes named-place datasets that reverse-geocode a coordinate', () => {
    assert.ok(Array.isArray(MCP_GEO_PLACES.conflictZones) && MCP_GEO_PLACES.conflictZones.length > 0);
    assert.ok(Array.isArray(MCP_GEO_PLACES.waterways) && MCP_GEO_PLACES.waterways.length > 0);
    assert.ok(Array.isArray(MCP_GEO_PLACES.hotspots) && MCP_GEO_PLACES.hotspots.length > 0);
    for (const w of MCP_GEO_PLACES.waterways) {
      assert.equal(typeof w.name, 'string');
      assert.equal(typeof w.lat, 'number');
      assert.equal(typeof w.lon, 'number');
    }
    for (const z of MCP_GEO_PLACES.conflictZones) {
      assert.ok(Array.isArray(z.center) && z.center.length === 2);
    }
  });
});
