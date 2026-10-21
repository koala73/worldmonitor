import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findNearestHazard, haversineKm } from '../scripts/seed-chokepoint-flows.mjs';
import { adaptDisruptionFeature } from '../scripts/seed-portwatch-disruptions.mjs';

// The seeder-source and hazard-integration assertions that used to open this
// file restated export declarations, Redis keys, and the ArcGIS query string.
// parseAffectedPorts, isActive, haversineKm and findNearestHazard were all
// re-implemented in this file and tested as copies; every one of them is now
// imported from the code that actually runs in the seeder.

describe('adaptDisruptionFeature', () => {
  const base = { eventid: 1, alertlevel: 'red', lat: 1, long: 2 };

  it('splits affectedports on commas and trims each entry', () => {
    const event = adaptDisruptionFeature({ ...base, affectedports: 'port137,port138, port139' });
    assert.deepEqual(event.affectedPorts, ['port137', 'port138', 'port139']);
  });

  it('drops empty segments rather than emitting blank port ids', () => {
    const event = adaptDisruptionFeature({ ...base, affectedports: 'port137,,  ,port138,' });
    assert.deepEqual(event.affectedPorts, ['port137', 'port138']);
  });

  it('reports no affected ports when the field is absent or empty', () => {
    assert.deepEqual(adaptDisruptionFeature(base).affectedPorts, []);
    assert.deepEqual(adaptDisruptionFeature({ ...base, affectedports: '' }).affectedPorts, []);
  });

  it('treats an event with a future end date as active', () => {
    const now = Date.now();
    assert.equal(adaptDisruptionFeature({ ...base, todate: now + 86_400_000 }, now).active, true);
  });

  it('treats an event whose end date has passed as inactive', () => {
    const now = Date.now();
    assert.equal(adaptDisruptionFeature({ ...base, todate: now - 86_400_000 }, now).active, false);
  });

  it('treats an open-ended event with no end date as active', () => {
    assert.equal(adaptDisruptionFeature(base).active, true);
  });

  it('upper-cases the alert level so hazard matching can compare it', () => {
    // findNearestHazard filters on 'RED' / 'ORANGE'; a lower-case feed value
    // would silently never match.
    assert.equal(adaptDisruptionFeature({ ...base, alertlevel: 'orange' }).alertLevel, 'ORANGE');
  });

  it('coerces missing coordinates and counts to numbers, not undefined', () => {
    const event = adaptDisruptionFeature({ eventid: 7 });
    assert.equal(event.lat, 0);
    assert.equal(event.lon, 0);
    assert.equal(event.affectedPortCount, 0);
    assert.equal(event.toDate, null);
  });
});


describe('hazard matching', () => {
  const hormuzLat = 26.56;
  const hormuzLon = 56.25;

  it('matches RED event within 500km of chokepoint', () => {
    const events = [{ alertLevel: 'RED', active: true, lat: 25.0, lon: 57.0, eventName: 'CYCLONE-X' }];
    const dist = haversineKm(hormuzLat, hormuzLon, 25.0, 57.0);
    assert.ok(dist < 500, `event should be within 500km (${dist.toFixed(1)}km)`);
    assert.ok(findNearestHazard(events, hormuzLat, hormuzLon) !== null);
  });

  it('does NOT match event beyond 500km', () => {
    // Mumbai: ~1600km from Hormuz
    const events = [{ alertLevel: 'RED', active: true, lat: 19.0, lon: 72.8, eventName: 'FAR-FLOOD' }];
    const dist = haversineKm(hormuzLat, hormuzLon, 19.0, 72.8);
    assert.ok(dist > 500, `event should be beyond 500km (${dist.toFixed(1)}km)`);
    assert.equal(findNearestHazard(events, hormuzLat, hormuzLon), null);
  });

  it('does NOT match YELLOW or GREEN alerts', () => {
    const events = [{ alertLevel: 'YELLOW', active: true, lat: 25.0, lon: 57.0, eventName: 'YELLOW-EV' }];
    assert.equal(findNearestHazard(events, hormuzLat, hormuzLon), null);
  });

  it('does NOT match inactive (ended) events', () => {
    const events = [{ alertLevel: 'RED', active: false, lat: 25.0, lon: 57.0, eventName: 'OLD-EV' }];
    assert.equal(findNearestHazard(events, hormuzLat, hormuzLon), null);
  });

  it('returns closest RED/ORANGE event when multiple qualify', () => {
    const events = [
      { alertLevel: 'ORANGE', active: true, lat: 26.0, lon: 56.5, eventName: 'CLOSE-FLOOD' },
      { alertLevel: 'RED',    active: true, lat: 24.0, lon: 58.0, eventName: 'FAR-STORM' },
    ];
    const result = findNearestHazard(events, hormuzLat, hormuzLon);
    assert.equal(result?.eventName, 'CLOSE-FLOOD', 'should return closest qualifying event');
  });

  it('returns null when events array is empty or absent', () => {
    assert.equal(findNearestHazard([], hormuzLat, hormuzLon), null);
    assert.equal(findNearestHazard(null, hormuzLat, hormuzLon), null);
  });
});
