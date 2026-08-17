// Regression guards for src/config/map-layer-definitions.ts:
//
//   - the `renderers: ('svg' | 'deck' | 'globe')[]` axis on LayerDefinition
//   - the `isLayerExecutable(key, kind)` predicate
//
// The renderers list gates whether a `layer:*` toggle (per-layer CMD+K,
// `layers:*` preset, or programmatic dispatch) is allowed to flip a layer
// on under the active renderer. Getting it wrong means toggles can set
// `mapLayers[key] = true` for layers that can't render — silent no-op state
// the user can't toggle back off if the picker hides the command under the
// current renderer.
//
// The single 3-kind axis replaced an ambiguous `'flat'` renderer plus a
// bolted-on `deckGLOnly?: boolean` (#6773 / audit R8): `'flat'` covered both
// the SVG fallback and DeckGL, so DeckGL-only layers needed the extra flag.
// Now `'svg'` and `'deck'` are distinct, so `renderers` alone is the gate.

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

describe('LAYER_REGISTRY — renderer axis', () => {
  test('layers with only DeckGL render paths are deck-only', () => {
    // These layers have DeckGL-only render paths. GlobeMap has no branch for
    // them, and Map.ts SVG fallback has no render code. `renderers: ['deck']`
    // is the signal that non-DeckGL contexts must not flip them on.
    assert.deepEqual(LAYER_REGISTRY.storageFacilities.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.fuelShortages.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.diseaseOutbreaks.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.resilienceScore.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.canadaRoads.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.canadaAlerts.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.liveTankers.renderers, ['deck']);
  });

  test('the CII choropleth renders on deck + globe, not svg', () => {
    // #6773 / R8 bug fix: GlobeMap AND DeckGLMap both build CII polygons, but
    // the SVG/mobile fallback has no CII paint path. The old `['flat']` value
    // wrongly excluded it from the globe picker.
    assert.deepEqual(LAYER_REGISTRY.ciiChoropleth.renderers, ['deck', 'globe']);
  });

  test('the deckGLOnly flag is fully removed from the definition shape', () => {
    // The second axis is gone; `renderers` alone gates execution now.
    assert.equal('deckGLOnly' in LAYER_REGISTRY.storageFacilities, false);
    assert.equal('deckGLOnly' in LAYER_REGISTRY.pipelines, false);
    assert.equal('deckGLOnly' in LAYER_REGISTRY.ciiChoropleth, false);
  });

  test('Toronto restrictions reuse canadaRoads and do not add a second layer id', () => {
    assert.equal('torontoRoads' in LAYER_REGISTRY, false);
    assert.ok(LAYER_REGISTRY.canadaRoads);
    assert.equal(LAYER_REGISTRY.canadaRoads.key, 'canadaRoads');
    assert.match(LAYER_REGISTRY.canadaRoads.fallbackLabel, /Toronto/i);
  });

  test('all-surface layers list every renderer', () => {
    // Layers with a paint path on SVG, DeckGL, and the globe list all three.
    assert.deepEqual(LAYER_REGISTRY.pipelines.renderers, ['svg', 'deck', 'globe']);
    assert.deepEqual(LAYER_REGISTRY.conflicts.renderers, ['svg', 'deck', 'globe']);
    assert.deepEqual(LAYER_REGISTRY.cables.renderers, ['svg', 'deck', 'globe']);
    // Flat-surface-only layers (no globe paint path) are svg + deck.
    assert.deepEqual(LAYER_REGISTRY.sanctions.renderers, ['svg', 'deck']);
    assert.deepEqual(LAYER_REGISTRY.dayNight.renderers, ['svg', 'deck']);
  });
});

