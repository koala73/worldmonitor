// PizzINT sends no lat/lng, so every venue was published at 0,0. The position
// is in the Google Maps place URL it sends as `address`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pizzintVenuePoint } from '../scripts/shared/pizzint-location.cjs';

// Shape PizzINT returned on 2026-10-05 for Extreme Pizza near the Pentagon.
const EXTREME_PIZZA = {
  place_id: 'ChIJcYireCe3t4kR4d9trEbGYjc',
  name: 'Extreme Pizza',
  address: 'https://www.google.com/maps/place/Extreme+Pizza/@38.8602396,-77.0585603,17z/data=!3m1!4b1!4m6!3m5!1s0x89b7b72778ab8871:0x3762c646ac6ddfe1!8m2!3d38.8602396!4d-77.0559854!16s%2Fg%2F12llsn19l?entry=ttu',
};

describe('pizzintVenuePoint', () => {
  it('reads the place pin, not the camera centre', () => {
    assert.deepEqual(pizzintVenuePoint(EXTREME_PIZZA), { lat: 38.8602396, lng: -77.0559854 });
  });

  it('falls back to the camera centre', () => {
    assert.deepEqual(pizzintVenuePoint({ address: 'https://www.google.com/maps/@38.87,-77.05,17z' }), { lat: 38.87, lng: -77.05 });
  });

  it('prefers source coordinates when present', () => {
    assert.deepEqual(pizzintVenuePoint({ ...EXTREME_PIZZA, lat: 38.1, lng: -77.1 }), { lat: 38.1, lng: -77.1 });
  });

  it('returns null for a street address', () => {
    assert.equal(pizzintVenuePoint({ address: '1 Main St, Arlington VA' }), null);
  });
});

describe('PizzINT writers', () => {
  it('seed-conflict-intel publishes the venue point', async (t) => {
    const { fetchPizzintStatus } = await import('../scripts/seed-conflict-intel.mjs');
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      success: true,
      data: [{ ...EXTREME_PIZZA, current_popularity: 40, is_spike: false, data_freshness: 'fresh' }],
    })));
    const status = await fetchPizzintStatus();
    assert.deepEqual(
      { lat: status.locations[0].lat, lng: status.locations[0].lng },
      { lat: 38.8602396, lng: -77.0559854 },
    );
  });
  // The relay writer is covered in tests/pizzint-seed-publication.test.mjs.
});
