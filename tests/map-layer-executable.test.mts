// Regression guards for src/config/map-layer-definitions.ts:
//
//   - `deckGLOnly` flag on LayerDefinition
//   - `isLayerExecutable(key, renderer, isDeckGLActive)` predicate
//
// Both gate whether a `layer:*` toggle (per-layer CMD+K, `layers:*`
// preset, or programmatic dispatch) is allowed to flip a layer on
// under the active renderer + DeckGL state. Getting them wrong means
// toggles can set `mapLayers[key] = true` for layers that can't
// render — silent no-op state the user can't toggle back off if the
// picker hides the command under the current renderer.
//
// Closes the PR #3366 Codex P2 about missing regression tests for
// the `deckGLOnly` / `isLayerExecutable` contract.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  LAYER_REGISTRY,
  isLayerExecutable,
} from '../src/config/map-layer-definitions';

describe('LAYER_REGISTRY — deckGLOnly flag', () => {
  test('storageFacilities and fuelShortages are marked deckGLOnly', () => {
    // These two layers ship in PR #3366 with DeckGL-only render paths.
    // GlobeMap has no branch for them in ensureStaticDataForLayer, and
    // Map.ts SVG fallback has no render code. The `deckGLOnly: true`
    // flag is the signal that non-DeckGL contexts must not flip them on.
    assert.equal(LAYER_REGISTRY.storageFacilities.deckGLOnly, true,
      'storageFacilities must be marked deckGLOnly');
    assert.equal(LAYER_REGISTRY.fuelShortages.deckGLOnly, true,
      'fuelShortages must be marked deckGLOnly');
  });

  test('storageFacilities and fuelShortages are flat-only (no globe)', () => {
    // Renderer restriction is belt to the deckGLOnly suspenders — it
    // hides the toggle from the globe picker, while deckGLOnly also
    // blocks dispatch on the SVG fallback even though SVG is "flat".
    assert.deepEqual(LAYER_REGISTRY.storageFacilities.renderers, ['flat']);
    assert.deepEqual(LAYER_REGISTRY.fuelShortages.renderers, ['flat']);
  });

  test('layers without deckGLOnly do not accidentally set the flag to false', () => {
    // Spot-check: layers that existed before PR #3366 should have
    // deckGLOnly unset (undefined), not explicitly `false`. An
    // accidentally-introduced `deckGLOnly: false` would technically
    // type-check but signals confusion about the contract (absence
    // means "no opinion", not "forbids DeckGL").
    assert.equal(LAYER_REGISTRY.pipelines.deckGLOnly, undefined,
      'pipelines is not deckGLOnly — renders on flat + globe');
    assert.equal(LAYER_REGISTRY.conflicts.deckGLOnly, undefined);
    assert.equal(LAYER_REGISTRY.cables.deckGLOnly, undefined);
  });
});

describe('isLayerExecutable — renderer gate', () => {
  test('deckGLOnly layer returns true only on flat + DeckGL active', () => {
    // The intended ship state: DeckGL desktop can render, nothing else.
    assert.equal(isLayerExecutable('storageFacilities', 'flat', true), true,
      'flat + DeckGL should execute');
    assert.equal(isLayerExecutable('storageFacilities', 'flat', false), false,
      'flat + SVG-fallback (no DeckGL) must NOT execute');
    assert.equal(isLayerExecutable('storageFacilities', 'globe', true), false,
      'globe mode must NOT execute (no GlobeMap render path)');
    assert.equal(isLayerExecutable('storageFacilities', 'globe', false), false,
      'globe + SVG is impossible in practice but must also not execute');
  });

  test('flat-only non-deckGLOnly layer returns true on flat regardless of DeckGL', () => {
    // `ciiChoropleth` is renderers:['flat'] but NOT deckGLOnly — it
    // renders via a different flat path (choropleth). The gate should
    // admit it on flat regardless of DeckGL status.
    assert.equal(isLayerExecutable('ciiChoropleth', 'flat', true), true);
    // SVG fallback with ciiChoropleth: the renderer gate admits it
    // because 'flat' is in its renderers list. CII-specific rendering
    // is handled by whatever renders flat-mode layers — that's outside
    // isLayerExecutable's scope. deckGLOnly is the only "needs DeckGL
    // even on flat" signal.
    assert.equal(isLayerExecutable('ciiChoropleth', 'flat', false), true);
    assert.equal(isLayerExecutable('ciiChoropleth', 'globe', true), false,
      'ciiChoropleth has no globe renderer');
  });

  test('dual-renderer layer admits both flat and globe', () => {
    // `pipelines` has renderers:['flat', 'globe'] (default) — it
    // renders on both flat DeckGL/SVG and globe mode.
    assert.equal(isLayerExecutable('pipelines', 'flat', true), true);
    assert.equal(isLayerExecutable('pipelines', 'flat', false), true);
    assert.equal(isLayerExecutable('pipelines', 'globe', true), true);
    assert.equal(isLayerExecutable('pipelines', 'globe', false), true);
  });

  test('unknown layer key returns false', () => {
    // Typo or stale key -> must not accidentally pass the gate.
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerExecutable('nonexistentLayer', 'flat', true), false);
  });
});

