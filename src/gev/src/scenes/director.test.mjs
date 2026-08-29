// Director-level pins for scene playback.
//
// scenePolicy.test.mjs pins the pure decisions; these pin the wiring, which is
// where every regression in this file's history actually lived: the reconcile
// walking the whole registry, captured tracking params handing the camera back
// to the follow loop, a refused enable reported as success, STOP landing layer
// changes after the operator stopped, and a stale LOAD completing last.
//
// The cancellation pins matter twice over: checking a boolean AFTER an await
// only stops the NEXT step, so the awaited operation itself has to be
// cancellable — an AbortSignal for the data manager, a liveness predicate for
// the visual commit. Several of these assert exactly that plumbing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SceneDirector } from './director.js';
import { SCENE_TRACKING_PARAM_KEYS } from './scenePolicy.js';
import { SCENE_RECIPES } from './recipes.js';

/** The layer registry as main.js builds it (src/main.js dataManager.register calls). */
const REGISTERED = [
  'flights', 'military', 'earthquakes', 'satellites', 'rocket-launches', 'traffic',
  'cctv', 'radio', 'bikeshare', 'ais-live-vessels', 'military-installations',
  'military-awareness', 'local-datacenters', 'local-dams',
  'telegeography-submarine-cables', 'local-firms',
];

/** Layers Space Missions permits while it isolates the globe (contextModePolicy). */
const SPACE_MISSIONS_ALLOWED = new Set(['rocket-launches', 'satellites', 'radio']);

const PROJECT_FIXTURE = {
  version: 3,
  scenes: [{
    id: 'scene-1',
    title: 'Fixture Scene',
    shots: [
      {
        id: 'shot-a',
        title: 'Shot A',
        durationSec: 0.2,
        holdSec: 0,
        camera: { lat: 10, lon: 20, alt: 500000, heading: 0, pitch: -40, roll: 0 },
        visual: { style: 'normal' },
        layers: { flights: { enabled: true } },
      },
      {
        id: 'shot-b',
        title: 'Shot B',
        durationSec: 0.2,
        holdSec: 0,
        camera: { lat: -30, lon: 140, alt: 900000, heading: 0, pitch: -40, roll: 0 },
        visual: { style: 'retro' },
        layers: { traffic: { enabled: true } },
      },
    ],
  }],
};

/** Stub the browser globals the director touches, headlessly. */
function installSceneRuntime(project = PROJECT_FIXTURE) {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const noopClassList = { add() {}, remove() {}, toggle() {}, contains: () => false };

  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ classList: noopClassList, style: {}, appendChild() {}, remove() {} }),
    addEventListener() {},
    removeEventListener() {},
    body: { classList: noopClassList, appendChild() {} },
  };
  globalThis.localStorage = {
    getItem: () => JSON.stringify(project),
    setItem() {},
    removeItem() {},
  };

  return () => {
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  };
}

/**
 * Data manager double recording every reconcile call the director makes.
 *
 * Models the real abort contract (src/data/manager.js): an aborted transition
 * is rolled back through the module's own disable() and answers false, so an
 * abort leaves NO half-applied layer — which is the whole point of passing the
 * signal rather than only checking a boolean afterwards.
 */
function fakeDataManager({ registered = REGISTERED, refuse = () => false } = {}) {
  const enabled = new Map();
  const setEnabledCalls = [];
  const setParamsCalls = [];
  const committed = [];
  return {
    setEnabledCalls,
    setParamsCalls,
    committed,
    getAll: () => registered.map((id) => ({ id, enabled: !!enabled.get(id) })),
    getLayerParams: () => null,
    async setEnabled(id, shouldEnable, { signal } = {}) {
      setEnabledCalls.push({ id, enabled: shouldEnable, signal });
      if (refuse(id, shouldEnable)) return false;
      // Yield once so a stop landing during the transition is observable.
      await Promise.resolve();
      if (signal?.aborted) return false;
      enabled.set(id, shouldEnable);
      committed.push({ id, enabled: shouldEnable });
      return true;
    },
    setLayerParams(id, params) {
      setParamsCalls.push({ id, params });
      return true;
    },
  };
}

