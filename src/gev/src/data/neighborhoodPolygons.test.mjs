// src/data/neighborhoodPolygons.test.mjs — pins the bundled DataSF "Analysis
// Neighborhoods" dataset (PDDL 1.0, see local_data/neighborhoods/SOURCE.md) and
// its resolution contract through the source-agnostic loader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupNeighborhoodRing } from './neighborhoodPolygons.js';

const FILE = new URL('./local_data/neighborhoods/san-francisco.json', import.meta.url);

// SF proper + Treasure Island; generous but excludes everything non-SF.
const SF_BOUNDS = { west: -122.55, south: 37.70, east: -122.35, north: 37.84 };

function eachRing(geometry, fn) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) for (const ring of poly) fn(ring);
}

test('SF neighborhoods file parses with the expected DataSF shape', () => {
  const fc = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.city, 'San Francisco');
  // DataSF Analysis Neighborhoods is exactly 41 areas (dataset j2bu-swwd).
  assert.equal(fc.features.length, 41);
  for (const f of fc.features) {
    const name = f.properties && f.properties.name;
    assert.ok(typeof name === 'string' && name.trim().length > 0,
      `every feature has a non-empty properties.name (got ${JSON.stringify(name)})`);
    assert.ok(f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
      `${name}: geometry is Polygon|MultiPolygon`);
    eachRing(f.geometry, (ring) => {
      assert.ok(ring.length >= 4, `${name}: ring has >= 4 points`);
      const [f0, l0] = [ring[0], ring[ring.length - 1]];
      assert.ok(f0[0] === l0[0] && f0[1] === l0[1], `${name}: ring is closed`);
      for (const [lon, lat] of ring) {
        assert.ok(lon >= SF_BOUNDS.west && lon <= SF_BOUNDS.east
          && lat >= SF_BOUNDS.south && lat <= SF_BOUNDS.north,
          `${name}: coordinate [${lon}, ${lat}] inside SF bounds`);
      }
    });
  }
});

test('the five demo neighborhoods resolve to real polygons through the loader', async () => {
  const cases = [
    // [lat, lon, geocoder-style query, expected dataset name]
    [37.7941, -122.4078, 'Chinatown', 'Chinatown'],
    [37.8021, -122.4369, 'Marina District', 'Marina'],
    [37.7599, -122.4148, 'Mission District', 'Mission'],
    [37.7989, -122.4662, 'Presidio', 'Presidio'],
    [37.7785, -122.4056, 'South of Market', 'South of Market'],
  ];
  for (const [lat, lon, query, expected] of cases) {
    const hit = await lookupNeighborhoodRing(lat, lon, query);
    assert.ok(hit, `${query} must resolve`);
    assert.equal(hit.name, expected);
    assert.ok(Array.isArray(hit.ring) && hit.ring.length >= 4,
      `${query}: real ring, not a synthesized disc (got ${hit.ring && hit.ring.length} pts)`);
    for (const [rlon, rlat] of hit.ring) {
      assert.ok(rlon >= SF_BOUNDS.west && rlon <= SF_BOUNDS.east
        && rlat >= SF_BOUNDS.south && rlat <= SF_BOUNDS.north,
        `${query}: ring stays inside SF bounds`);
    }
  }
});

test('name specificity: Presidio vs Presidio Heights, Mission vs Outer Mission', async () => {
  // "Presidio Heights" must NOT collapse onto the (larger) Presidio.
  const heights = await lookupNeighborhoodRing(37.7886, -122.4531, 'Presidio Heights');
  assert.equal(heights?.name, 'Presidio Heights');
  // Bare "Mission" query must not match "Outer Mission"/"Mission Bay".
  const mission = await lookupNeighborhoodRing(37.7599, -122.4148, 'Mission');
  assert.equal(mission?.name, 'Mission');
});

test('points outside covered cities / unmatched names return null', async () => {
  // Austin, TX — outside every bundled city bbox.
  assert.equal(await lookupNeighborhoodRing(30.2672, -97.7431, 'Downtown'), null);
  // Inside SF but a name the dataset does not carry — no point-in-polygon fallback.
  assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, 'Zilker Park'), null);
});

test('taxonomy aliases: old names reach the renamed DataSF polygon', async () => {
  // DataSF renamed "Financial District" → "Financial District/South Beach";
  // the word-subset matcher alone can never bridge that (P0-2 alias map).
  const fidi = await lookupNeighborhoodRing(37.7946, -122.3999, 'Financial District');
  assert.equal(fidi?.name, 'Financial District/South Beach');
  // Colloquial "Downtown" (in SF) maps to the same polygon.
  const downtown = await lookupNeighborhoodRing(37.7946, -122.3999, 'Downtown');
  assert.equal(downtown?.name, 'Financial District/South Beach');
  // "Downtown/Civic Center" deliberately has NO alias — the taxonomy split it,
  // and a confident wrong polygon would block the live resolver ladder.
  assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, 'Downtown/Civic Center'), null);
});