describe('isLayerExecutable — matrix of renderer x DeckGL x deckGLOnly', () => {
  // Exhaustive 2x2x2 matrix to lock down the truth table. Future edits
  // to the predicate that accidentally widen the allowed set get
  // caught here rather than in production.
  const cases: Array<{
    renderers: Array<'flat' | 'globe'>;
    deckGLOnly: boolean;
    renderer: 'flat' | 'globe';
    isDeckGL: boolean;
    expect: boolean;
    why: string;
  }> = [
    // deckGLOnly:true — only flat + DeckGL active passes
    { renderers: ['flat'], deckGLOnly: true, renderer: 'flat',  isDeckGL: true,  expect: true,  why: 'flat + DeckGL passes deckGLOnly' },
    { renderers: ['flat'], deckGLOnly: true, renderer: 'flat',  isDeckGL: false, expect: false, why: 'flat + SVG fails deckGLOnly' },
    { renderers: ['flat'], deckGLOnly: true, renderer: 'globe', isDeckGL: true,  expect: false, why: 'globe not in renderers list' },
    { renderers: ['flat'], deckGLOnly: true, renderer: 'globe', isDeckGL: false, expect: false, why: 'globe not in renderers list' },
    // deckGLOnly:false/undefined — renderer list is the only gate
    { renderers: ['flat'], deckGLOnly: false, renderer: 'flat',  isDeckGL: true,  expect: true,  why: 'flat-only layer on flat' },
    { renderers: ['flat'], deckGLOnly: false, renderer: 'flat',  isDeckGL: false, expect: true,  why: 'flat-only layer on SVG (no deckGLOnly requirement)' },
    { renderers: ['flat'], deckGLOnly: false, renderer: 'globe', isDeckGL: true,  expect: false, why: 'flat-only layer rejects globe' },
    // dual-renderer layers
    { renderers: ['flat', 'globe'], deckGLOnly: false, renderer: 'flat',  isDeckGL: true,  expect: true, why: 'dual-renderer on flat' },
    { renderers: ['flat', 'globe'], deckGLOnly: false, renderer: 'globe', isDeckGL: true,  expect: true, why: 'dual-renderer on globe' },
  ];

  for (const c of cases) {
    test(`${c.why}`, () => {
      // Pick a representative key matching the (renderers, deckGLOnly) shape.
      // storageFacilities = ['flat'] + deckGLOnly:true
      // ciiChoropleth = ['flat'] + deckGLOnly:undefined
      // pipelines = ['flat','globe'] + deckGLOnly:undefined
      let key: keyof typeof LAYER_REGISTRY;
      if (c.deckGLOnly) key = 'storageFacilities';
      else if (c.renderers.length === 1) key = 'ciiChoropleth';
      else key = 'pipelines';
      assert.equal(isLayerExecutable(key, c.renderer, c.isDeckGL), c.expect, c.why);
    });
  }
});
