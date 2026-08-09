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
import type { MapLayers } from '../src/types';
import { persistGateOwnershipTransition } from '../src/services/variant-panel-ownership';
import {
  LAYER_REGISTRY,
  isLayerCommandAllowed,
  isLayerExecutable,
  isLayerEntitled,
  isLayerToggleAllowed,
  sanitizeLayersForVariant,
  sanitizeLockedLayers,
  sanitizeLockedLayersWithOwnership,
  restoreGateOwnedLockedLayers,
  mapLayerStatesEqual,
  shouldSanitizeLockedLayers,
} from '../src/config/map-layer-definitions';

describe('LAYER_REGISTRY — deckGLOnly flag', () => {
  test('layers with only DeckGL render paths are marked deckGLOnly', () => {
    // These layers have DeckGL-only render paths. GlobeMap has no branch for
    // them, and Map.ts SVG fallback has no render code. The `deckGLOnly: true`
    // flag is the signal that non-DeckGL contexts must not flip them on.
    assert.equal(LAYER_REGISTRY.storageFacilities.deckGLOnly, true,
      'storageFacilities must be marked deckGLOnly');
    assert.equal(LAYER_REGISTRY.fuelShortages.deckGLOnly, true,
      'fuelShortages must be marked deckGLOnly');
    assert.equal(LAYER_REGISTRY.diseaseOutbreaks.deckGLOnly, true,
      'diseaseOutbreaks must be marked deckGLOnly');
    assert.equal(LAYER_REGISTRY.resilienceScore.deckGLOnly, true,
      'resilienceScore must be marked deckGLOnly');
  });

  test('DeckGL-only layers are flat-only (no globe)', () => {
    // Renderer restriction is belt to the deckGLOnly suspenders — it
    // hides the toggle from the globe picker, while deckGLOnly also
    // blocks dispatch on the SVG fallback even though SVG is "flat".
    assert.deepEqual(LAYER_REGISTRY.storageFacilities.renderers, ['flat']);
    assert.deepEqual(LAYER_REGISTRY.fuelShortages.renderers, ['flat']);
    assert.deepEqual(LAYER_REGISTRY.diseaseOutbreaks.renderers, ['flat']);
    assert.deepEqual(LAYER_REGISTRY.resilienceScore.renderers, ['flat']);
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

  test('resilienceScore returns false on the SVG/mobile flat renderer', () => {
    assert.equal(isLayerExecutable('resilienceScore', 'flat', true), true,
      'flat + DeckGL should execute resilienceScore');
    assert.equal(isLayerExecutable('resilienceScore', 'flat', false), false,
      'flat + SVG-fallback must NOT execute resilienceScore');
    assert.equal(isLayerExecutable('resilienceScore', 'globe', true), false,
      'globe mode must NOT execute resilienceScore');
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

// #6045 — premium entitlement gate for CMD+K / programmatic layer enable.
// DeckGLMap disables the checkbox for premium === 'locked' only; enhanced
// layers stay toggleable with a PRO badge. isLayerEntitled must match that
// contract so CMD+K cannot enable locked layers for free users (and cannot
// leave a stuck checked+disabled control).
describe('isLayerEntitled — premium locked gate', () => {
  test('resilienceScore requires premium (locked)', () => {
    assert.equal(LAYER_REGISTRY.resilienceScore.premium, 'locked');
    assert.equal(isLayerEntitled('resilienceScore', false), false,
      'free users must not be entitled to resilienceScore');
    assert.equal(isLayerEntitled('resilienceScore', true), true,
      'premium users must be entitled to resilienceScore');
  });

  test('enhanced layers remain entitled without premium', () => {
    // ciiChoropleth is premium:'enhanced' on desktop — free users can still
    // toggle it (PRO badge only). Gating it would regress free-tier CII.
    // On web where premium is undefined the same assertion holds.
    assert.equal(isLayerEntitled('ciiChoropleth', false), true,
      'enhanced/free layers stay entitled for free users');
    assert.equal(isLayerEntitled('ciiChoropleth', true), true);
  });

  test('non-premium layers are always entitled', () => {
    assert.equal(LAYER_REGISTRY.conflicts.premium, undefined);
    assert.equal(isLayerEntitled('conflicts', false), true);
    assert.equal(isLayerEntitled('pipelines', false), true);
  });

  test('unknown layer key returns false', () => {
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerEntitled('nonexistentLayer', true), false);
  });
});

describe('sanitizeLockedLayers — free-user stuck-state heal', () => {
  test('clears locked layers when unentitled, leaves others alone', () => {
    const input = {
      resilienceScore: true,
      ciiChoropleth: true,
      conflicts: true,
      pipelines: false,
    } as unknown as import('../src/types').MapLayers;
    const out = sanitizeLockedLayers(input, false);
    assert.equal(out.resilienceScore, false, 'locked layer forced off');
    assert.equal(out.ciiChoropleth, true, 'enhanced/free layer preserved');
    assert.equal(out.conflicts, true);
    assert.equal(out.pipelines, false);
    // Input not mutated
    assert.equal(input.resilienceScore, true);
  });

  test('is a no-op when entitled', () => {
    const input = {
      resilienceScore: true,
      conflicts: true,
    } as unknown as import('../src/types').MapLayers;
    const out = sanitizeLockedLayers(input, true);
    assert.equal(out.resilienceScore, true);
    assert.equal(out.conflicts, true);
  });
});

describe('locked map-layer ownership', () => {
  // Regression: App.sanitizeMapLayersForTier's premium branch guarded its
  // storage write with `restored === layers`, where `restored` came out of
  // sanitizeLayersForVariant. That helper spreads its input, so the identity
  // check was ALWAYS false and the branch persisted on every pass — which is
  // how a `?layers=` deep link came to overwrite the saved (cloud-synced)
  // layer preference. Value comparison is the only correct check here.
  test('sanitizeLayersForVariant never returns its input, so identity guards are dead', () => {
    const layers = {
      conflicts: true,
      resilienceScore: false,
    } as unknown as MapLayers;

    const out = sanitizeLayersForVariant(layers, 'full');

    assert.notEqual(
      out,
      layers,
      'a fresh object means `out === layers` can never short-circuit a write',
    );
    assert.equal(
      mapLayerStatesEqual(out, layers),
      true,
      'mapLayerStatesEqual is the comparison that actually detects "nothing changed"',
    );
  });

  test('compares layer snapshots semantically instead of by object identity', () => {
    const layers = { conflicts: true, resilienceScore: false } as unknown as MapLayers;
    assert.equal(mapLayerStatesEqual(layers, { ...layers }), true);
    assert.equal(
      mapLayerStatesEqual(layers, { ...layers, resilienceScore: true }),
      false,
    );
  });

  test('records a locked layer forced off for a free user and keeps ownership across reruns', () => {
    const input = {
      resilienceScore: true,
      conflicts: true,
    } as unknown as MapLayers;

    const first = sanitizeLockedLayersWithOwnership(input, new Set());
    assert.equal(first.layers.resilienceScore, false);
    assert.equal(first.layers.conflicts, true);
    assert.deepEqual(first.gateOwned, new Set(['resilienceScore']));

    const second = sanitizeLockedLayersWithOwnership(first.layers, first.gateOwned);
    assert.equal(second.layers.resilienceScore, false);
    assert.deepEqual(second.gateOwned, new Set(['resilienceScore']));
  });

  test('keeps the live free gate sanitized when ownership persistence fails', () => {
    const durableLayers = {
      resilienceScore: true,
      conflicts: true,
    } as unknown as MapLayers;
    const reconciled = sanitizeLockedLayersWithOwnership(durableLayers, new Set());
    const writes: string[] = [];

    const persistence = persistGateOwnershipTransition(
      'free',
      () => { writes.push('layers'); },
      () => { writes.push('ownership'); return false; },
    );

    assert.equal(reconciled.layers.resilienceScore, false, 'live state remains safely gated');
    assert.equal(durableLayers.resilienceScore, true, 'durable preference remains retryable');
    assert.deepEqual(writes, ['ownership'], 'destructive durable write is blocked');
    assert.equal(persistence.complete, false);
  });

  test('restores only valid locked layers owned by the gate', () => {
    const restored = restoreGateOwnedLockedLayers(
      {
        resilienceScore: false,
        conflicts: false,
      } as unknown as MapLayers,
      new Set(['resilienceScore', 'conflicts', 'removed-layer']),
    );

    assert.equal(restored.resilienceScore, true);
    assert.equal(restored.conflicts, false, 'ordinary user-disabled layers stay disabled');
    assert.equal('removed-layer' in restored, false, 'unknown historical keys are ignored');
  });

  test('does not let stale resilience ownership override an enabled CII choropleth', () => {
    const restored = restoreGateOwnedLockedLayers(
      {
        resilienceScore: false,
        ciiChoropleth: true,
      } as unknown as MapLayers,
      new Set(['resilienceScore']),
    );

    assert.equal(restored.resilienceScore, false);
    assert.equal(restored.ciiChoropleth, true);
  });

  test('consumes stale resilience ownership after a free-to-Pro CII sequence', () => {
    const free = sanitizeLockedLayersWithOwnership(
      {
        resilienceScore: true,
        ciiChoropleth: false,
      } as unknown as MapLayers,
      new Set(),
    );
    const ciiSelectedWhileFree = {
      ...free.layers,
      ciiChoropleth: true,
    };
    const restored = restoreGateOwnedLockedLayers(
      ciiSelectedWhileFree,
      free.gateOwned,
    );
    let durableOwnership = new Set(free.gateOwned);

    const persistence = persistGateOwnershipTransition(
      'pro',
      () => true,
      () => { durableOwnership = new Set(); },
    );

    assert.equal(restored.resilienceScore, false);
    assert.equal(restored.ciiChoropleth, true);
    assert.equal(persistence.complete, true);
    assert.deepEqual(durableOwnership, new Set());
    assert.equal(
      restoreGateOwnedLockedLayers(restored, durableOwnership),
      restored,
      'later reconciliations have no stale resilience ownership to replay',
    );
  });
});

describe('isLayerToggleAllowed — stale locked-state recovery', () => {
  test('free users may turn a stale locked layer off but not turn it on', () => {
    assert.equal(isLayerToggleAllowed('resilienceScore', true, false), true,
      'stale locked state must remain recoverable');
    assert.equal(isLayerToggleAllowed('resilienceScore', false, false), false,
      'free users must not activate a locked layer');
  });

  test('premium users may toggle locked layers in either direction', () => {
    assert.equal(isLayerToggleAllowed('resilienceScore', true, true), true);
    assert.equal(isLayerToggleAllowed('resilienceScore', false, true), true);
  });

  test('enhanced and free layers remain toggleable for free users', () => {
    assert.equal(isLayerToggleAllowed('ciiChoropleth', false, false), true);
    assert.equal(isLayerToggleAllowed('conflicts', false, false), true);
  });

  test('unknown layers never pass the toggle gate', () => {
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerToggleAllowed('nonexistentLayer', true, false), false);
  });
});

describe('shouldSanitizeLockedLayers — settled-free policy', () => {
  test('does not clamp a pending session before the fallback deadline', () => {
    assert.equal(shouldSanitizeLockedLayers(false, false, false), false);
  });

  test('clamps a settled anonymous session', () => {
    assert.equal(shouldSanitizeLockedLayers(false, true, false), true);
  });

  test('clamps when the bounded fallback is active even if auth stays pending', () => {
    assert.equal(shouldSanitizeLockedLayers(false, false, true), true);
  });

  test('never clamps a premium user', () => {
    assert.equal(shouldSanitizeLockedLayers(true, true, true), false);
  });
});

describe('isLayerCommandAllowed — CMD+K toggle policy', () => {
  test('free users can clear stale locked layers but cannot enable them', () => {
    assert.equal(isLayerCommandAllowed('resilienceScore', true, 'flat', true, false), true);
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'flat', true, false), false);
  });

  test('premium and enhanced/free layers keep their expected toggle paths', () => {
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'flat', true, true), true);
    assert.equal(isLayerCommandAllowed('ciiChoropleth', false, 'flat', false, false), true);
  });

  test('renderer compatibility still blocks commands independently of entitlement', () => {
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'globe', true, true), false);
    assert.equal(isLayerCommandAllowed('storageFacilities', false, 'flat', false, true), false);
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
