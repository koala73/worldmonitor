/**
 * Tests for 2D ↔ 3D globe completeness parity (PR: feat/3d-globe-view).
 *
 * Covers:
 * - MapContainer globe routing: setAisData and setFlightDelays delegate to globeMap
 * - GlobeMap AIS implementation: setAisData produces correct marker fields
 * - dayNight toggle suppressed in globe mode (three-point enforcement)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// 1. MapContainer globe routing
// ========================================================================

describe('MapContainer globe routing', () => {
  const src = readSrc('src/components/MapContainer.ts');

  it('delegates setAisData to globeMap when useGlobe is true', () => {
    // Expect the globe guard immediately inside setAisData
    assert.match(
      src,
      /setAisData\(disruptions[^)]*\)[^{]*\{[^}]*if \(this\.useGlobe\)[^}]*this\.globeMap\?\.setAisData\(disruptions, density\)/s,
      'setAisData should delegate to globeMap when useGlobe=true'
    );
  });

  it('delegates setFlightDelays to globeMap when useGlobe is true', () => {
    assert.match(
      src,
      /setFlightDelays\(delays[^)]*\)[^{]*\{[^}]*if \(this\.useGlobe\)[^}]*this\.globeMap\?\.setFlightDelays\(delays\)/s,
      'setFlightDelays should delegate to globeMap when useGlobe=true'
    );
  });
});

// ========================================================================
// 2. CesiumGlobeMap accepts every pushed tracker
// ========================================================================
//
// This replaces a set of assertions that grepped GlobeMap.ts for globe.gl
// marker internals (AisDisruptionMarker interface shape, buildMarkerElement
// colour branches, tooltip HTML). That renderer is gone — CesiumGlobeMap
// forwards to God's Eye View's Cesium viewer instead.
//
// What is worth guarding at this layer is the contract MapContainer depends
// on: every setter it delegates exists, data pushed before the async Cesium
// boot finishes is not dropped, and each payload reaches the bridge. What
// each tracker then LOOKS like is the spec table's business and is covered
// by tests/gev-tracker-bridge.test.mts.

describe('CesiumGlobeMap tracker intake', () => {
  const src = readSrc('src/components/CesiumGlobeMap.ts');

  it('implements every setter MapContainer delegates in globe mode', () => {
    const container = readSrc('src/components/MapContainer.ts');
    const delegated = new Set(
      [...container.matchAll(/globeMap\?\.([a-zA-Z]+)/g)].map((m) => m[1]),
    );
    assert.ok(delegated.size > 50, `expected MapContainer to delegate widely, saw ${delegated.size}`);

    const missing = [...delegated].filter(
      (name) => !new RegExp(`\\bpublic (?:async )?${name}\\s*[(<]`).test(src),
    );
    assert.deepStrictEqual(
      missing, [],
      `CesiumGlobeMap is missing members MapContainer calls: ${missing.join(', ')}`,
    );
  });

  it('records pushed payloads so nothing is lost during the async boot', () => {
    // Cesium construction + Google 3D Tiles is async, but MapContainer
    // constructs the map synchronously and starts pushing immediately.
    assert.match(src, /private push\(layer: string, data: unknown\): void/);
    assert.match(src, /this\.payloads\[layer\] = data/);
    // ...and the boot replays them.
    assert.match(src, /for \(const \[layer, data\] of Object\.entries\(this\.payloads\)\)/);
  });

  it('routes AIS disruptions and density through one payload', () => {
    assert.match(src, /setAisData\([^)]*\): void \{\s*this\.push\('ais', \{ disruptions, density \}\)/s);
  });

  it('hands every recorded payload to the bridge rather than drawing inline', () => {
    // The failure this catches is a setter that grew its own Cesium code:
    // one renderer path means one place where a tracker can be wrong.
    assert.match(src, /const spec = BRIDGE_SPECS\[layer\]/);
    assert.match(src, /this\.renderer\.setMarkers\(layer, resolveMarkers\(spec, data\)\)/);
  });

  it('materialises the built-in site catalogues only once their layer is on', () => {
    // Military bases, nuclear sites and the rest are thousands of static
    // rows. Building them at boot for a user who never opens the layer is
    // startup cost with no payoff — GlobeMap deferred them for this reason.
    assert.match(src, /if \(enabled\) this\.ensureStaticLayer\(key\)/);
    assert.match(src, /if \(!this\.renderer \|\| this\.staticLoaded\.has\(layer\)\) return/);
  });
});

// ========================================================================
// 3. Layers the globe cannot draw are forced off
// ========================================================================

describe('flat-only layers are suppressed on the globe', () => {
  const src = readSrc('src/components/CesiumGlobeMap.ts');

  it('derives the suppression set from the layer catalog, not a hardcoded list', () => {
    assert.match(src, /FLAT_ONLY_LAYERS/);
    assert.match(src, /LAYER_REGISTRY/);
    assert.match(src, /!d\.renderers\.includes\('globe'\)/);
  });

  it('setLayers forces those layers off rather than showing a toggle that lies', () => {
    assert.match(src, /for \(const key of CesiumGlobeMap\.FLAT_ONLY_LAYERS\)/);
    assert.match(src, /if \(next\[key\]\) next = \{ \.\.\.next, \[key\]: false \}/);
  });

  it('Day/Night is still catalogued as flat-only (the layer that motivated this)', () => {
    const registry = readSrc('src/config/map-layer-definitions.ts');
    assert.match(
      registry,
      /dayNight:\s*def\('dayNight',[^)]*\['flat'\]\)/,
      "dayNight must stay renderers: ['flat'] — no globe has a day/night terminator",
    );
  });
});
