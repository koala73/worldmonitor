// Footprint-selection contract tests — pure fixtures, no network, no browser.
//
// Locks the monument-resolution regression:
// a POINT-LIKE target ("Tejano Monument, Austin") must never adopt a nearby
// polygon that merely shares locality/context words ("Austin", "History").
// The fixtures replicate the REAL Overpass candidates captured over the Texas
// Capitol on 2026-07-01, where "Thompson Austin" (a hotel 680 m away) outscored
// everything because `nameOverlap * 1000` paid +1000 for the single word
// "Austin" — the monument itself is an OSM node and never even a candidate.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAnnotationTarget,
  selectFootprint,
  refineScope,
  isGroundsLikeAsk,
} from './annotationResolver.js';

// Build a square way of ~`areaM2` centred `dLatM`/`dLonM` metres from an anchor,
// in Overpass `out geom` element shape ({ tags, geometry: [{lat,lon}...] }).
function squareWay(anchor, dLatM, dLonM, areaM2, tags) {
  const mLat = 111320;
  const mLon = mLat * Math.cos((anchor.lat * Math.PI) / 180);
  const cLat = anchor.lat + dLatM / mLat;
  const cLon = anchor.lon + dLonM / mLon;
  const half = Math.sqrt(areaM2) / 2;
  const dy = half / mLat;
  const dx = half / mLon;
  const ring = [
    { lat: cLat - dy, lon: cLon - dx },
    { lat: cLat - dy, lon: cLon + dx },
    { lat: cLat + dy, lon: cLon + dx },
    { lat: cLat + dy, lon: cLon - dx },
    { lat: cLat - dy, lon: cLon - dx },
  ];
  return { type: 'way', tags, geometry: ring };
}

// The real Places anchor for "Tejano Monument, Austin" (on the Capitol grounds).
const ANCHOR = { lat: 30.27297, lon: -97.74029 };

// Real captured wrong-winners: named downtown features that share ONLY "Austin".
const wrongWinners = () => [
  squareWay(ANCHOR, -660, -90, 3093, { building: 'yes', tourism: 'hotel', name: 'Thompson Austin' }),
  squareWay(ANCHOR, -780, 120, 3772, { building: 'yes', name: 'Austin Police HQ' }),
  squareWay(ANCHOR, -380, -60, 4499, { leisure: 'park', name: 'Black Austin Matters' }),
  squareWay(ANCHOR, -240, -700, 1500, { building: 'yes', amenity: 'library', name: 'Austin Public Library - Austin History Center' }),
  // The real enclosing grounds polygon — unnamed overlap with the monument query.
  squareWay(ANCHOR, 0, 0, 100_000, { leisure: 'park', name: 'Capitol Square' }),
];

test('point mode: locality-word polygons never stand in for a monument (the Tejano bug)', () => {
  const fp = selectFootprint(wrongWinners(), ANCHOR.lat, ANCHOR.lon, 'Tejano Monument, Austin', 'point');
  assert.equal(fp, null); // keep the honest point anchor
});

test('point mode: an (almost) exactly-named, monument-scale polygon still outlines', () => {
  const els = wrongWinners();
  els.push(squareWay(ANCHOR, 5, 5, 300, { tourism: 'artwork', name: 'Tejano Monument' }));
  const fp = selectFootprint(els, ANCHOR.lat, ANCHOR.lon, 'Tejano Monument, Austin', 'point');
  assert.ok(fp, 'expected the true monument way to be accepted');
  assert.equal(fp.kind, 'area');
  // Ring is centred on the true feature (a few metres from the anchor), not downtown.
  const lat0 = fp.ring[0][1];
  assert.ok(Math.abs(lat0 - ANCHOR.lat) < 0.001, `ring landed at ${lat0}, expected ~${ANCHOR.lat}`);
});

test('point mode: an exactly-named but park-sized polygon is rejected (size cap)', () => {
  // "Pioneer Monument, Golden Gate Park" — the park matches 3/3 of its own name
  // and contains the anchor, but a 4.1 km² park must not render as a monument.
  const park = squareWay(ANCHOR, 0, 0, 4_100_000, { leisure: 'park', name: 'Golden Gate Park' });
  const fp = selectFootprint([park], ANCHOR.lat, ANCHOR.lon, 'Pioneer Monument, Golden Gate Park', 'point');
  assert.equal(fp, null);
});

test('loose mode: unchanged — word-overlap scoring still picks the named candidate', () => {
  // Pins that the fix is SCOPED to point-like targets: generic loose lookups keep
  // the existing scorer (changing it globally would need its own field evidence).
  const fp = selectFootprint(wrongWinners(), ANCHOR.lat, ANCHOR.lon, 'Tejano Monument, Austin', 'loose');
  assert.ok(fp, 'loose mode still resolves a footprint');
});

