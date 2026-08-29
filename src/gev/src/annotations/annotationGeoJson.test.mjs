// Pure round-trip + fail-closed tests for the annotation <-> GeoJSON interchange.
// Run with: npm test   (node --test). No framework, no Cesium, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotationToFeature,
  featureToAnnotation,
  annotationsToFeatureCollection,
  featureCollectionToAnnotations,
} from './annotationGeoJson.js';

// A round-trip preserves the semantic fields (transient render state is intentionally not carried).
const roundTrip = (anno) => featureToAnnotation(annotationToFeature(anno));

test('point (pin/highlight/label) round-trips, height preserved', () => {
  const pin = { type: 'pin', id: 'anno-1', label: 'ILM', color: 'primary', ttlMs: null,
    anchor: { lon: -77.9, lat: 34.27, height: 12 }, to: null, ring: null };
  const f = annotationToFeature(pin);
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [-77.9, 34.27, 12]);
  assert.equal(f.properties['gev:type'], 'pin');
  assert.deepEqual(roundTrip(pin), pin);

  const hl = { type: 'highlight', id: 'anno-2', label: 'spot', color: 'amber', ttlMs: 30000,
    anchor: { lon: 2.29, lat: 48.85 }, to: null, ring: null };
  assert.deepEqual(roundTrip(hl), hl); // no height -> 2D position
});

test('area polygon round-trips: ring closed in GeoJSON, un-closed on import; centroid preserved', () => {
  const area = { type: 'area', id: 'anno-3', label: 'Marina', color: 'primary', ttlMs: null,
    anchor: { lon: -122.434, lat: 37.804 }, to: null,
    ring: [[-122.44, 37.80], [-122.43, 37.81], [-122.42, 37.80], [-122.43, 37.79]],
    footprintKind: 'area', buildingHeight: null, synthesized: false };
  const f = annotationToFeature(area);
  assert.equal(f.geometry.type, 'Polygon');
  const gjRing = f.geometry.coordinates[0];
  assert.equal(gjRing.length, 5); // 4 vertices + explicit closing point
  assert.deepEqual(gjRing[0], gjRing[gjRing.length - 1]); // closed
  assert.deepEqual(f.properties['gev:anchor'], [-122.434, 37.804]);
  assert.deepEqual(roundTrip(area), area); // ring back to 4, anchor from gev:anchor
});

test('synthesized + building props are preserved', () => {
  const synth = { type: 'area', id: 'anno-4', label: 'around', color: 'primary', ttlMs: null,
    anchor: { lon: -97.74, lat: 30.27 }, to: null,
    ring: [[-97.75, 30.27], [-97.74, 30.28], [-97.73, 30.27]],
    footprintKind: 'area', buildingHeight: null, synthesized: true };
  const f = annotationToFeature(synth);
  assert.equal(f.properties['gev:synthesized'], true);
  assert.equal(roundTrip(synth).synthesized, true);

  const bldg = { type: 'area', id: 'anno-5', label: 'Pentagon', color: 'primary', ttlMs: null,
    anchor: { lon: -77.056, lat: 38.871 }, to: null,
    ring: [[-77.057, 38.870], [-77.055, 38.872], [-77.054, 38.870]],
    footprintKind: 'building', buildingHeight: 24, synthesized: false };
  assert.equal(roundTrip(bldg).footprintKind, 'building');
  assert.equal(roundTrip(bldg).buildingHeight, 24);
});

test('route path round-trips with mode/distance/duration', () => {
  const path = [{ lon: -122.4, lat: 37.7, height: 5 }, { lon: -122.39, lat: 37.71, height: 6 }, { lon: -122.38, lat: 37.72, height: 7 }];
  const route = { type: 'route', id: 'anno-6', label: '590 m · 8 min', color: 'primary', ttlMs: null,
    anchor: { lon: -122.4, lat: 37.7, height: 5 }, to: null, ring: null,
    path, mode: 'foot', distanceM: 590, durationS: 480, fallback: false };
  const f = annotationToFeature(route);
  assert.equal(f.geometry.type, 'LineString');
  assert.equal(f.geometry.coordinates.length, 3);
  assert.deepEqual(roundTrip(route), route);
});

test('arrow round-trips (anchor -> to)', () => {
  const arrow = { type: 'arrow', id: 'anno-7', label: '2 km', color: 'primary', ttlMs: null,
    anchor: { lon: -122.43, lat: 37.80, height: 3 }, to: { lon: -122.40, lat: 37.81, height: 4 }, ring: null };
  const f = annotationToFeature(arrow);
  assert.equal(f.geometry.type, 'LineString');
  assert.equal(f.geometry.coordinates.length, 2);
  assert.deepEqual(roundTrip(arrow), arrow);
});

test('degenerate area (no ring) -> Point, round-trips', () => {
  const ptArea = { type: 'area', id: 'anno-8', label: 'X', color: 'primary', ttlMs: null,
    anchor: { lon: 10, lat: 20 }, to: null, ring: null, footprintKind: null, buildingHeight: null, synthesized: false };
  const f = annotationToFeature(ptArea);
  assert.equal(f.geometry.type, 'Point');
  const back = roundTrip(ptArea);
  assert.equal(back.type, 'area');
  assert.equal(back.ring, null);
  assert.deepEqual(back.anchor, { lon: 10, lat: 20 });
});

test('FeatureCollection round-trips a mixed set', () => {
  const annos = [
    { type: 'pin', id: 'a', label: 'p', color: 'primary', ttlMs: null, anchor: { lon: 1, lat: 2 }, to: null, ring: null },
    { type: 'area', id: 'b', label: 'q', color: 'amber', ttlMs: null, anchor: { lon: 3, lat: 4 }, to: null,
      ring: [[3, 4], [4, 5], [5, 4]], footprintKind: 'area', buildingHeight: null, synthesized: false },
  ];
  const fc = annotationsToFeatureCollection(annos);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);
  assert.deepEqual(featureCollectionToAnnotations(fc), annos);
});

test('malformed input fails CLOSED (returns null / skips)', () => {
  assert.equal(featureToAnnotation(null), null);
  assert.equal(featureToAnnotation({}), null);
  assert.equal(featureToAnnotation({ type: 'NotAFeature' }), null);
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }), null); // no gev:type
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { 'gev:type': 'route' } }), null); // route needs LineString
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }, properties: { 'gev:type': 'arrow' } }), null); // arrow needs exactly 2
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, properties: { 'gev:type': 'area' } }), null); // <4 positions
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 0] }, properties: { 'gev:type': 'pin' } }), null); // non-finite
  // unknown type on the annotation side too
  assert.equal(annotationToFeature({ type: 'blob', anchor: { lon: 0, lat: 0 } }), null);
  assert.equal(annotationToFeature(null), null);
  // collection helpers never throw on junk
  assert.deepEqual(featureCollectionToAnnotations({ type: 'X' }), []);
  assert.deepEqual(annotationsToFeatureCollection('nope'), { type: 'FeatureCollection', features: [] });
});
