import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Cockpit 3D aircraft policy.
 *
 * Cockpit renders NEARBY traffic with the existing fleet models and leaves
 * everything beyond the band as the shipped contact pips. The behaviour itself
 * is only observable in a browser, but the policy is expressed as a handful of
 * decisions and constants in the two flight layers, and those are exactly what a
 * regression would silently revert. These assertions pin the decisions.
 */

const LAYERS = [
  { name: 'flights', path: new URL('./flights.js', import.meta.url) },
  { name: 'militaryFlights', path: new URL('./militaryFlights.js', import.meta.url) },
];

/** Read a `const NAME = <number>;` declaration out of a module's source. */
function numericConstant(source, name) {
  const match = new RegExp(`const ${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(source);
  assert.ok(match, `${name} is declared`);
  return Number(match[1]);
}

for (const layer of LAYERS) {
  const source = readFileSync(layer.path, 'utf8');

  test(`${layer.name}: every GLB creation bypasses the tile-contended frame-spread queue`, () => {
    const calls = [...source.matchAll(/Cesium\.Model\.fromGltfAsync\(\{([\s\S]*?)\}\)/g)];
    assert.ok(calls.length >= 3, `expected fleet, tracked, and preload model calls; found ${calls.length}`);
    for (const [index, call] of calls.entries()) {
      assert.match(call[1], /\basynchronous:\s*false\b/,
        `Model.fromGltfAsync call ${index + 1} must keep bounded GLB readiness independent of tile jobs`);
    }
  });

  test(`${layer.name}: Cockpit 3D obeys the shared Display toggle`, () => {
    const regime = /function _modelRegimeActive\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    assert.ok(regime, '_modelRegimeActive is defined');
    assert.match(regime, /if \(!_models3dEnabled\) return false;/,
      'OFF must keep Cockpit AIR contacts in 2D');
    assert.doesNotMatch(regime, /!_models3dEnabled\s*&&\s*!_cockpitContactMode/,
      'Cockpit must not bypass the user-visible Display toggle');
  });

  test(`${layer.name}: the pilot's own airframe stays hidden in cockpit`, () => {
    // Extra suppressions are allowed (the TR-3B Easter egg shares this guard,
    // pinned in tr3bRegistry.test.mjs); the cockpit exclusion is what this test
    // owns. The tracked regime is DEFAULT-ON by camera distance (2026-08-19), so
    // it no longer routes through the toggle-gated `_modelRegimeActive` — the
    // suppression is now an explicit early return.
    const regime = /function _trackedModelRegimeActive\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    assert.ok(regime, '_trackedModelRegimeActive is defined');
    assert.match(regime, /if \(!_trackedIcao \|\| _cockpitContactMode \|\|[\s\S]*?return false;/,
      '_trackedModelRegimeActive excludes cockpit');
    const tracked = /function _updateTrackedModel\(\)[\s\S]*?\n  if \(!active\)/.exec(source)?.[0];
    assert.ok(tracked, '_updateTrackedModel is defined');
    assert.match(tracked, /_trackedModelRegimeActive\(\)/,
      'the tracked-model driver uses the cockpit-aware predicate');
  });

  test(`${layer.name}: Cockpit uses standard Proximity and All radii with a lower cap`, () => {
    assert.equal(numericConstant(source, 'MODEL_PROX_ADD_M'), 150_000);
    assert.equal(numericConstant(source, 'MODEL_PROX_KEEP_M'), 185_000);
    assert.equal(numericConstant(source, 'MODEL_ALL_ADD_M'), 400_000);
    assert.equal(numericConstant(source, 'MODEL_ALL_KEEP_M'), 450_000);
    assert.equal(numericConstant(source, 'COCKPIT_MODEL_MAX'), 60);

    const add = /function _modelAddDistM\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    const keep = /function _modelKeepDistM\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    assert.match(add, /_models3dMode === 'all' \? MODEL_ALL_ADD_M : MODEL_PROX_ADD_M/);
    assert.match(keep, /_models3dMode === 'all' \? MODEL_ALL_KEEP_M : MODEL_PROX_KEEP_M/);
    assert.doesNotMatch(add, /COCKPIT_MODEL_ADD_M/);
    assert.doesNotMatch(keep, /COCKPIT_MODEL_KEEP_M/);

    const cap = /function _modelCap\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    assert.match(cap, /Math\.min\(COCKPIT_MODEL_MAX/,
      'Cockpit keeps its 60-model performance ceiling');
  });

  test(`${layer.name}: near AIR state is independent from model admission`, () => {
    assert.match(source, /nextCockpitNearContacts\(/,
      'Cockpit derives a separate near-contact hysteresis set');
    assert.match(source, /isCockpitContact && !isCockpitNear[\s\S]*cockpitContactDotImage\(\)/,
      'only out-of-range Cockpit contacts become dots');
    // `_iconKind` is identity for every unconverted contact (see
    // tr3bRegistry.test.mjs) — it only swaps the glyph for a contact the
    // operator explicitly converted into a TR-3B.
    assert.match(source, /bb\.image = aircraftIcon\(_iconKind\(icao24, meta\?\.klass\)(, bb\._gevIconLarge \? TRACKED_ICON_PX : undefined)?\)/,
      'near contacts and model fallbacks retain the class-derived aircraft silhouette');
    assert.match(source, /bb\.rotation = 0;/,
      'far dots are reset to a rotation-free presentation');
    assert.match(source, /\(!_cockpitContactMode \|\| isCockpitNear\) && \(doRotations \|\| revealed\)/,
      'near 2D silhouettes continue to receive projected course');
    assert.match(source, /if \(bb\.show\) bb\.show = false; \/\/ hand off ONLY once the model renders/,
      'the gap-proof billboard-to-model handoff remains intact');
  });

  test(`${layer.name}: Cockpit exit clears near state before restoring map presentation`, () => {
    const setMode = /function _setCockpitContactMode\([\s\S]*?\n\}/.exec(source)?.[0];
    assert.match(setMode, /else _cockpitNearContacts = new Set\(\);/);
    assert.match(setMode, /for \(const \[icao24, bb\] of _billboards\) _applyFleetBillboardPresentation\(icao24, bb\);/);
  });
}
