// Cloudflare Radar rows are placed on the map by country. A traffic anomaly
// whose country could not be resolved was published at 0,0 and then hidden
// by the map, and outages / DDoS targets in an unlisted country were dropped.
// On 2026-10-05 that hid 22 of 26 live anomalies: every ISP-level (type AS)
// anomaly, plus Lesotho and Eswatini.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { COUNTRY_COORDS, mapTrafficAnomaly } from '../scripts/lib/radar-country-coords.mjs';

const bboxes = JSON.parse(readFileSync(new URL('../scripts/shared/country-bboxes.json', import.meta.url), 'utf8'));

describe('Cloudflare Radar country coordinates', () => {
  it('cover every country the shared bounding-box table knows', () => {
    assert.deepEqual(Object.keys(bboxes).filter((code) => !COUNTRY_COORDS[code]), []);
  });

  it('fall inside that country\'s bounding box', () => {
    for (const [code, [lat, lon]] of Object.entries(COUNTRY_COORDS)) {
      const box = bboxes[code];
      if (!box) continue;
      const [south, west, north, east] = box;
      const inLon = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
      assert.ok(lat >= south && lat <= north && inLon, `${code} at ${lat},${lon} outside ${box}`);
    }
  });

  it('places an ISP-level anomaly in the ASN\'s country', () => {
    const row = mapTrafficAnomaly({
      uuid: 'a', type: 'AS', status: 'UNVERIFIED', startDate: '2026-10-05T00:00:00Z',
      asnDetails: { asn: '15964', name: 'CAMNET-AS', location: { code: 'CM', name: 'Cameroon' } },
    });
    assert.deepEqual([row.latitude, row.longitude], COUNTRY_COORDS.CM);
    assert.equal(row.asnName, 'CAMNET-AS');
  });

  it('places a country-level anomaly in Lesotho', () => {
    const row = mapTrafficAnomaly({
      uuid: 'b', type: 'LOCATION', status: 'UNVERIFIED', startDate: '2026-10-05T00:00:00Z',
      locationDetails: { code: 'LS', name: 'Lesotho' },
    });
    assert.deepEqual([row.latitude, row.longitude], COUNTRY_COORDS.LS);
  });
});