describe('isLayerExecutable — renderer gate', () => {
  test('a deck-only layer is executable under kind "deck" but not "svg" or "globe"', () => {
    // The intended ship state: DeckGL desktop can render, nothing else.
    assert.equal(isLayerExecutable('storageFacilities', 'deck'), true,
      'DeckGL should execute');
    assert.equal(isLayerExecutable('storageFacilities', 'svg'), false,
      'SVG fallback must NOT execute a deck-only layer');
    assert.equal(isLayerExecutable('storageFacilities', 'globe'), false,
      'globe mode must NOT execute (no GlobeMap render path)');
  });

  test('resilienceScore is executable only under kind "deck"', () => {
    assert.equal(isLayerExecutable('resilienceScore', 'deck'), true,
      'DeckGL should execute resilienceScore');
    assert.equal(isLayerExecutable('resilienceScore', 'svg'), false,
      'SVG fallback must NOT execute resilienceScore');
    assert.equal(isLayerExecutable('resilienceScore', 'globe'), false,
      'globe mode must NOT execute resilienceScore');
  });

  test('ciiChoropleth is executable under "globe" and "deck" but not "svg"', () => {
    // #6773 / R8 bug-fix pin: both DeckGLMap and GlobeMap paint the CII
    // choropleth, but the SVG fallback has no CII paint path. This is the
    // assertion that would have caught the layer being wrongly excluded
    // from the globe layer picker.
    assert.equal(isLayerExecutable('ciiChoropleth', 'deck'), true);
    assert.equal(isLayerExecutable('ciiChoropleth', 'globe'), true);
    assert.equal(isLayerExecutable('ciiChoropleth', 'svg'), false,
      'ciiChoropleth has no SVG render path');
  });

  test('a flat-surface layer admits svg + deck but not globe', () => {
    // `sanctions`/`dayNight` render on the SVG fallback and DeckGL, but
    // have no globe paint path.
    assert.equal(isLayerExecutable('sanctions', 'svg'), true);
    assert.equal(isLayerExecutable('sanctions', 'deck'), true);
    assert.equal(isLayerExecutable('sanctions', 'globe'), false,
      'sanctions has no globe renderer');
  });

  test('all-surface layer admits every kind', () => {
    // `pipelines` has renderers:['svg', 'deck', 'globe'] (default).
    assert.equal(isLayerExecutable('pipelines', 'svg'), true);
    assert.equal(isLayerExecutable('pipelines', 'deck'), true);
    assert.equal(isLayerExecutable('pipelines', 'globe'), true);
  });

  test('unknown layer key returns false', () => {
    // Typo or stale key -> must not accidentally pass the gate.
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerExecutable('nonexistentLayer', 'deck'), false);
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
    assert.equal(isLayerCommandAllowed('resilienceScore', true, 'deck', false), true);
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'deck', false), false);
  });

  test('premium and enhanced/free layers keep their expected toggle paths', () => {
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'deck', true), true);
    // ciiChoropleth is enhanced (free-toggleable) and renders on deck.
    assert.equal(isLayerCommandAllowed('ciiChoropleth', false, 'deck', false), true);
  });

  test('renderer compatibility still blocks commands independently of entitlement', () => {
    // resilience renders only on deck: globe is blocked even for premium.
    assert.equal(isLayerCommandAllowed('resilienceScore', false, 'globe', true), false);
    // storageFacilities is deck-only: the SVG fallback cannot run it.
    assert.equal(isLayerCommandAllowed('storageFacilities', false, 'svg', true), false);
    // ciiChoropleth renders on deck/globe but not the SVG fallback.
    assert.equal(isLayerCommandAllowed('ciiChoropleth', false, 'svg', false), false);
  });
});

describe('isLayerExecutable — matrix of layer x kind', () => {
  // Exhaustive matrix over the three renderer kinds for representative
  // layers. Future edits to the predicate that accidentally widen the
  // allowed set get caught here rather than in production.
  const cases: Array<{
    key: keyof typeof LAYER_REGISTRY;
    kind: 'svg' | 'deck' | 'globe';
    expect: boolean;
    why: string;
  }> = [
    // storageFacilities = ['deck'] (deck-only)
    { key: 'storageFacilities', kind: 'deck',  expect: true,  why: 'deck-only layer on deck' },
    { key: 'storageFacilities', kind: 'svg',   expect: false, why: 'deck-only layer rejects the SVG fallback' },
    { key: 'storageFacilities', kind: 'globe', expect: false, why: 'deck-only layer rejects globe' },
    // resilienceScore = ['deck'] (deck-only, locked)
    { key: 'resilienceScore',   kind: 'deck',  expect: true,  why: 'resilience on deck' },
    { key: 'resilienceScore',   kind: 'svg',   expect: false, why: 'resilience rejects SVG fallback' },
    { key: 'resilienceScore',   kind: 'globe', expect: false, why: 'resilience rejects globe' },
    // ciiChoropleth = ['deck', 'globe']
    { key: 'ciiChoropleth',     kind: 'deck',  expect: true,  why: 'CII on deck' },
    { key: 'ciiChoropleth',     kind: 'globe', expect: true,  why: 'CII on globe (the bug fix)' },
    { key: 'ciiChoropleth',     kind: 'svg',   expect: false, why: 'CII rejects the SVG fallback' },
    // sanctions = ['svg', 'deck'] (flat-surface, no globe)
    { key: 'sanctions',         kind: 'svg',   expect: true,  why: 'flat-surface layer on SVG' },
    { key: 'sanctions',         kind: 'deck',  expect: true,  why: 'flat-surface layer on deck' },
    { key: 'sanctions',         kind: 'globe', expect: false, why: 'flat-surface layer rejects globe' },
    // pipelines = ['svg', 'deck', 'globe'] (all surfaces)
    { key: 'pipelines',         kind: 'svg',   expect: true,  why: 'all-surface layer on SVG' },
    { key: 'pipelines',         kind: 'deck',  expect: true,  why: 'all-surface layer on deck' },
    { key: 'pipelines',         kind: 'globe', expect: true,  why: 'all-surface layer on globe' },
  ];

  for (const c of cases) {
    test(`${c.why}`, () => {
      assert.equal(isLayerExecutable(c.key, c.kind), c.expect, c.why);
    });
  }
});