test('loose mode: a named compound still beats an unnamed containing building (Presidio case)', () => {
  const els = [
    squareWay(ANCHOR, 0, 0, 900, { building: 'yes' }), // unnamed building under the anchor
    squareWay(ANCHOR, 400, 400, 6_000_000, { landuse: 'military', name: 'Presidio of San Francisco' }),
  ];
  const fp = selectFootprint(els, ANCHOR.lat, ANCHOR.lon, 'Presidio of San Francisco', 'loose');
  assert.ok(fp);
  assert.equal(fp.kind, 'area');
});

test('strict mode: unchanged — named district-sized areas only', () => {
  const els = [
    squareWay(ANCHOR, 0, 0, 900, { building: 'yes', name: 'Mission Lofts' }), // building → rejected
    squareWay(ANCHOR, 0, 0, 12_000, { landuse: 'retail', name: 'Mission Market' }), // tiny parcel → rejected
    squareWay(ANCHOR, 200, 200, 500_000, { landuse: 'residential', name: 'Mission District' }),
  ];
  const fp = selectFootprint(els, ANCHOR.lat, ANCHOR.lon, 'Mission District', 'strict');
  assert.ok(fp);
  assert.equal(fp.kind, 'area');
  assert.ok(Math.abs(fp.ring[0][1] - (ANCHOR.lat + 200 / 111320)) < 0.01);
});

test('loose mode: a named water body beats a shore feature named after it (field test 9)', () => {
  // "Lady Bird Lake" — the anchor sits ON the water. Before natural=water joined the
  // sweep, the lake was never a candidate and a shoreline park NAMED AFTER it won on
  // word overlap, drawing a squiggle on the bank instead of the lake.
  const ANCHOR_ON_WATER = { lat: 30.2565, lon: -97.7365 };
  const els = [
    // The real lake: large named water polygon containing the anchor.
    squareWay(ANCHOR_ON_WATER, 0, 0, 3_500_000, { natural: 'water', water: 'reservoir', name: 'Lady Bird Lake' }),
    // Shore park named after the lake (partial name coverage, does not contain anchor).
    squareWay(ANCHOR_ON_WATER, 450, -300, 90_000, { leisure: 'park', name: 'Auditorium Shores at Lady Bird Lake Metropolitan Park' }),
  ];
  const fp = selectFootprint(els, ANCHOR_ON_WATER.lat, ANCHOR_ON_WATER.lon, 'Lady Bird Lake, Austin', 'loose');
  assert.ok(fp);
  assert.equal(fp.kind, 'area');
  // Ring centred on the lake fixture, not offset onto the shore park.
  const lat0 = fp.ring[0][1];
  assert.ok(Math.abs(lat0 - ANCHOR_ON_WATER.lat) < 0.02, 'ring at ' + lat0);
  assert.ok(Math.abs(lat0 - (ANCHOR_ON_WATER.lat + 450 / 111320)) > 0.001, 'must not be the shore park');

  // Inverse: a LAND ask near the water is not stolen by the lake polygon.
  const park = selectFootprint(els, ANCHOR_ON_WATER.lat + 0.004, ANCHOR_ON_WATER.lon - 0.003, 'Auditorium Shores', 'loose');
  assert.ok(park);
  assert.ok(Math.abs(park.ring[0][1] - (ANCHOR_ON_WATER.lat + 450 / 111320)) < 0.01, 'land ask keeps the park');
});

test('isGroundsLikeAsk: label wording and entityKind both count (field test 8)', () => {
  // The model's real call shape: grounds word only in the LABEL, compound entityKind.
  assert.equal(isGroundsLikeAsk('Texas State Capitol, Austin', 'Capitol grounds', 'compound'), true);
  // Label alone is enough when no entityKind is given.
  assert.equal(isGroundsLikeAsk('Texas State Capitol, Austin', 'Capitol grounds', null), true);
  // Target wording still works as before.
  assert.equal(isGroundsLikeAsk('Texas State Capitol grounds, Austin', null, null), true);
  // An explicit non-compound entityKind vetoes grounds wording (trust the model's fact).
  assert.equal(isGroundsLikeAsk('Capitol complex', 'the complex', 'building'), false);
  // A plain building ask is not grounds-like.
  assert.equal(isGroundsLikeAsk('Texas State Capitol, Austin', 'Texas State Capitol', null), false);
});

test('refineScope: entityKind refines only an unresolved (auto) scope', () => {
  assert.equal(refineScope('auto', 'building'), 'building');
  assert.equal(refineScope('auto', 'compound'), 'compound');
  assert.equal(refineScope('auto', 'district'), 'neighborhood');
  assert.equal(refineScope('auto', 'street'), 'street');
  assert.equal(refineScope('auto', 'point_feature'), 'auto'); // point-first handled separately
  assert.equal(refineScope('auto', undefined), 'auto');
  // Real geocode types (data) always win over the model's claim.
  assert.equal(refineScope('city', 'building'), 'city');
  assert.equal(refineScope('neighborhood', 'street'), 'neighborhood');
});

function closeViewportViewer() {
  return {
    camera: {
      positionCartographic: {
        latitude: 30.2672 * Math.PI / 180,
        longitude: -97.7431 * Math.PI / 180,
        height: 1000,
      },
    },
  };
}

