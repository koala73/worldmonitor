// Items a source locates only by country must carry that country's position,
// not 0,0. On 2026-10-05 the live API returned 33 country-located disease
// outbreaks and a Cabo Verde flood at 0,0 (the Gulf of Guinea).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { countryCentroid } from '../scripts/lib/country-centroid.mjs';
import { mapItem, rssNormalizeItem, tghNormalizeItem, whoNormalizeItem } from '../scripts/_disease-outbreaks-helpers.mjs';
import { mapReliefItem } from '../scripts/seed-climate-disasters.mjs';

const bboxes = JSON.parse(readFileSync(new URL('../scripts/shared/country-bboxes.json', import.meta.url), 'utf8'));
const centroids = JSON.parse(readFileSync(new URL('../scripts/data/country-centroids.json', import.meta.url), 'utf8'));

describe('country centroid table', () => {
  it('is regenerated from the committed boundaries', () => {
    const script = fileURLToPath(new URL('../scripts/build-country-centroids.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  });

  it('covers every country with a bounding box, inside that box', () => {
    assert.deepEqual(Object.keys(bboxes).filter((code) => !centroids[code]), []);
    for (const [code, [south, west, north, east]] of Object.entries(bboxes)) {
      const [lat, lon] = centroids[code];
      const inLon = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
      assert.ok(lat >= south && lat <= north && inLon, `${code} at ${lat},${lon} outside ${[south, west, north, east]}`);
    }
  });

  it('covers small states the bounding-box table lacks', () => {
    for (const code of ['CV', 'SG', 'MT', 'BH', 'MV', 'HK']) {
      const point = countryCentroid(code);
      assert.ok(point && !(point.lat === 0 && point.lng === 0), code);
    }
  });
});

describe('disease outbreak positions', () => {
  it('places a country-only headline at the country', () => {
    const item = mapItem(rssNormalizeItem({
      title: 'Measles outbreak in Israel grows', link: 'https://www.cidrap.umn.edu/x', desc: '',
      pubDate: 'Mon, 14 Sep 2026 15:25:00 -0500', sourceName: 'CIDRAP',
    }));
    assert.equal(item.countryCode, 'IL');
    assert.deepEqual({ lat: item.lat, lng: item.lng }, countryCentroid('IL'));
  });

  it('keeps a source-supplied point', () => {
    const item = mapItem(tghNormalizeItem({
      Alert_ID: '1', lat: 12.3, lng: 45.6, disease: 'Cholera', country: 'Yemen',
      date: '4/23/2026', sourceUrl: 'http://x', summary: 's', cases: '5',
    }));
    assert.deepEqual({ lat: item.lat, lng: item.lng }, { lat: 12.3, lng: 45.6 });
  });

  it('leaves an item with no country unlocated', () => {
    const item = mapItem(whoNormalizeItem({ Title: 'Global influenza update', ItemDefaultUrl: '/x', PublicationDateAndTime: '2026-09-10T08:00:00Z' }));
    assert.equal(item.countryCode, '');
    assert.deepEqual({ lat: item.lat, lng: item.lng }, { lat: 0, lng: 0 });
  });
});

describe('climate disaster positions', () => {
  it('places a ReliefWeb disaster in a small island state', () => {
    const row = mapReliefItem({
      id: 1,
      fields: {
        name: 'Cabo Verde: Flash Floods - Aug 2025', status: 'ongoing',
        type: [{ code: 'FF', name: 'Flash Flood', primary: true }],
        primary_country: [{ iso3: 'cpv', shortname: 'Cabo Verde' }],
        date: { event: '2025-08-11T00:00:00+00:00' },
      },
    });
    assert.equal(row.countryCode, 'CV');
    assert.deepEqual({ lat: row.lat, lng: row.lng }, countryCentroid('CV'));
  });
});
