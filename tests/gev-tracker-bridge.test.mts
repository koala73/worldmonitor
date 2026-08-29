/**
 * The World Monitor → God's Eye View tracker bridge.
 *
 * Two things are worth guarding here and neither needs a browser:
 *
 *  1. COVERAGE. Every payload CesiumGlobeMap pushes is either drawn or is on
 *     a list saying why it is not. Without this, adding a `setX()` and
 *     forgetting the spec produces a tracker that silently never appears —
 *     the exact failure a renderer swap invites, and one no type checker
 *     catches because `push()` takes a string.
 *
 *  2. RESOLUTION. `resolveMarkers` runs accessors over data that came off
 *     the network. A feed that returns one malformed row must cost that row
 *     and nothing else.
 *
 * Gating is checked against GlobeMap's behaviour, recovered from the commit
 * that deleted it: the layer each tracker answered to is a user-facing
 * contract, not an implementation detail, and the renderer swap must not
 * quietly move a tracker to a different toggle.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { BRIDGE_SPECS, setIranEventColorResolver } from '../src/components/gev-bridge/markerSpecs';
import { resolveMarkers } from '../src/components/gev-bridge/resolve';
import { STATIC_LAYER_KEYS, staticMarkersFor } from '../src/components/gev-bridge/staticLayers';
import { LAYER_REGISTRY } from '../src/config/map-layer-definitions';
import type { MapLayers } from '../src/types';

const root = resolve(import.meta.dirname, '..');
const globeSource = readFileSync(resolve(root, 'src/components/CesiumGlobeMap.ts'), 'utf8');

/**
 * Payloads deliberately recorded but not drawn.
 *
 * Every one is a country-level choropleth, a flow arc, or context for a
 * popup — shapes the bridge has no primitive for. GlobeMap drew none of them
 * either (its setters were empty bodies), so this is parity, not regression.
 * Adding polygon or polyline support is what shortens this list.
 */
const UNDRAWN = new Set([
  'positiveEvents',      // choropleth-ish point cloud, never drawn on the globe
  'kindness',            // ditto
  'happiness',           // country choropleth
  'speciesRecovery',     // country choropleth
  'renewables',          // country choropleth
  'ciiScores',           // country choropleth (needs polygons)
  'blocAlignment',       // country choropleth (DeckGL-only layer)
  'resilienceRanking',   // country choropleth (DeckGL-only layer)
  'diseaseOutbreaks',    // DeckGL-only layer
  'cableHealth',         // styles the cable paths, which need polylines
  'bypassRoutes',        // arcs
  'scenario',            // scenario polygons
  'hotspotLevels',       // recolours hotspots; not a marker set of its own
  'aircraftPositions',   // civil ADS-B; the vendored tree draws this natively
  'chokepoints',         // consumed by the waterway popup, not the globe
]);