/** Style manager double covering the camera, visual, and Context facades. */
function fakeStyleManager({ contextMode = null, exitFails = false } = {}) {
  const manager = {
    contextMode,
    contextExits: [],
    visualStates: [],
    visualCalls: [],
    runImmediateNavigation: (noun, navigate) => navigate(),
    applyVisualState: async (visual, options = {}) => {
      manager.visualStates.push(visual);
      manager.visualCalls.push({ visual, isCurrent: options.isCurrent });
      return true;
    },
    getCameraState: () => ({ lat: 0, lon: 0, alt: 1000, heading: 0, pitch: -40, roll: 0 }),
    getVisualState: () => ({ style: 'normal' }),
    setRecordingMode() {},
    getContextModeState: () => ({ mode: manager.contextMode, entering: null }),
    async setContextMode(mode) {
      manager.contextExits.push(mode);
      if (exitFails) return { ok: false, error: 'transition did not complete' };
      manager.contextMode = null;
      return { ok: true };
    },
  };
  return manager;
}

/** Cesium viewer double whose flights complete on the next microtask turn. */
function fakeViewer() {
  const flights = [];
  let cancelled = 0;
  return {
    flights,
    get cancelledFlights() { return cancelled; },
    camera: {
      flyTo(options) {
        flights.push(options);
        Promise.resolve().then(() => options.complete?.());
      },
      cancelFlight() { cancelled++; },
    },
  };
}

/** Yield enough turns for the director's pending awaits to advance. */
async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Build a director over doubles, with the fixture project loaded. */
function makeDirector(options = {}) {
  const restore = installSceneRuntime(options.project);
  const viewer = fakeViewer();
  const styleManager = fakeStyleManager(options.style);
  const dataManager = fakeDataManager(options.data);
  const director = new SceneDirector(viewer, styleManager, dataManager);
  // Telemetry is only accumulated during a run; observable-failure assertions
  // need the accumulator without driving a whole run.
  director._activeRun = { events: [] };
  return { director, viewer, styleManager, dataManager, restore };
}

/** The layer map a shipped recipe declares, in normalized form. */
function recipeLayers(recipeId) {
  const recipe = SCENE_RECIPES.find((item) => item.id === recipeId);
  return Object.fromEntries(
    Object.entries(recipe.layers).map(([id, enabled]) => [id, { enabled }]),
  );
}

test('the director reconciles only the layers a shot declares', async () => {
  // Regression: _applyLayerStates walked the LIVE registry and forced every
  // undeclared layer off, tearing down CCTV/vessels/fires with no restore pass.
  // Pinned here rather than only on the helper, because the walk lived here.
  const { director, dataManager, restore } = makeDirector();
  try {
    await director._applyLayerStates({ flights: { enabled: true }, satellites: { enabled: false } });
    assert.deepEqual(
      dataManager.setEnabledCalls.map(({ id, enabled }) => ({ id, enabled })),
      [
        { id: 'flights', enabled: true },
        { id: 'satellites', enabled: false },
      ],
    );
  } finally {
    restore();
  }
});

test('a shot captured while tracking never re-establishes tracking on playback', async () => {
  // Two writers on the camera is the documented jitter failure mode: the scene
  // claims the camera, then a captured tracking id hands it straight back to
  // the follow loop. Playback drops those keys on the way to the layer.
  const { director, dataManager, restore } = makeDirector();
  try {
    await director._applyLayerStates({
      flights: { enabled: true, params: { models3d: true, selectedFlightsTrackingId: 'a835af' } },
      military: { enabled: true, params: { selectedMilitaryTrackingId: 'ae1460' } },
      satellites: { enabled: true, params: { catalog: 'dense', selectedSatTrackingId: 25544 } },
    });

    const pushed = Object.fromEntries(dataManager.setParamsCalls.map((call) => [call.id, call.params]));
    assert.deepEqual(pushed.flights, { models3d: true });
    assert.deepEqual(pushed.satellites, { catalog: 'dense' });
    // Nothing survived military's params, so nothing is pushed at all.
    assert.equal(Object.hasOwn(pushed, 'military'), false);
    for (const call of dataManager.setParamsCalls) {
      for (const key of SCENE_TRACKING_PARAM_KEYS) {
        assert.equal(Object.hasOwn(call.params, key), false, `${call.id} leaked ${key}`);
      }
    }
  } finally {
    restore();
  }
});

