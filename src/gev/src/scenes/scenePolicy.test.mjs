import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  SCENE_EXCLUSIVITY_PROBE_LAYER_ID,
  SCENE_KEPT_SELECTION_PARAM_KEYS,
  SCENE_SELECTION_PARAM_PATTERN,
  SCENE_TRACKING_PARAM_KEYS,
  sceneLayerPlan,
  sceneRequiresContextModeExit,
  stripSceneTrackingParams,
} from './scenePolicy.js';
import { SCENE_RECIPES } from './recipes.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';

/**
 * Every key each layer publishes from getParams() — the exact surface
 * _captureLayerStates() snapshots into a shot.
 * @returns {Map<string, string[]>} layer source file → published param keys
 */
function sweepLayerParamKeys() {
  const byFile = new Map();
  const dataDir = new URL('../data/', import.meta.url);
  for (const entry of fs.readdirSync(dataDir)) {
    if (!entry.endsWith('.js')) continue;
    const source = fs.readFileSync(new URL(entry, dataDir), 'utf8');
    // Every getParams() in this codebase is a plain object return; take the
    // body up to its closing brace and read the keys it publishes.
    const body = source.match(/\n {2}getParams\(\)\s*\{[\s\S]*?\n {2}\},/);
    if (!body) continue;
    // A key always follows `{` or `,` — which matches both the multi-line
    // returns and the single-line `return { passive: … }` form, while a
    // ternary's `? x : y` (no brace or comma before the identifier) does not.
    const keys = [...body[0].matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1]);
    if (keys.length) byFile.set(entry, keys);
  }
  return byFile;
}

/** The layer registry as main.js builds it (src/main.js dataManager.register calls). */
const REGISTERED = new Set([
  'flights', 'military', 'earthquakes', 'satellites', 'rocket-launches', 'traffic',
  'cctv', 'radio', 'bikeshare', 'ais-live-vessels', 'military-installations',
  'military-awareness', 'local-datacenters', 'local-dams',
  'telegeography-submarine-cables', 'local-firms',
]);

test('a shot only reconciles the layers it declares', () => {
  const plan = sceneLayerPlan({ flights: { enabled: true } }, REGISTERED);
  assert.deepEqual(plan, [{ id: 'flights', enabled: true, params: undefined }]);
});

test('undeclared layers are never torn down by a four-layer recipe', () => {
  // Regression: the reconcile used to walk the live registry and force every
  // absent layer off, so a recipe authored against four layers destroyed the
  // twelve added since — with no restore pass to put them back.
  const plan = sceneLayerPlan(
    { flights: { enabled: true }, satellites: { enabled: false } },
    REGISTERED,
  );
  const touched = plan.map((entry) => entry.id);
  assert.deepEqual(touched, ['flights', 'satellites']);
  for (const untouched of ['cctv', 'radio', 'local-dams', 'local-datacenters', 'local-firms']) {
    assert.ok(!touched.includes(untouched), `${untouched} must be left alone`);
  }
});

test('an explicit false in a recipe still disables that layer', () => {
  const plan = sceneLayerPlan(
    { earthquakes: { enabled: true }, flights: { enabled: false }, traffic: { enabled: false } },
    REGISTERED,
  );
  assert.deepEqual(
    plan.filter((entry) => !entry.enabled).map((entry) => entry.id),
    ['flights', 'traffic'],
  );
});

test('an operator-captured shot declaring every layer still reconciles in full', () => {
  // captureShot() snapshots the whole registry, so full reconcile is preserved.
  const captured = Object.fromEntries(
    [...REGISTERED].map((id) => [id, { enabled: id === 'cctv' }]),
  );
  const plan = sceneLayerPlan(captured, REGISTERED);
  assert.equal(plan.length, REGISTERED.size);
  assert.deepEqual(plan.filter((entry) => entry.enabled).map((entry) => entry.id), ['cctv']);
});

test('layers no longer registered are skipped, not pushed at the data manager', () => {
  const plan = sceneLayerPlan(
    { flights: { enabled: true }, 'retired-layer': { enabled: true } },
    REGISTERED,
  );
  assert.deepEqual(plan.map((entry) => entry.id), ['flights']);
});

test('per-layer params ride along only when the shot carries them', () => {
  const plan = sceneLayerPlan(
    { satellites: { enabled: true, params: { catalog: 'dense' } }, flights: { enabled: true } },
    REGISTERED,
  );
  assert.deepEqual(plan[0], { id: 'satellites', enabled: true, params: { catalog: 'dense' } });
  assert.equal(plan[1].params, undefined);
});

test('missing or malformed target maps produce an empty plan', () => {
  assert.deepEqual(sceneLayerPlan(undefined, REGISTERED), []);
  assert.deepEqual(sceneLayerPlan({}, REGISTERED), []);
  assert.deepEqual(sceneLayerPlan({ flights: null }, REGISTERED), [
    { id: 'flights', enabled: false, params: undefined },
  ]);
});

