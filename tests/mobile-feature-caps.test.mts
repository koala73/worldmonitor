/**
 * #4545 — the mobile density caps, as executable behaviour.
 *
 * `map-mobile-feature-caps.test.mjs` asserts the SVG renderer's source text and
 * the dispatch wiring; it cannot check what the caps actually do. These call the
 * REAL predicates every renderer now routes through, against the real payload
 * shapes (`Earthquake` from seismology/v1, `IranEvent` from conflict/v1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOBILE_MAX_IRAN_EVENTS,
  MOBILE_MIN_EARTHQUAKE_MAGNITUDE,
  capEarthquakesForMobile,
  capIranEventsForMobile,
} from '../src/utils/mobile-feature-caps.ts';

/** Real `Earthquake` shape; only `magnitude` varies per case. */
function quake(magnitude: number | undefined, i = 0) {
  return {
    id: `eq-${i}`,
    place: `Test Quake ${i}`,
    magnitude: magnitude as number,
    depthKm: 10,
    location: { latitude: 20 + i, longitude: 40 + i },
    occurredAt: Date.now(),
    sourceUrl: '',
    source: 'usgs',
    category: 'seismic',
  };
}

/** Real `IranEvent` shape. */
function iranEvent(i: number) {
  return {
    id: `iran-${i}`,
    title: `Test Event ${i}`,
    category: 'strike',
    sourceUrl: '',
    latitude: 32 + (i % 10) * 0.3,
    longitude: 53 + (i % 10) * 0.3,
    locationName: 'Test Location',
    timestamp: new Date().toISOString(),
    severity: 'moderate',
  };
}

describe('mobile density caps (#4463 / #4545)', () => {
  it('pins the signed-off thresholds', () => {
    assert.equal(MOBILE_MIN_EARTHQUAKE_MAGNITUDE, 5);
    assert.equal(MOBILE_MAX_IRAN_EVENTS, 50);
  });

  describe('capEarthquakesForMobile', () => {
    it('keeps exactly M5.0 — the threshold is inclusive', () => {
      const kept = capEarthquakesForMobile([quake(5)], true);
      assert.equal(kept.length, 1, 'M5.0 is at the floor, not below it');
    });

    it('drops the M4.5-4.9 band the production seeder actually supplies', () => {
      // scripts/seed-earthquakes.mjs ingests USGS 4.5_week.geojson, so this band
      // is the entire population the cap removes.
      const feed = [4.5, 4.6, 4.7, 4.8, 4.9].map((m, i) => quake(m, i));
      assert.deepEqual(capEarthquakesForMobile(feed, true), []);
    });

    it('drops an earthquake with no magnitude rather than coercing it through', () => {
      assert.deepEqual(capEarthquakesForMobile([quake(undefined)], true), []);
    });

    it('splits a mixed feed at the floor and preserves feed order', () => {
      const feed = [4.9, 6.1, 4.5, 5.0, 7.2].map((m, i) => quake(m, i));
      assert.deepEqual(
        capEarthquakesForMobile(feed, true).map((eq) => eq.magnitude),
        [6.1, 5.0, 7.2],
      );
    });

    it('passes the feed through untouched off mobile', () => {
      const feed = [1.2, 4.9, 6.1].map((m, i) => quake(m, i));
      assert.equal(capEarthquakesForMobile(feed, false), feed, 'desktop must not even copy');
    });

    it('is idempotent — MapContainer may cap before a renderer that caps again', () => {
      const feed = [4.9, 6.1, 5.0].map((m, i) => quake(m, i));
      const once = capEarthquakesForMobile(feed, true);
      assert.deepEqual(capEarthquakesForMobile(once, true), once);
    });

    it('does not mutate the caller\'s array — MapContainer caches the raw feed', () => {
      const feed = [4.9, 6.1].map((m, i) => quake(m, i));
      capEarthquakesForMobile(feed, true);
      assert.equal(feed.length, 2);
    });
  });

  describe('capIranEventsForMobile', () => {
    it('keeps a feed of exactly the cap whole', () => {
      const feed = Array.from({ length: MOBILE_MAX_IRAN_EVENTS }, (_, i) => iranEvent(i));
      assert.equal(capIranEventsForMobile(feed, true).length, MOBILE_MAX_IRAN_EVENTS);
    });

    it('cuts one over the cap down to the cap', () => {
      const feed = Array.from({ length: MOBILE_MAX_IRAN_EVENTS + 1 }, (_, i) => iranEvent(i));
      const capped = capIranEventsForMobile(feed, true);
      assert.equal(capped.length, MOBILE_MAX_IRAN_EVENTS);
      assert.equal(capped[capped.length - 1].id, `iran-${MOBILE_MAX_IRAN_EVENTS - 1}`, 'keeps the head');
    });

    it('cuts the 80-event case from the issue repro', () => {
      const feed = Array.from({ length: 80 }, (_, i) => iranEvent(i));
      assert.equal(capIranEventsForMobile(feed, true).length, 50);
    });

    it('leaves a short feed and an empty feed alone', () => {
      const feed = [iranEvent(0), iranEvent(1)];
      assert.equal(capIranEventsForMobile(feed, true), feed);
      assert.deepEqual(capIranEventsForMobile([], true), []);
    });

    it('passes the feed through untouched off mobile', () => {
      const feed = Array.from({ length: 80 }, (_, i) => iranEvent(i));
      assert.equal(capIranEventsForMobile(feed, false), feed);
    });

    it('is idempotent', () => {
      const feed = Array.from({ length: 80 }, (_, i) => iranEvent(i));
      const once = capIranEventsForMobile(feed, true);
      assert.deepEqual(capIranEventsForMobile(once, true), once);
    });
  });

  describe('the gap the issue reported', () => {
    it('leaves globe and SVG showing the same markers for the repro payloads', () => {
      // The issue's expected/actual table: 2D showed 10 quakes and 50 Iran
      // events where 3D showed 20 and 80. Both renderers now derive their feed
      // from these predicates, so the two columns are the same numbers.
      const quakes = Array.from({ length: 20 }, (_, i) =>
        quake(i < 10 ? 2 + i * 0.2 : 5 + (i - 10) * 0.3, i));
      const events = Array.from({ length: 80 }, (_, i) => iranEvent(i));

      assert.equal(capEarthquakesForMobile(quakes, true).length, 10);
      assert.equal(capIranEventsForMobile(events, true).length, 50);
    });
  });
});