test('a dirty Space Missions state is exited before a recipe applies its layers', async () => {
  // Space Missions refuses every enable outside its own replay bundle. The old
  // full-registry walk dismantled it by accident; the sparse policy never does,
  // so all four Flights Radar enables were refused and reported as success.
  const style = { contextMode: 'space-missions' };
  const holder = {};
  const data = {
    refuse: (id, on) => on
      && holder.styleManager?.contextMode === 'space-missions'
      && !SPACE_MISSIONS_ALLOWED.has(id),
  };
  const { director, styleManager, dataManager, restore } = makeDirector({ style, data });
  holder.styleManager = styleManager;
  try {
    const result = await director._applyLayerStates(recipeLayers('flights-radar'));

    assert.deepEqual(styleManager.contextExits, ['off']);
    assert.equal(styleManager.contextMode, null);
    assert.deepEqual(result.refused, []);
    assert.ok(result.applied.includes('flights'));
    assert.deepEqual(
      dataManager.setEnabledCalls.filter((call) => call.enabled).map((call) => call.id),
      ['flights'],
    );
  } finally {
    restore();
  }
});

test('Orbital Watch does not compose over a Space Missions replay', async () => {
  // Orbital Watch declares satellites, which the guard permits — so nothing is
  // refused and a refusal-only check would pass while rocket-launches stayed
  // on screen. Playback leaves an isolating mode whether or not it refuses.
  const { director, styleManager, dataManager, restore } = makeDirector({
    style: { contextMode: 'space-missions' },
  });
  try {
    await director._applyLayerStates(recipeLayers('orbital-watch'));
    assert.deepEqual(styleManager.contextExits, ['off']);
    assert.equal(
      dataManager.setEnabledCalls.some((call) => call.id === 'rocket-launches'),
      false,
      'the recipe never declares rocket-launches; exiting the mode is what clears it',
    );
  } finally {
    restore();
  }
});

test('a non-isolating context mode is left alone', async () => {
  for (const contextMode of [null, 'flights']) {
    const { director, styleManager, restore } = makeDirector({ style: { contextMode } });
    try {
      await director._applyLayerStates({ flights: { enabled: true } });
      assert.deepEqual(styleManager.contextExits, [], `${contextMode} must not be exited`);
    } finally {
      restore();
    }
  }
});

test('a refused layer is reported, never counted as applied', async () => {
  const { director, dataManager, restore } = makeDirector({
    data: { refuse: (id) => id === 'flights' },
  });
  try {
    const result = await director._applyLayerStates({
      flights: { enabled: true, params: { models3d: true } },
      traffic: { enabled: false },
    });

    assert.deepEqual(result.refused, ['flights']);
    assert.deepEqual(result.applied, ['traffic']);
    // Params must not be pushed at a layer whose transition was vetoed.
    assert.deepEqual(dataManager.setParamsCalls, []);
    const refusals = director._activeRun.events.filter((event) => event.type === 'shot_layers_refused');
    assert.equal(refusals.length, 1);
    assert.deepEqual(refusals[0].payload, { layerIds: ['flights'] });
  } finally {
    restore();
  }
});

test('cancellation between two layers ends the reconcile where it stands', async () => {
  const { director, dataManager, restore } = makeDirector();
  const token = { cancelled: false };
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = async (id, on) => {
    const settled = await inner(id, on);
    if (id === 'flights') token.cancelled = true;
    return settled;
  };
  try {
    const result = await director._applyLayerStates({
      flights: { enabled: true },
      satellites: { enabled: true },
      traffic: { enabled: true },
    }, token);

    assert.deepEqual(dataManager.setEnabledCalls.map((call) => call.id), ['flights']);
    assert.equal(result.cancelled, true);
  } finally {
    restore();
  }
});

test('STOP during a suspended visual transition lands no layer changes', async () => {
  // Repro shape from review: applyVisualState suspends (a map-stack switch),
  // STOP arrives, the visual resolves — and the shot's layer pass still ran.
  const { director, viewer, styleManager, dataManager, restore } = makeDirector();
  let releaseVisual;
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    return new Promise((resolve) => { releaseVisual = resolve; });
  };
  try {
    const run = director.startScene('scene-1', { single: true });
    await settle();
    assert.equal(styleManager.visualStates.length, 1, 'the run must be parked on the visual await');

    director.stopScene('Stopped (Esc)');
    releaseVisual();
    await run;

    assert.deepEqual(dataManager.setEnabledCalls, []);
    assert.deepEqual(viewer.flights, []);
    assert.equal(director.running, false);
  } finally {
    restore();
  }
});