test('every shipped recipe declares only registered layer ids', () => {
  for (const recipe of SCENE_RECIPES) {
    for (const layerId of Object.keys(recipe.layers || {})) {
      assert.ok(REGISTERED.has(layerId), `${recipe.id} declares unknown layer ${layerId}`);
    }
  }
});

test('camera-tracking params never survive into the plan', () => {
  const plan = sceneLayerPlan({
    flights: { enabled: true, params: { models3d: true, selectedFlightsTrackingId: 'a835af' } },
    military: { enabled: true, params: { selectedMilitaryTrackingId: 'ae1460' } },
  }, REGISTERED);
  assert.deepEqual(plan[0].params, { models3d: true });
  // A params bag that was tracking and nothing else leaves nothing to push.
  assert.equal(plan[1].params, undefined);
});

test('stripping leaves a tracking-free params object untouched', () => {
  const params = { catalog: 'dense', showOrbits: true };
  assert.equal(stripSceneTrackingParams(params), params);
  assert.equal(stripSceneTrackingParams(undefined), undefined);
  assert.equal(stripSceneTrackingParams(null), undefined);
  assert.ok(SCENE_TRACKING_PARAM_KEYS.length >= 3);
});

test('every selection-shaped layer param is classified, whatever its spelling', () => {
  // Forward-compat. The earlier sweep only recognised `selected…TrackingId`,
  // so a param named `trackedVesselMmsi` would have slipped past and a capture
  // taken while following that contact would recreate the two-camera-writer
  // bug. The family pattern is deliberately wider than today's three names:
  // any match must be explicitly stripped or explicitly kept.
  const classified = new Set([...SCENE_TRACKING_PARAM_KEYS, ...SCENE_KEPT_SELECTION_PARAM_KEYS]);
  const swept = sweepLayerParamKeys();
  assert.ok(swept.size >= 6, `expected the known layer param surfaces, saw ${swept.size}`);

  const seen = new Set();
  for (const [file, keys] of swept) {
    for (const key of keys) {
      if (!SCENE_SELECTION_PARAM_PATTERN.test(key)) continue;
      seen.add(key);
      assert.ok(
        classified.has(key),
        `${file} publishes selection param "${key}" — strip it (SCENE_TRACKING_PARAM_KEYS) `
        + 'or record why it is safe (SCENE_KEPT_SELECTION_PARAM_KEYS)',
      );
    }
  }
  // The documented lists must describe reality, not outlive it.
  for (const key of classified) {
    assert.ok(seen.has(key), `"${key}" is classified but no layer publishes it any more`);
  }
});

test('the family pattern catches selection names the old sweep would have missed', () => {
  for (const evader of ['trackedVesselMmsi', 'selectedVesselId', 'trackedNorad', 'primaryTargetIcao']) {
    assert.ok(SCENE_SELECTION_PARAM_PATTERN.test(evader), `${evader} must be caught`);
  }
  for (const ordinary of ['models3d', 'catalog', 'showOrbits', 'densityScale', 'coverageMode', 'calibration']) {
    assert.equal(SCENE_SELECTION_PARAM_PATTERN.test(ordinary), false, `${ordinary} is not a selection param`);
  }
});

test('the exclusivity probe id is reserved — no real layer may claim it', () => {
  // The probe asks a mode "would you refuse a layer you have no opinion
  // about?". If a real layer ever took this id, the probe would be asking
  // about a layer the mode DOES have an opinion on, and an isolating mode
  // could read as non-isolating.
  for (const entry of LAYER_STATE_REGISTRY) {
    assert.notEqual(entry.id, SCENE_EXCLUSIVITY_PROBE_LAYER_ID);
  }
  assert.equal(REGISTERED.has(SCENE_EXCLUSIVITY_PROBE_LAYER_ID), false);
  // Every real id is kebab-case; the sentinel deliberately is not.
  for (const entry of LAYER_STATE_REGISTRY) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/, `${entry.id} breaks the layer-id convention`);
  }
  assert.doesNotMatch(SCENE_EXCLUSIVITY_PROBE_LAYER_ID, /^[a-z][a-z0-9-]*$/);
});

test('an isolating context mode must be exited before a shot applies', () => {
  // Read off the shared guard, not a mode name: Space Missions refuses every
  // enable outside its replay bundle, so a shot applied inside it is not the
  // composition it describes.
  assert.equal(sceneRequiresContextModeExit('space-missions'), true);
  assert.equal(sceneRequiresContextModeExit('flights'), false);
  assert.equal(sceneRequiresContextModeExit(null), false);
  assert.equal(sceneRequiresContextModeExit(undefined), false);
});

test('shipped recipes touch only their four declared layers', () => {
  for (const recipe of SCENE_RECIPES) {
    const declared = Object.entries(recipe.layers || {})
      .map(([id, enabled]) => [id, { enabled }]);
    const plan = sceneLayerPlan(Object.fromEntries(declared), REGISTERED);
    assert.equal(plan.length, Object.keys(recipe.layers || {}).length, recipe.id);
    assert.ok(plan.length <= 4, `${recipe.id} should not reach beyond its declared layers`);
  }
});
