// Every airport the aviation seeder publishes must carry its real position.
// FAA-only registry rows once had no lat/lon, so their delay and "Normal
// operations" alerts were written at 0,0 and the map drew Portland (PDX) and
// 22 other US airports in the Gulf of Guinea.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AIRPORTS, buildDelaysBootstrapPayload, buildFaaAlerts } from '../scripts/seed-aviation.mjs';

const isNullIsland = (lat, lon) => lat === 0 && lon === 0;

// Literal reference points, not read back from the registry under test.
const PDX = { lat: 45.5898, lon: -122.5951 };
const HNL = { lat: 21.3187, lon: -157.9225 };

describe('aviation airport coordinates', () => {
  it('every seeder registry row has finite, non-placeholder coordinates', () => {
    const missing = AIRPORTS.filter(
      (a) => !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || isNullIsland(a.lat, a.lon),
    ).map((a) => a.iata);
    assert.deepEqual(missing, []);
  });

  it('FAA-only rows sit inside the United States', () => {
    for (const a of AIRPORTS.filter((r) => r.country === 'USA')) {
      // Contiguous US, Alaska and Hawaii all fall in this box; 0,0 does not.
      assert.ok(a.lat > 18 && a.lat < 72 && a.lon > -180 && a.lon < -66, `${a.iata} at ${a.lat},${a.lon}`);
    }
  });

  it('FAA delay alerts carry the airport position', () => {
    const delays = new Map([
      ['PDX', { airport: 'PDX', reason: 'Weather', avgDelay: 45, type: 'ground_delay' }],
      ['HNL', { airport: 'HNL', reason: 'Volume', avgDelay: 20, type: 'departure_delay' }],
    ]);
    const byIata = Object.fromEntries(buildFaaAlerts(delays).map((a) => [a.iata, a.location]));
    assert.deepEqual(byIata.PDX, { latitude: PDX.lat, longitude: PDX.lon });
    assert.deepEqual(byIata.HNL, { latitude: HNL.lat, longitude: HNL.lon });
  });

  it('the bootstrap payload never places an airport at 0,0', () => {
    const payload = buildDelaysBootstrapPayload({
      faaPayload: { alerts: [] },
      intlPayload: { alerts: [], coverage: [] },
      notamPayload: { closedIcaos: ['KPDX'], restrictedIcaos: [], reasons: {} },
    });
    const placeholders = payload.alerts
      .filter((a) => isNullIsland(a.location.latitude, a.location.longitude))
      .map((a) => a.iata);
    assert.deepEqual(placeholders, []);
    const pdx = payload.alerts.find((a) => a.iata === 'PDX');
    assert.deepEqual(pdx.location, { latitude: PDX.lat, longitude: PDX.lon });
  });
});