test('STOP between two layers lands no further layer changes', async () => {
  const { director, dataManager, restore } = makeDirector({
    project: {
      version: 3,
      scenes: [{
        id: 'scene-1',
        title: 'Fixture Scene',
        shots: [{
          id: 'shot-a',
          title: 'Shot A',
          durationSec: 0.2,
          holdSec: 0,
          camera: { lat: 10, lon: 20, alt: 500000, heading: 0, pitch: -40, roll: 0 },
          visual: { style: 'normal' },
          layers: { flights: { enabled: true }, satellites: { enabled: true }, traffic: { enabled: true } },
        }],
      }],
    },
  });
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = async (id, on) => {
    const settled = await inner(id, on);
    if (id === 'flights') director.stopScene('Stopped (Esc)');
    return settled;
  };
  try {
    await director.startScene('scene-1', { single: true });
    assert.deepEqual(dataManager.setEnabledCalls.map((call) => call.id), ['flights']);
  } finally {
    restore();
  }
});

test('STOP aborts the layer transition in flight, not merely the next one', async () => {
  // Checking the token AFTER the await is a backstop, not the fix: by then an
  // un-aborted transition has already committed, and the pass returns without
  // its params — the layer left enabled carrying stale ones. The signal is
  // what actually stops the layer that is currently moving.
  const { director, dataManager, restore } = makeDirector({
    project: {
      version: 3,
      scenes: [{
        id: 'scene-1',
        title: 'Fixture Scene',
        shots: [{
          id: 'shot-a',
          title: 'Shot A',
          durationSec: 0.2,
          holdSec: 0,
          camera: { lat: 10, lon: 20, alt: 500000, heading: 0, pitch: -40, roll: 0 },
          visual: { style: 'normal' },
          layers: {
            flights: { enabled: true, params: { models3d: true } },
            satellites: { enabled: true },
          },
        }],
      }],
    },
  });
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = (id, on, options) => {
    // STOP lands while the transition is in flight, before it can commit.
    if (id === 'flights') director.stopScene('Stopped (Esc)');
    return inner(id, on, options);
  };
  try {
    await director.startScene('scene-1', { single: true });

    assert.equal(dataManager.setEnabledCalls.length, 1, 'only the in-flight layer is touched');
    assert.ok(
      dataManager.setEnabledCalls[0].signal instanceof AbortSignal,
      'the run must hand its abort signal to every transition',
    );
    assert.equal(dataManager.setEnabledCalls[0].signal.aborted, true, 'STOP must abort that signal');
    assert.deepEqual(dataManager.committed, [], 'an aborted transition must not commit');
    assert.deepEqual(dataManager.setParamsCalls, [], 'no params for a layer that never moved');
  } finally {
    restore();
  }
});

test('a newer LOAD aborts the previous LOAD transition rather than disowning it', async () => {
  const { director, styleManager, dataManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => { gates.push(resolve); });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    await settle();
    const second = director.loadShot('scene-1', 'shot-b');
    gates[0]();
    gates[1]();
    await Promise.all([first, second]);

    // Only the newer LOAD reconciled, and it carried a live (unaborted) signal.
    assert.deepEqual(dataManager.setEnabledCalls.map((call) => call.id), ['traffic']);
    assert.ok(dataManager.setEnabledCalls[0].signal instanceof AbortSignal);
    assert.equal(dataManager.setEnabledCalls[0].signal.aborted, false);
  } finally {
    restore();
  }
});