describe('bridge coverage', () => {
  const pushed = [...globeSource.matchAll(/this\.push\('([a-zA-Z]+)'/g)].map((m) => m[1] as string);

  it('CesiumGlobeMap pushes the payloads this test thinks it does', () => {
    // If this drops, the regex above stopped matching and every other
    // assertion in this block became vacuous.
    assert.ok(pushed.length > 30, `expected 30+ push sites, found ${pushed.length}`);
  });

  it('every pushed payload is either drawn or documented as undrawn', () => {
    const orphans = pushed.filter((key) => !BRIDGE_SPECS[key] && !UNDRAWN.has(key));
    assert.deepStrictEqual(
      orphans, [],
      `these payloads reach the globe and vanish — add a spec in markerSpecs.ts `
      + `or list them in UNDRAWN with a reason: ${orphans.join(', ')}`,
    );
  });

  it('nothing lingers on the undrawn list after its push site is gone', () => {
    // A stale entry here would silently excuse a payload that no longer
    // exists, and the coverage test above would stop meaning anything.
    const stale = [...UNDRAWN].filter((key) => !pushed.includes(key));
    assert.deepStrictEqual(stale, [], `UNDRAWN lists payloads nothing pushes: ${stale.join(', ')}`);
  });

  it('no spec exists for a payload nothing pushes', () => {
    const dead = Object.keys(BRIDGE_SPECS).filter((key) => !pushed.includes(key));
    assert.deepStrictEqual(dead, [], `specs with no push site: ${dead.join(', ')}`);
  });

  it('every spec gates on a layer the globe actually offers', () => {
    for (const [key, spec] of Object.entries(BRIDGE_SPECS)) {
      if (spec.layer === null) continue;
      const def = LAYER_REGISTRY[spec.layer];
      assert.ok(def, `${key} gates on unknown layer "${spec.layer}"`);
      assert.ok(
        def.renderers.includes('globe'),
        `${key} gates on "${spec.layer}", which the catalog marks flat-only — `
        + `CesiumGlobeMap.setLayers force-disables it, so the markers could never show`,
      );
    }
  });
});

describe('gating parity with the globe.gl renderer', () => {
  // Recovered from GlobeMap.flushMarkersImmediate. Several toggles carry more
  // than one payload, and one payload carries no toggle at all — both are
  // deliberate and both are easy to lose in a rewrite.
  const EXPECTED: Record<string, keyof MapLayers | null> = {
    hotspots: 'hotspots',
    earthquakes: 'natural',
    naturalEvents: 'natural',
    weatherAlerts: 'weather',
    radiation: 'radiationWatch',
    outages: 'outages',
    trafficAnomalies: 'outages',
    ddosLocations: 'outages',
    cyberThreats: 'cyberThreats',
    fires: 'fires',
    protests: 'protests',
    ucdpEvents: 'ucdpEvents',
    displacementFlows: 'displacement',
    climateAnomalies: 'climate',
    gpsJamming: 'gpsJamming',
    iranEvents: 'iranAttacks',
    techEvents: 'techEvents',
    flightDelays: 'flights',
    ais: 'ais',
    cableActivity: 'cables',
    militaryFlights: 'military',
    militaryVessels: 'military',
    satellites: 'satellites',
    imageryScenes: 'satellites',
    webcams: 'webcams',
    newsLocations: null,
  };

  for (const [payload, layer] of Object.entries(EXPECTED)) {
    it(`${payload} answers to ${layer ?? 'no toggle'}`, () => {
      assert.equal(BRIDGE_SPECS[payload]?.layer, layer);
    });
  }
});

describe('resolveMarkers', () => {
  const spec = BRIDGE_SPECS.protests!;

  it('drops rows with no position rather than stacking them at (0, 0)', () => {
    const markers = resolveMarkers(spec, [
      { id: 'a', lat: 10, lon: 20, title: 'has position' },
      { id: 'b', title: 'never geocoded' },
      { id: 'c', lat: null, lon: 5, title: 'half a position' },
      { id: 'd', lat: Number.NaN, lon: 5, title: 'not a number' },
    ]);
    assert.deepStrictEqual(markers.map((m) => m.id), ['a']);
  });

  it('keeps the first row when a feed repeats an id', () => {
    const markers = resolveMarkers(spec, [
      { id: 'dup', lat: 1, lon: 1, title: 'first' },
      { id: 'dup', lat: 2, lon: 2, title: 'second' },
    ]);
    assert.equal(markers.length, 1);
    assert.equal(markers[0]!.lat, 1);
  });

  it('one malformed row does not cost the layer its other rows', () => {
    const hostile = {
      layer: 'protests' as const,
      parts: [{
        kind: 'test',
        rows: (p: any) => p,
        lat: (r: any) => r.lat,
        lon: (r: any) => r.lon,
        id: (r: any) => r.id,
        title: (r: any) => { if (r.id === 'bad') throw new Error('boom'); return r.id; },
        style: () => ({ color: '#fff', size: 8 }),
      }],
    };
    const markers = resolveMarkers(hostile, [
      { id: 'ok1', lat: 1, lon: 1 },
      { id: 'bad', lat: 2, lon: 2 },
      { id: 'ok2', lat: 3, lon: 3 },
    ]);
    assert.deepStrictEqual(markers.map((m) => m.id), ['ok1', 'ok2']);
  });

  it('survives a payload of the wrong shape entirely', () => {
    assert.deepStrictEqual(resolveMarkers(spec, null), []);
    assert.deepStrictEqual(resolveMarkers(spec, 'not an array'), []);
    assert.deepStrictEqual(resolveMarkers(spec, { nope: true }), []);
  });

  it('carries the original row through for the click popup', () => {
    const row = { id: 'p1', lat: 5, lon: 6, title: 'Strike', eventType: 'strike' };
    const [marker] = resolveMarkers(spec, [row]);
    assert.equal(marker!.row, row, 'MapPopup is handed the domain object, not a copy');
  });
});

describe('payload shapes that are easy to get backwards', () => {
  it('weather alert centroids are read as [lon, lat]', () => {
    // NWS centroids are GeoJSON-ordered and every other World Monitor feed
    // is not. Reading them the common way puts US alerts in the Gulf of
    // Guinea, which is exactly the sort of "renderer works, data is wrong"
    // failure a screenshot does not catch.
    const [marker] = resolveMarkers(BRIDGE_SPECS.weatherAlerts!, [
      { id: 'w1', centroid: [-97.7, 30.2], severity: 'Severe', headline: 'Austin' },
    ]);
    assert.equal(marker!.lat, 30.2);
    assert.equal(marker!.lon, -97.7);
  });

  it('satellites carry real orbital altitude, converted to metres', () => {
    const [marker] = resolveMarkers(BRIDGE_SPECS.satellites!, [
      { noradId: '25544', name: 'ISS', lat: 0, lng: 0, alt: 420, country: 'US' },
    ]);
    assert.equal(marker!.height, 420_000);
  });

  it('military flights fly above the terrain rather than on it', () => {
    const [marker] = resolveMarkers(BRIDGE_SPECS.militaryFlights!, {
      flights: [{ id: 'f1', lat: 1, lon: 2, callsign: 'REACH01' }], clusters: [],
    });
    assert.ok((marker!.height ?? 0) > 0, 'an aircraft clamped to the ground reads as a vehicle');
  });

  it('multi-part payloads split into their separate marker kinds', () => {
    const markers = resolveMarkers(BRIDGE_SPECS.militaryVessels!, {
      vessels: [{ id: 'v1', lat: 1, lon: 1, name: 'CVN-78', vesselType: 'carrier' }],
      clusters: [{ id: 'c1', lat: 2, lon: 2, name: 'CSG-8', vesselCount: 5, activityType: 'deployment' }],
    });
    assert.deepStrictEqual(markers.map((m) => m.kind).sort(), ['cluster', 'vessel']);
  });

  it('AIS density zones are not drawn as disruption markers', () => {
    const markers = resolveMarkers(BRIDGE_SPECS.ais!, {
      disruptions: [{ id: 'd1', lat: 1, lon: 1, name: 'Gulf', severity: 'high' }],
      density: [{ lat: 9, lon: 9, count: 400 }],
    });
    assert.equal(markers.length, 1, 'density needs a heatmap, which the bridge has no primitive for');
  });

  it('flight delays split closures out as their own NOTAM ring', () => {
    const markers = resolveMarkers(BRIDGE_SPECS.flightDelays!, [
      { id: 'a1', lat: 1, lon: 1, iata: 'AUS', severity: 'severe', delayType: 'closure', name: 'Austin' },
      { id: 'a2', lat: 2, lon: 2, iata: 'DFW', severity: 'moderate', delayType: 'departure' },
      { id: 'a3', lat: 3, lon: 3, iata: 'IAH', severity: 'normal', delayType: 'departure' },
    ]);
    const kinds = markers.map((m) => `${m.kind}:${m.id}`).sort();
    // 'normal' is filtered out; the closure appears twice, once as a pin and
    // once as its ring, which is how the old globe drew it.
    assert.deepStrictEqual(kinds, ['flightDelay:a1', 'flightDelay:a2', 'notamRing:notam-a1']);
  });

  it('unknown flight-delay severity is grey, never a green all-clear', () => {
    const [marker] = resolveMarkers(BRIDGE_SPECS.flightDelays!, [
      { id: 'u1', lat: 1, lon: 1, iata: 'XXX', severity: 'unknown', delayType: 'departure' },
    ]);
    assert.equal(marker!.style.color, '#7d7d8a');
  });

  it('the Iran colour resolver is injectable and has a safe default', () => {
    const before = resolveMarkers(BRIDGE_SPECS.iranEvents!, [
      { id: 'i1', latitude: 32, longitude: 53, title: 'Event' },
    ]);
    assert.match(before[0]!.style.color, /^#[0-9a-f]{6}$/i);
    setIranEventColorResolver(() => '#123456');
    const after = resolveMarkers(BRIDGE_SPECS.iranEvents!, [
      { id: 'i1', latitude: 32, longitude: 53, title: 'Event' },
    ]);
    assert.equal(after[0]!.style.color, '#123456');
  });
});

describe('built-in site catalogues', () => {
  it('every static layer is one the globe offers', () => {
    for (const key of STATIC_LAYER_KEYS) {
      const def = LAYER_REGISTRY[key];
      assert.ok(def, `static layer "${key}" is not in the catalog`);
      assert.ok(def.renderers.includes('globe'), `static layer "${key}" is flat-only`);
    }
  });

  it('produce markers with finite coordinates', () => {
    for (const key of STATIC_LAYER_KEYS) {
      const markers = staticMarkersFor(key);
      assert.ok(markers && markers.length > 0, `${key} produced no markers`);
      for (const marker of markers) {
        assert.ok(Number.isFinite(marker.lat) && Number.isFinite(marker.lon),
          `${key} marker ${marker.id} has a non-finite position`);
        assert.ok(Math.abs(marker.lat) <= 90 && Math.abs(marker.lon) <= 180,
          `${key} marker ${marker.id} is off the planet`);
      }
    }
  });

  it('are memoised — the catalogues never change', () => {
    assert.equal(staticMarkersFor('bases'), staticMarkersFor('bases'));
  });

  it('return null for a layer they do not own', () => {
    assert.equal(staticMarkersFor('protests'), null);
  });
});

describe('marker styling', () => {
  it('every colour in every spec is a parseable hex string', () => {
    // Cesium.Color.fromCssColorString returns undefined for a malformed
    // string and the entity then draws in whatever the default is, which is
    // a silent visual regression rather than an error.
    for (const [key, spec] of Object.entries(BRIDGE_SPECS)) {
      for (const part of spec.parts) {
        const style = part.style({});
        assert.match(style.color, /^#[0-9a-f]{3,8}$/i, `${key}/${part.kind} colour: ${style.color}`);
        assert.ok(style.size > 0, `${key}/${part.kind} has a zero size`);
      }
    }
  });
});