function geocodePayload({ lat, lon, types, label }) {
  return {
    status: 'OK',
    results: [{
      formatted_address: label,
      types,
      address_components: [{ long_name: label.split(',')[0], types }],
      geometry: { location: { lat, lng: lon } },
    }],
  };
}

function installGoogleMocks(t, handler) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = {
    __GOOGLE_MAPS_API_KEY__: 'unit-test-key',
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.fetch = handler;
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });
}

test('ask-side admin bypass: "the Texas Capitol" recovers near-view despite a far state-typed geocode', async (t) => {
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      return { json: async () => geocodePayload({
        lat: 31.0000,
        lon: -99.0000,
        types: ['administrative_area_level_1', 'political'],
        label: 'Texas, USA',
      }) };
    }
    assert.match(String(url), /^\/api\/gev\/google\/text-search\?/);
    return {
      ok: true,
      json: async () => ({ places: [{
        latitude: 30.2747,
        longitude: -97.7404,
        name: 'Texas Capitol',
        types: ['premise'],
      }] }),
    };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'the Texas Capitol',
  });

  assert.ok(resolved);
  assert.equal(resolved.source, 'places');
  assert.deepEqual([resolved.lat, resolved.lon], [30.2747, -97.7404]);
  assert.equal(calls.length, 2, 'admin result types must not suppress near-view recovery');
});

test('ask-side admin bypass: explicit "state of Texas" skips recovery and proximity gating', async (t) => {
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    assert.match(String(url), /^https:\/\/maps\.googleapis\.com\/maps\/api\/geocode/);
    return { json: async () => geocodePayload({
      lat: 31.0000,
      lon: -99.0000,
      types: ['administrative_area_level_1', 'political'],
      label: 'Texas, USA',
    }) };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'state of Texas',
  });

  assert.ok(resolved, 'the explicit state ask keeps its legitimate far centroid');
  assert.equal(resolved.source, 'geocode');
  assert.deepEqual([resolved.lat, resolved.lon], [31, -99]);
  assert.equal(calls.length, 1, 'explicit state scope bypasses near-view recovery');
});

for (const fixture of [
  {
    target: 'Empire State',
    lat: 40.7484,
    lon: -73.9857,
    types: ['premise', 'tourist_attraction'],
  },
  {
    target: 'Ohio State',
    lat: 40.0067,
    lon: -83.0305,
    types: ['university'],
  },
]) {
  test(`ask-side admin bypass: trailing name "${fixture.target}" remains guarded`, async (t) => {
    const calls = [];
    installGoogleMocks(t, async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://maps.googleapis.com/')) {
        return { json: async () => geocodePayload({
          lat: fixture.lat,
          lon: fixture.lon,
          types: fixture.types,
          label: `${fixture.target}, USA`,
        }) };
      }
      assert.match(String(url), /^\/api\/gev\/google\/text-search\?/);
      return { ok: true, json: async () => ({ places: [] }) };
    });

    const resolved = await resolveAnnotationTarget({
      viewer: closeViewportViewer(),
      target: fixture.target,
    });

    assert.equal(resolved, null, 'a recovery miss continues through the proximity gate');
    assert.equal(calls.length, 2, 'a proper name ending in State must try near-view recovery');
  });
}

test('ask-side admin bypass: bare "Texas" remains on the guarded recovery path', async (t) => {
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      return { json: async () => geocodePayload({
        lat: 31.0000,
        lon: -99.0000,
        types: ['administrative_area_level_1', 'political'],
        label: 'Texas, USA',
      }) };
    }
    assert.match(String(url), /^\/api\/gev\/google\/text-search\?/);
    return { ok: true, json: async () => ({ places: [] }) };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'Texas',
  });

  assert.equal(resolved, null, 'a recovery miss continues through the proximity gate');
  assert.equal(calls.length, 2, 'bare state names are not an explicit admin-scoped ask');
});

test('ask-side admin bypass: admin level 2/3 result types never grant a township bypass', async (t) => {
  const fixtures = new Map([
    ['FB-3 township level 2 fixture', ['administrative_area_level_2', 'locality', 'political']],
    ['FB-3 township level 3 fixture', ['administrative_area_level_3', 'locality', 'political']],
  ]);
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      const query = new URL(String(url)).searchParams.get('address');
      return { json: async () => geocodePayload({
        lat: 39.7817,
        lon: -89.6501,
        types: fixtures.get(query),
        label: `${query}, Illinois`,
      }) };
    }
    assert.match(String(url), /^\/api\/gev\/google\/text-search\?/);
    return {
      ok: true,
      json: async () => ({ places: [{
        latitude: 30.2680,
        longitude: -97.7425,
        name: 'Local township fixture',
        types: ['locality'],
      }] }),
    };
  });

  for (const target of fixtures.keys()) {
    const resolved = await resolveAnnotationTarget({
      viewer: closeViewportViewer(),
      target,
    });
    assert.ok(resolved);
    assert.equal(resolved.source, 'places');
  }

  assert.equal(
    calls.filter((url) => url.startsWith('/api/gev/google/text-search')).length,
    2,
    'both township-level admin result types stay guarded',
  );
});