test('applyVisualState gates the map-stack switch on both sides of its await', () => {
  // The other half of the contract, and the half these doubles cannot see.
  // ui.js cannot be imported here (its mgrs dependency is CJS), so this pins
  // the structure the way the repo pins other cross-module shape
  // (cockpitMarkup.test.mjs), while qa-shots/scenes-audit.mjs proves the
  // BEHAVIOUR against the real StyleManager in a browser.
  //
  // Gating only the post-await uniform commit is not enough: the stack switch
  // is ITSELF a mutation. The controller invalidates a switch only when
  // another setStack() arrives, and a winning state that omits `mapStack`
  // never issues one — every normalized scene shot omits it — so a stale
  // switch would otherwise stand on the globe.
  const source = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  const method = source.match(/\n {2}async applyVisualState\([\s\S]*?\n {2}\}\n/);
  assert.ok(method, 'applyVisualState is missing from ui.js');
  assert.match(method[0], /async applyVisualState\(state = \{\}, \{ isCurrent = null \} = \{\}\)/);

  const mapStackBlock = method[0].match(/if \(state\.mapStack\) \{[\s\S]*?\n {4}\}/);
  assert.ok(mapStackBlock, 'the map-stack block is missing from applyVisualState');
  const block = mapStackBlock[0];

  // Before: an already-superseded caller must not start the switch at all.
  assert.match(
    block,
    /if \(superseded\(\)\) return false;\s*const stackBefore =/,
    'the switch must be skipped outright when the caller is already superseded',
  );
  // After: supersession that landed DURING the switch must put the globe back.
  assert.match(
    block,
    /await this\._setMapStack\(state\.mapStack[\s\S]*?if \(superseded\(\)\) \{[\s\S]*?await this\._setMapStack\(stackBefore/,
    'a switch superseded mid-flight must be reverted to the stack the winner inherited',
  );
  // And only what is still ours — a newer switch owns the globe, never revert it.
  assert.match(block, /getSwitchGeneration/, 'the revert must consult the switch generation');
  assert.match(
    block,
    /if \(globeIsStillOurs && stackBefore && landed !== stackBefore\) \{\s*await this\._setMapStack\(stackBefore/,
    'the revert must be guarded by the generation check and the stack that actually landed',
  );
});

test('a superseded LOAD is refused its visual commit', async () => {
  // applyVisualState suspends on a map-stack switch and writes its shader
  // uniforms AFTER that await. A stale LOAD resuming there would commit the
  // look of a shot the operator has already moved past, so the director hands
  // it a liveness predicate that is false by the time it would commit.
  const { director, styleManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => { gates.push(resolve); });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    const second = director.loadShot('scene-1', 'shot-b');
    gates[1]();
    await settle();
    gates[0]();
    await Promise.all([first, second]);

    const [stale, live] = styleManager.visualCalls;
    assert.equal(typeof stale.isCurrent, 'function', 'the visual call must carry a liveness predicate');
    assert.equal(stale.isCurrent(), false, 'the superseded LOAD must be refused its commit');
    assert.equal(live.isCurrent(), true, 'the live LOAD must still be allowed to commit');
  } finally {
    restore();
  }
});

test('a run refuses the visual commit of a shot cancelled mid-transition', async () => {
  const { director, styleManager, restore } = makeDirector();
  let releaseVisual;
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => { releaseVisual = resolve; });
  };
  const run = director.startScene('scene-1', { single: true });
  try {
    await settle();
    const call = styleManager.visualCalls[0];
    assert.equal(typeof call.isCurrent, 'function', 'the visual call must carry a liveness predicate');
    assert.equal(call.isCurrent(), true, 'live while the run owns the shot');

    director.stopScene('Stopped (Esc)');
    assert.equal(call.isCurrent(), false, 'STOP must revoke the pending commit');
  } finally {
    // Always let the run finish: _finishRun() owns the progress interval, so a
    // failed assertion that skipped this would leave a live timer behind and
    // hang the suite instead of reporting.
    director.stopScene('cleanup');
    releaseVisual?.();
    await run;
    restore();
  }
});

test('the newest LOAD wins when two loads race', async () => {
  // Both loads suspend on their visual await; the OLDER one resolves second.
  // Without a generation it completes last and overwrites the newer intent.
  const { director, viewer, styleManager, dataManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    return new Promise((resolve) => { gates.push(resolve); });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    const second = director.loadShot('scene-1', 'shot-b');
    assert.equal(gates.length, 2);

    gates[1]();
    await settle();
    gates[0]();
    await Promise.all([first, second]);

    assert.deepEqual(
      dataManager.setEnabledCalls.map(({ id, enabled }) => ({ id, enabled })),
      [{ id: 'traffic', enabled: true }],
    );
    assert.equal(viewer.flights.length, 1);
    assert.equal(director._selectedShotId, 'shot-b');
  } finally {
    restore();
  }
});

test('a scene run supersedes a LOAD still suspended on its visual await', async () => {
  const { director, styleManager, dataManager, restore } = makeDirector();
  let releaseLoadVisual;
  let calls = 0;
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    if (++calls === 1) return new Promise((resolve) => { releaseLoadVisual = resolve; });
    return Promise.resolve();
  };
  try {
    const load = director.loadShot('scene-1', 'shot-a');
    await settle();
    const run = director.startScene('scene-1', { single: true });
    releaseLoadVisual();
    await Promise.all([load, run]);

    // Only the run's own shots reconciled; the stale LOAD's flights never did.
    assert.deepEqual(
      dataManager.setEnabledCalls.map((call) => call.id),
      ['flights', 'traffic'],
    );
  } finally {
    restore();
  }
});
