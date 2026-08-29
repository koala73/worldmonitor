import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { MAP_STACKS } from '../mapStackController.js';
import {
  CABLE_LABEL_DEPTH_DECISION,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_STEM_TIP_EPSILON_M,
  CABLE_SWEEP_MOTION_EPSILON_M,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  applyTranslucentMarkerBlend,
  cableClassificationTypeForScene,
  cableClassificationTypeForStack,
  cableReferencePriority,
  createCableOverlayEntry,
  createCableOverlayPublisher,
  createCableReferenceSweepGate,
  createTeleGeographySubmarineCableLayer,
  selectCableReferenceLabelWinners,
  updateCableReferenceStem,
} from './telegeographySubmarineCables.js';

test('cable reference winners remain nearest-first and hard-capped', () => {
  const records = Array.from({ length: 300 }, (_, index) => ({
    entity: { id: `reference-${index}` },
    label: `Reference ${index}`,
    visible: true,
    distanceM: 1000 + index,
  }));

  let winners = selectCableReferenceLabelWinners(records);
  assert.equal(winners.length, CABLE_REFERENCE_LABEL_WINNER_CAP);
  assert.equal(winners[0], records[0]);
  assert.equal(winners.at(-1), records[CABLE_REFERENCE_LABEL_WINNER_CAP - 1]);

  for (let index = 0; index < 80; index++) records[index].visible = false;
  winners = selectCableReferenceLabelWinners(records);
  assert.equal(winners.length, CABLE_REFERENCE_LABEL_WINNER_CAP);
  assert.equal(winners[0], records[80], 'hidden references release their slots to the next nearest');

  records[90].distanceM = 10_000_000; // beyond the 9,000 km reference range
  winners = selectCableReferenceLabelWinners(records);
  assert.ok(!winners.includes(records[90]), 'out-of-range references never reach the host');
});

test('cable overlay entries satisfy the shared presentation contract', () => {
  const tip = Cesium.Cartesian3.fromDegrees(-40, 35, 2500);
  const record = {
    id: 'cable-reference-0-atlantic-1',
    kind: 'cable',
    label: 'Atlantic Crossing-1',
    tip,
    distanceM: 400_000,
  };
  const entry = createCableOverlayEntry(record);

  assert.equal(entry.id, 'cable-reference-0-atlantic-1');
  assert.equal(entry.position, tip, 'entry stays attached to the mutable stem-tip Cartesian');
  assert.equal(entry.variant, 'label');
  assert.equal(entry.title, 'Atlantic Crossing-1');
  assert.equal(entry.accent, '#39d5ff');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(entry.interactive, false, 'point/stem/line picking remains Cesium-native');
  assert.equal(entry.maxDistance, 9_000_000);
  assert.equal(entry.distanceFadeStartRatio, 0.7);
  assert.deepEqual(entry.distanceScale, {
    near: 250_000,
    nearValue: 1,
    far: 9_000_000,
    farValue: 0.62,
  }, 'former native scaleByDistance curve is preserved');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(entry.terrainOcclusion, false);
  assert.equal(entry.verticalOnly, true);
  assert.equal(entry.placement, 'above');

  const landing = createCableOverlayEntry({
    id: 'landing-point-reference-1-lisbon',
    kind: 'landing-point',
    label: 'Lisbon, Portugal',
    tip,
    distanceM: 100_000,
  });
  assert.equal(landing.accent, '#8fffd2', 'landing points keep their mint accent');
  assert.equal(landing.interactive, false);
});

test('cable reference priority is nearest-first and sweep-stable', () => {
  assert.ok(cableReferencePriority(1_000) > cableReferencePriority(1_000_000));
  assert.ok(cableReferencePriority(1_000_000) > cableReferencePriority(8_000_000));
  assert.equal(
    cableReferencePriority(500_000),
    cableReferencePriority(500_000 + 10_000),
    '50 km quantization keeps slow camera drift from reshuffling ranks',
  );
  assert.equal(
    cableReferencePriority(undefined),
    cableReferencePriority(9_000_000),
    'missing distances rank like the range edge instead of jumping the queue',
  );
});

test('cable overlay publisher owns the production show/publish/hide lifecycle', () => {
  const calls = [];
  const publisher = createCableOverlayPublisher({
    host: {
      setVisible: (...args) => calls.push(['visible', ...args]),
      setEntries: (...args) => calls.push(['entries', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
  });

  publisher.publish([{ id: 'ignored-before-show' }]);
  publisher.show();
  publisher.show();
  publisher.publish([{ id: 'cable-1' }]);
  publisher.hide();
  publisher.publish([{ id: 'dropped-while-hidden' }]);
  publisher.hide();

  assert.deepEqual(calls[0], ['visible', CABLE_OVERLAY_SOURCE_ID, true]);
  assert.deepEqual(calls[1].slice(0, 3), ['entries', CABLE_OVERLAY_SOURCE_ID, [{ id: 'cable-1' }]]);
  assert.deepEqual(calls[1][3], {
    cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
    collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  });
  assert.deepEqual(calls[2], ['clear', CABLE_OVERLAY_SOURCE_ID]);
  assert.deepEqual(calls[3], ['visible', CABLE_OVERLAY_SOURCE_ID, false]);
  assert.equal(calls.length, 4, 'hidden publishers drop late publishes; repeat hide is a no-op');

  // The production teardown (layer.destroy) is hide(): the publisher stays
  // reusable for the layer's supported re-init-after-destroy contract. There
  // is intentionally no permanent-destroy method to test.
  assert.equal(publisher.destroy, undefined);
  publisher.show();
  publisher.publish([{ id: 'cable-2' }]);
  assert.deepEqual(calls[4], ['visible', CABLE_OVERLAY_SOURCE_ID, true]);
  assert.deepEqual(calls[5].slice(0, 3), ['entries', CABLE_OVERLAY_SOURCE_ID, [{ id: 'cable-2' }]]);
});

test('cable ground lines classify against exactly the active surface on every stack', () => {
  // Photorealistic tiles render with the globe hidden — 3D-tile pass only.
  assert.equal(
    cableClassificationTypeForStack('photoreal'),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  // Every globe stack renders imagery on the shown globe — terrain pass only.
  for (const stackId of ['bing-aerial', 'bing-labels', 'osm']) {
    assert.equal(
      cableClassificationTypeForStack(stackId),
      Cesium.ClassificationType.TERRAIN,
      `${stackId} must classify against terrain so cables stay visible there`,
    );
  }
  // Unknown stack → BOTH: visible on every surface, the shipped fallback.
  // A TRUTHY unknown id must reach it too — "not photoreal" is not the same
  // claim as "renders on the globe", and asserting TERRAIN for an id this
  // module has never heard of would hide the cables on a future 3D-tile
  // stack instead of degrading to the documented safe behavior.
  assert.equal(cableClassificationTypeForStack('some-future-stack'), Cesium.ClassificationType.BOTH);
  assert.equal(cableClassificationTypeForStack('photoreal-v2'), Cesium.ClassificationType.BOTH);
  assert.equal(cableClassificationTypeForStack(''), Cesium.ClassificationType.BOTH);
  assert.equal(cableClassificationTypeForStack(undefined), Cesium.ClassificationType.BOTH);
  assert.equal(cableClassificationTypeForStack(null), Cesium.ClassificationType.BOTH);

  // Every id that actually ships must be a KNOWN id: a stack added to
  // MAP_STACKS without a mapping here silently loses its halved command set,
  // so the omission fails loudly instead of degrading quietly.
  for (const stack of MAP_STACKS) {
    assert.notEqual(
      cableClassificationTypeForStack(stack.id),
      Cesium.ClassificationType.BOTH,
      `MAP_STACKS id '${stack.id}' has no cable classification mapping`,
    );
  }

  // Boot fires no stack event; the initial value derives from live scene
  // state exactly like the height-datum listeners: photoreal ⇔ globe hidden.
  assert.equal(
    cableClassificationTypeForScene({ globe: { show: false } }),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  assert.equal(
    cableClassificationTypeForScene({ globe: { show: true } }),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(cableClassificationTypeForScene(null), Cesium.ClassificationType.BOTH);
});

test('a map-stack change re-classifies every cable line once, and destroy detaches the listener', async () => {
  const listeners = new Map();
  const eventTarget = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
  const env = await createRealCableLayerHarness({ mapStackEventTarget: eventTarget });
  const cableSource = env.dataSources.find((ds) => /Submarine Cables/.test(ds.name || ''));
  const classificationOf = (entity) => entity.polyline.classificationType.getValue();

  // The harness scene has no globe → BOTH at init (safe unknown fallback).
  const cableEntity = cableSource.entities.values[0];
  assert.equal(classificationOf(cableEntity), Cesium.ClassificationType.BOTH);
  const listener = listeners.get('gev:map-stack-changed');
  assert.equal(typeof listener, 'function', 'init must subscribe to the stack event');

  listener({ detail: { activeId: 'photoreal', status: 'ready' } });
  assert.equal(classificationOf(cableEntity), Cesium.ClassificationType.CESIUM_3D_TILE);

  listener({ detail: { activeId: 'osm', status: 'ready' } });
  assert.equal(classificationOf(cableEntity), Cesium.ClassificationType.TERRAIN);

  env.layer.destroy(env.viewer);
  assert.equal(listeners.has('gev:map-stack-changed'), false, 'destroy must detach the stack listener');
});

test('marker collections blend in a single translucent pass behind a loud shape invariant', async () => {
  // Helper contract on a REAL Cesium cluster shape.
  const ds = new Cesium.CustomDataSource('blend-probe');
  let result = applyTranslucentMarkerBlend(ds);
  assert.deepEqual(result, { applied: 0, pending: 2, invariantFailed: false },
    'pre-visualizer clusters are pending, never a shape failure');

  ds.clustering._billboardCollection = new Cesium.BillboardCollection();
  ds.clustering._pointCollection = new Cesium.PointPrimitiveCollection();
  result = applyTranslucentMarkerBlend(ds);
  assert.deepEqual(result, { applied: 2, pending: 0, invariantFailed: false });
  assert.equal(ds.clustering._billboardCollection.blendOption, Cesium.BlendOption.TRANSLUCENT);
  assert.equal(ds.clustering._pointCollection.blendOption, Cesium.BlendOption.TRANSLUCENT);

  // Shape drift fails LOUDLY-detectably instead of applying blindly: a
  // renamed field or a foreign object type must never be touched.
  assert.equal(applyTranslucentMarkerBlend({ clustering: {} }).invariantFailed, true,
    'missing private fields mean Cesium changed shape');
  const wrongType = new Cesium.CustomDataSource('wrong-type');
  wrongType.clustering._billboardCollection = { blendOption: 0 };
  const wrongResult = applyTranslucentMarkerBlend(wrongType);
  assert.equal(wrongResult.invariantFailed, true);
  assert.equal(wrongType.clustering._billboardCollection.blendOption, 0, 'foreign objects are left untouched');
  assert.equal(applyTranslucentMarkerBlend(null).invariantFailed, true);

  // ATOMICITY: a shape failure on the SECOND collection must not leave the
  // FIRST one already forced. Validation of every field/type completes before
  // the first assignment, so a failed probe applies nothing at all — that is
  // what "leaves Cesium's default blend untouched" has to mean.
  const partial = new Cesium.CustomDataSource('partial-shape');
  partial.clustering._billboardCollection = new Cesium.BillboardCollection();
  partial.clustering._pointCollection = { blendOption: 0 }; // renamed/reshaped
  const partialResult = applyTranslucentMarkerBlend(partial);
  assert.equal(partialResult.invariantFailed, true);
  assert.equal(partialResult.applied, 0, 'a failed probe reports zero applications');
  assert.equal(
    partial.clustering._billboardCollection.blendOption,
    Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT,
    'the valid first collection keeps Cesium\'s default blend when the second fails',
  );
  assert.equal(partial.clustering._pointCollection.blendOption, 0, 'the malformed collection is never touched');

  // Real-layer wiring: once the visualizers have created the collections,
  // the next sweep applies the single-pass blend to both marker sources.
  const env = await createRealCableLayerHarness();
  env.raiseSweep();
  const landingSource = env.dataSources.find((source) => /Landing Points/.test(source.name || ''));
  const referenceSource = env.dataSources.find((source) => /References/.test(source.name || ''));
  landingSource.clustering._billboardCollection = new Cesium.BillboardCollection();
  landingSource.clustering._pointCollection = new Cesium.PointPrimitiveCollection();
  referenceSource.clustering._billboardCollection = new Cesium.BillboardCollection();
  referenceSource.clustering._pointCollection = new Cesium.PointPrimitiveCollection();
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(
    landingSource.clustering._billboardCollection.blendOption,
    Cesium.BlendOption.TRANSLUCENT,
    'landing billboards blend in one pass after the sweep',
  );
  assert.equal(
    referenceSource.clustering._pointCollection.blendOption,
    Cesium.BlendOption.TRANSLUCENT,
    'reference points blend in one pass after the sweep',
  );
  env.layer.destroy(env.viewer);

  // The same atomicity holds ACROSS the two marker sources: the layer probes
  // both before committing either, so a reshaped reference source can never
  // leave the landing source already forced to TRANSLUCENT.
  const failEnv = await createRealCableLayerHarness();
  const failLanding = failEnv.dataSources.find((source) => /Landing Points/.test(source.name || ''));
  const failReference = failEnv.dataSources.find((source) => /References/.test(source.name || ''));
  failLanding.clustering._billboardCollection = new Cesium.BillboardCollection();
  failLanding.clustering._pointCollection = new Cesium.PointPrimitiveCollection();
  delete failReference.clustering._pointCollection; // Cesium reshaped
  failEnv.raiseSweep();
  assert.equal(
    failLanding.clustering._billboardCollection.blendOption,
    Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT,
    'a reference-source shape failure leaves the landing source on the default blend',
  );
  failEnv.layer.destroy(failEnv.viewer);
});

test('cable reference sweep gate is dirty-only — no timer path', () => {
  const gate = createCableReferenceSweepGate();
  assert.equal(gate.shouldRun(), true, 'initial dirtiness covers enable/load');
  // However many frames render, an un-dirtied gate never runs the sweep —
  // the former 500 ms timer path is gone.
  for (let frame = 0; frame < 200; frame++) {
    assert.equal(gate.shouldRun(), false);
  }
  gate.markDirty();
  assert.equal(gate.shouldRun(), true, 'moveEnd dirtiness runs exactly once');
  assert.equal(gate.shouldRun(), false);
  gate.reset();
  assert.equal(gate.shouldRun(), true, 'reset restores the initial dirtiness');
});

test('the sweep gate falls back to motion probes for cameras that never emit moveEnd', () => {
  let clock = 0;
  const frameMs = 1000 / 60;
  const origin = Cesium.Cartesian3.fromDegrees(-40, 35, 4_500_000);
  const camera = { positionWC: Cesium.Cartesian3.clone(origin) };
  const gate = createCableReferenceSweepGate({ now: () => clock });
  const runFrames = (count, step = () => {}) => {
    let sweeps = 0;
    for (let frame = 0; frame < count; frame++) {
      clock += frameMs;
      step(frame);
      if (gate.shouldRun(camera)) sweeps++;
    }
    return sweeps;
  };

  assert.equal(gate.shouldRun(camera), true, 'initial dirtiness still covers enable/load');

  // PARKED: 100 s of frames on a camera that never moves must cost ZERO
  // sweeps — the fallback is motion-aware, not a reinstated timer.
  assert.equal(runFrames(6000), 0, 'a parked camera costs zero sweeps however long frames flow');

  // Sub-epsilon jitter is not motion either: the probe compares against the
  // last SWEPT position, so numeric noise can never accumulate into a sweep.
  const jitter = runFrames(6000, (frame) => {
    camera.positionWC = Cesium.Cartesian3.add(
      origin,
      new Cesium.Cartesian3(0, 0, (frame % 2) * (CABLE_SWEEP_MOTION_EPSILON_M / 10)),
      new Cesium.Cartesian3(),
    );
  });
  assert.equal(jitter, 0, 'sub-epsilon camera jitter never earns a sweep');

  // TRACKING: a follow camera advances every frame and never emits moveEnd.
  // The sweep must land inside one probe window instead of starving forever.
  const timedGate = createCableReferenceSweepGate({ now: () => clock });
  const timedCamera = { positionWC: Cesium.Cartesian3.clone(origin) };
  assert.equal(timedGate.shouldRun(timedCamera), true, 'the gate starts dirty');
  const trackingStart = clock;
  let sweepAt = null;
  for (let frame = 0; frame < 600 && sweepAt === null; frame++) {
    clock += frameMs;
    timedCamera.positionWC = Cesium.Cartesian3.add(
      origin,
      new Cesium.Cartesian3(0, 0, 12 * (frame + 1)), // ~0.7 km/s: a tracked jet
      new Cesium.Cartesian3(),
    );
    if (timedGate.shouldRun(timedCamera)) sweepAt = clock;
  }
  assert.notEqual(sweepAt, null, 'a continuously moving camera must not starve the sweep');
  assert.ok(
    sweepAt - trackingStart <= CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS + frameMs,
    `the fallback sweep must land inside one probe window (landed at ${sweepAt - trackingStart} ms)`,
  );
  assert.ok(
    sweepAt - trackingStart >= CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
    'and never sooner — the probe stays bounded to one sample per window',
  );

  // moveEnd still wins immediately: an event-dirtied gate does not wait for
  // the probe window it is sitting inside.
  timedGate.markDirty();
  assert.equal(timedGate.shouldRun(timedCamera), true, 'moveEnd dirtiness bypasses the probe window');
  assert.equal(timedGate.shouldRun(timedCamera), false, 'and still runs exactly once');

  // A gate called without a camera keeps the pure dirty-only contract.
  const cameraless = createCableReferenceSweepGate({ now: () => clock });
  assert.equal(cameraless.shouldRun(), true);
  clock += CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS * 10;
  assert.equal(cameraless.shouldRun(), false, 'no camera state means no motion fallback');
});

function makeStemRecord(lon = -40, lat = 35) {
  const base = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const tip = Cesium.Cartesian3.fromDegrees(lon, lat, 2500);
  const stemPositionBuffers = [[base, tip], [base, tip]];
  const setCalls = { position: 0, polyline: 0, polylineArrays: [] };
  return {
    record: {
      entity: {
        position: { setValue: () => { setCalls.position++; } },
        polyline: {
          positions: {
            setValue: (value) => {
              setCalls.polyline++;
              setCalls.polylineArrays.push(value);
            },
          },
        },
      },
      base,
      tip,
      nextTip: Cesium.Cartesian3.clone(tip),
      stemPositionBuffers,
      stemPositionBufferIndex: 0,
      reference: { lon, lat },
    },
    setCalls,
    stemPositionBuffers,
  };
}

test('staticized stems redefine constants only on real tip changes, alternating buffers', () => {
  const { record, setCalls, stemPositionBuffers } = makeStemRecord();
  const canvasHeight = 900;
  const fov = Math.PI / 3;
  const camera = Cesium.Cartesian3.fromDegrees(-40, 35, 500_000);

  assert.equal(updateCableReferenceStem(record, camera, canvasHeight, fov), true);
  assert.equal(setCalls.position, 1);
  assert.equal(setCalls.polyline, 1);
  assert.equal(setCalls.polylineArrays[0], stemPositionBuffers[1], 'first real update selects the alternate buffer');

  // Sub-epsilon camera noise must not redefine anything.
  const jitter = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(CABLE_STEM_TIP_EPSILON_M / 10, 0, 0),
    new Cesium.Cartesian3(),
  );
  assert.equal(updateCableReferenceStem(record, jitter, canvasHeight, fov), false);
  assert.equal(setCalls.position, 1);
  assert.equal(setCalls.polyline, 1);

  // A real camera move flips back to the first buffer: steady state allocates
  // no arrays beyond the two preallocated ones.
  const moved = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(0, 0, 400_000),
    new Cesium.Cartesian3(),
  );
  assert.equal(updateCableReferenceStem(record, moved, canvasHeight, fov), true);
  assert.equal(setCalls.polylineArrays[1], stemPositionBuffers[0]);
  assert.equal(new Set(setCalls.polylineArrays).size, 2);

  // Stem height honors the shipped 700 m..85 km clamp.
  const tipCarto = Cesium.Cartographic.fromCartesian(record.tip);
  assert.ok(tipCarto.height >= 700 && tipCarto.height <= 85_000);
});

test('the depth decision is the dated Option-2 host migration, superseding Option 1', () => {
  assert.deepEqual(CABLE_LABEL_DEPTH_DECISION, {
    option: 2,
    decidedAt: '2026-08-18',
    supersedes: '2026-08-02',
    depthTested: false,
  });
});

test('cables create no native labels and no per-frame geometry callbacks', () => {
  const source = readFileSync(new URL('./telegeographySubmarineCables.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Cesium\.LabelGraphics/, 'reverting to native labels must fail this pin');
  assert.doesNotMatch(source, /new Cesium\.CallbackProperty/, 'reverting to per-frame stem callbacks must fail this pin');
  assert.match(source, /setOverlayEntries/, 'labels must flow through the shared world-overlay host');
  assert.match(source, /record\.entity\.position\.setValue\(record\.tip\)/);
  assert.match(source, /const stemPositionBuffers = \[\[base, tip\], \[base, tip\]\]/);
  assert.match(source, /record\.entity\.polyline\.positions\.setValue\(stemPositions\)/);
});

const CABLE_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'ac1',
      properties: { id: 'ac1', name: 'Atlantic Crossing-1' },
      geometry: { type: 'LineString', coordinates: [[-40, 35], [-30, 40]] },
    },
  ],
};
// Node has no `document`, so Point features (whose GeoJSON default marker
// needs a canvas PinBuilder) cannot load here. Landing references only need
// `properties.coordinates`, so a line geometry exercises the same path.
const LANDING_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'lisbon',
      properties: { id: 'lisbon', name: 'Lisbon, Portugal', coordinates: [-9.1, 38.7] },
      geometry: { type: 'LineString', coordinates: [[-9.1, 38.7], [-9.05, 38.72]] },
    },
  ],
};

function fixtureForUrl(url) {
  return String(url).includes('landing-point') ? LANDING_FIXTURE : CABLE_FIXTURE;
}

function makeStubViewer(listeners, dataSources, addCalls = { count: 0 }, addControl = null) {
  return {
    dataSources: {
      // Mirror Cesium's real DataSourceCollection.add(): the returned promise
      // resolves — and the collection mutates — on a DEFERRED tick, never in
      // the caller's synchronous frame. A remove() issued before the deferred
      // add settles therefore removes NOTHING and the add still materializes
      // afterwards (empirically verified against Cesium). Tests may hold the
      // settle window open via addControl to abort inside it, and may mark an
      // add rejected-AFTER-push: Cesium pushes into the collection BEFORE
      // raising dataSourceAdded, so a throwing listener rejects the promise
      // after the mutation already landed.
      add: (source) => {
        const callIndex = addCalls.count;
        addCalls.count += 1;
        return new Promise((resolve, reject) => {
          const settle = () => {
            dataSources.push(source);
            if (addControl?.rejectAfterPush?.has(callIndex)) {
              reject(new Error('dataSourceAdded listener threw after the push landed'));
              return;
            }
            resolve(source);
          };
          if (addControl?.held) addControl.pending.push(settle);
          else Promise.resolve().then(settle);
        });
      },
      remove: (source) => {
        const index = dataSources.indexOf(source);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-40, 35, 4_500_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd: {
        addEventListener: (fn) => {
          listeners.moveEnd.add(fn);
          return () => listeners.moveEnd.delete(fn);
        },
      },
      heading: 0,
      cancelFlight() {},
      flyTo() {},
    },
    scene: {
      canvas: { clientHeight: 900 },
      requestRender() {},
      pick() { return null; },
      preRender: {
        addEventListener: (fn) => {
          listeners.preRender.add(fn);
          return () => listeners.preRender.delete(fn);
        },
      },
    },
  };
}

/**
 * Harness whose fetches stay PENDING until the test releases them, honoring
 * the abort signal like real fetch (reject with AbortError on abort). Load
 * lifecycle races are sequenced deterministically through it.
 */
function createDeferredCableLayerHarness() {
  const hostCalls = [];
  const listeners = { preRender: new Set(), moveEnd: new Set() };
  const dataSources = [];
  const addCalls = { count: 0 };
  const addControl = { held: false, pending: [], rejectAfterPush: new Set() };
  const pendingFetches = [];
  const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const entry = {
      url: String(url),
      settled: false,
      release() {
        if (entry.settled) return;
        entry.settled = true;
        resolve({ ok: true, json: async () => fixtureForUrl(url) });
      },
    };
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) {
        entry.settled = true;
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => {
        if (entry.settled) return;
        entry.settled = true;
        reject(abortError());
      }, { once: true });
    }
    pendingFetches.push(entry);
  });

  const layer = createTeleGeographySubmarineCableLayer({
    overlayHost: {
      setVisible: (...args) => hostCalls.push(['visible', ...args]),
      setEntries: (...args) => hostCalls.push(['entries', ...args]),
      clearSource: (...args) => hostCalls.push(['clear', ...args]),
    },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  const viewer = makeStubViewer(listeners, dataSources, addCalls, addControl);
  layer.init(viewer);

  return {
    layer,
    viewer,
    hostCalls,
    dataSources,
    addCalls,
    listeners,
    pendingFetches,
    raiseSweep() {
      for (const fn of listeners.preRender) fn();
    },
    releaseAll() {
      for (const entry of [...pendingFetches]) entry.release();
      pendingFetches.length = 0;
    },
    /** Park every subsequent dataSources.add in its deferred settle window. */
    holdAdds() {
      addControl.held = true;
    },
    /** Make the Nth add (0-based) push into the collection, THEN reject. */
    failAddAfterPush(callIndex) {
      addControl.rejectAfterPush.add(callIndex);
    },
    /** Let the held adds mutate the collection (the deferred settle lands). */
    releaseHeldAdds() {
      addControl.held = false;
      const pending = addControl.pending.splice(0);
      for (const settle of pending) settle();
    },
    async settle() {
      // Drain the microtask/timer interleave the load path spans.
      for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    cleanup() {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * Gate Cesium's GeoJsonDataSource.load: each call runs the REAL load, then
 * parks its resolution behind a test-owned gate. Opening gate N and aborting
 * in the same synchronous frame lands the abort exactly at the caller's
 * post-await ownership check for that boundary.
 */
function installGeoJsonLoadGate() {
  const original = Cesium.GeoJsonDataSource.load;
  const calls = [];
  const gates = [];
  Cesium.GeoJsonDataSource.load = function gatedLoad(...args) {
    calls.push(args);
    let open;
    const opened = new Promise((resolve) => { open = resolve; });
    gates.push({ open });
    return original.apply(Cesium.GeoJsonDataSource, args)
      .then((result) => opened.then(() => result));
  };
  return {
    calls,
    open(index) {
      gates[index]?.open();
    },
    /**
     * Open every gate, including ones created by continuations the opening
     * itself unblocks (a load calls the landing build only after the cable
     * gate opens), until no new gates appear.
     */
    async drainOpen(settle) {
      let opened = 0;
      while (opened < gates.length) {
        for (; opened < gates.length; opened++) gates[opened].open();
        await settle();
      }
    },
    restore() {
      Cesium.GeoJsonDataSource.load = original;
    },
  };
}

test('an abort landing at the post-fetch boundary stops the stale load before GeoJson work', async () => {
  const env = createDeferredCableLayerHarness();
  const geojson = installGeoJsonLoadGate();
  try {
    env.layer.enable(env.viewer);
    // Release A's fetches and abort in the SAME frame: A's continuation runs
    // with ownership already lost, and the post-fetch owns() check is the guard.
    env.releaseAll();
    env.layer.disable();
    env.layer.enable(env.viewer);
    await env.settle();
    assert.equal(geojson.calls.length, 0, 'stale load A must not reach GeoJsonDataSource.load');

    env.releaseAll();
    await env.settle();
    await geojson.drainOpen(() => env.settle());
    assert.equal(geojson.calls.length, 2, 'load B alone performs the two GeoJson loads');
    assert.equal(env.addCalls.count, 3);
    assert.equal(env.dataSources.length, 3);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    geojson.restore();
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('an abort landing at the post-cable-GeoJson boundary stops the stale load before the landing build', async () => {
  const env = createDeferredCableLayerHarness();
  const geojson = installGeoJsonLoadGate();
  try {
    env.layer.enable(env.viewer);
    env.releaseAll();
    await env.settle();
    assert.equal(env.pendingFetches.length, 0);
    assert.equal(geojson.calls.length, 1, 'load A is parked on the gated cable GeoJson build');

    // Open the cable gate and abort in the same frame: A resumes at the
    // post-cable owns() check with ownership lost.
    geojson.open(0);
    env.layer.disable();
    env.layer.enable(env.viewer);
    await env.settle();
    assert.equal(geojson.calls.length, 1, 'stale load A must not start the landing GeoJson build');

    env.releaseAll();
    await env.settle();
    await geojson.drainOpen(() => env.settle());
    assert.equal(geojson.calls.length, 3, 'load B adds its own two GeoJson builds');
    assert.equal(env.addCalls.count, 3);
    assert.equal(env.dataSources.length, 3);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    geojson.restore();
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('an abort landing at the pre-add boundary stops the stale load before any dataSources.add', async () => {
  const env = createDeferredCableLayerHarness();
  const geojson = installGeoJsonLoadGate();
  try {
    env.layer.enable(env.viewer);
    env.releaseAll();
    await env.settle();
    geojson.open(0);
    await env.settle();
    assert.equal(geojson.calls.length, 2, 'load A is parked on the gated landing GeoJson build');

    // Open the landing gate and abort in the same frame: A resumes at the
    // pre-add owns() check with ownership lost.
    geojson.open(1);
    env.layer.disable();
    env.layer.enable(env.viewer);
    await env.settle();
    assert.equal(env.addCalls.count, 0, 'stale load A must never call dataSources.add');

    env.releaseAll();
    await env.settle();
    await geojson.drainOpen(() => env.settle());
    assert.equal(env.addCalls.count, 3, 'load B alone adds the trio');
    assert.equal(env.dataSources.length, 3);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    geojson.restore();
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('a destroy inside the deferred add window leaves zero post-destroy data sources', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    env.layer.enable(env.viewer);
    env.releaseAll();
    env.holdAdds();
    // Let the load run until all three adds have been CALLED but none has
    // settled — Cesium mutates the collection on a deferred tick, so this
    // window is real, and a remove() issued inside it removes nothing.
    const deadline = Date.now() + 2_000;
    while (env.addCalls.count < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(env.addCalls.count, 3, 'all three adds are in their deferred window');
    assert.equal(env.dataSources.length, 0, 'nothing has settled into the collection yet');

    // Destroy lands in the window: it can remove nothing, so the stale
    // load's own post-add ownership check must compensate once the deferred
    // adds settle.
    env.layer.destroy(env.viewer);
    env.releaseHeldAdds();
    await env.settle();
    assert.equal(
      env.dataSources.length,
      0,
      'the deferred adds settled post-destroy and must be rolled back by their own load',
    );

    // The layer still honors its re-init contract afterwards.
    env.layer.enable(env.viewer);
    env.releaseAll();
    await env.settle();
    assert.equal(env.dataSources.length, 3, 're-enable after the raced destroy loads cleanly');
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('a destroy in the deferred window with a rejected-after-push add still leaves zero sources', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    env.layer.enable(env.viewer);
    env.releaseAll();
    env.holdAdds();
    // Cesium pushes the source into the collection BEFORE raising
    // dataSourceAdded, so a throwing listener rejects the add promise AFTER
    // its mutation landed. Make add #1 exactly that: pushed, then rejected;
    // #2/#3 fulfill normally.
    env.failAddAfterPush(0);
    const deadline = Date.now() + 2_000;
    while (env.addCalls.count < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(env.addCalls.count, 3, 'all three adds are in their deferred window');
    assert.equal(env.dataSources.length, 0, 'nothing has settled into the collection yet');

    // Destroy lands in the window; the adds then settle as
    // [rejected-after-push, fulfilled, fulfilled]. Compensation that removes
    // only FULFILLED adds would strand the rejected-but-pushed source.
    env.layer.destroy(env.viewer);
    env.releaseHeldAdds();
    await env.settle();
    assert.equal(
      env.dataSources.length,
      0,
      'a rejected add still landed its push, so compensation must remove it too',
    );
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('a direct destroy of a published layer clears and hides its host source', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    env.layer.enable(env.viewer);
    env.releaseAll();
    await env.settle();
    assert.equal(env.dataSources.length, 3, 'layer is fully loaded');
    // Drive the sweep through the layer's real preRender listener so the
    // host actually holds published cable entries.
    env.raiseSweep();
    assert.ok(
      env.hostCalls.some(([type]) => type === 'entries'),
      'sweep must publish before the direct destroy',
    );
    env.hostCalls.length = 0;

    // Destroy DIRECTLY — no disable() first. The publisher teardown must
    // still clear the published source and hide it; skipping it would leave
    // a visible overlay source with orphan labels.
    env.layer.destroy(env.viewer);
    assert.ok(
      env.hostCalls.some(([type, id]) => type === 'clear' && id === CABLE_OVERLAY_SOURCE_ID),
      'direct destroy must clear the published host source',
    );
    assert.deepEqual(
      env.hostCalls.at(-1),
      ['visible', CABLE_OVERLAY_SOURCE_ID, false],
      'direct destroy must hide the host source after clearing it',
    );
  } finally {
    env.cleanup();
  }
});

test('a stale aborted load never clobbers the next load\'s lifecycle (A/B/C toggle race)', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    // A: enable starts a load whose fetches stay pending.
    env.layer.enable(env.viewer);
    assert.equal(env.pendingFetches.length, 2, 'load A has two fetches in flight');

    // Abort A and immediately start B before A\'s rejection lands.
    env.layer.disable();
    env.layer.enable(env.viewer);
    await env.settle(); // A\'s stale catch/finally runs here, after B began.

    // C: with A\'s stale completion having cleared nothing it does not own,
    // the layer still reports a load in flight, so update() must not start a
    // third load.
    void env.layer.update(env.viewer);
    await env.settle();
    const inFlight = env.pendingFetches.filter((entry) => !entry.settled).length;
    assert.equal(inFlight, 2, 'only load B\'s two fetches remain in flight — no duplicate load C');

    // Releasing everything must produce exactly one set of scene adds.
    env.releaseAll();
    await env.settle();
    assert.equal(env.addCalls.count, 3, 'exactly one cable/landing/reference data-source trio is added');
    assert.equal(env.dataSources.length, 3);
    const stats = env.layer.getStats();
    assert.equal(stats.error, null);
    assert.equal(stats.count, 2, 'one cable + one landing point loaded once');
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('destroy mid-load stays clean and a re-enabled layer reloads exactly once', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    // Destroy while load A\'s fetches are still in flight.
    env.layer.enable(env.viewer);
    assert.equal(env.pendingFetches.length, 2);
    env.layer.destroy(env.viewer);

    // Legacy contract: the layer supports re-init after destroy. Enable D
    // before A\'s aborted rejection lands.
    env.layer.enable(env.viewer);
    await env.settle(); // A\'s stale finally runs here.

    // A\'s stale completion must not have cleared D\'s in-flight lifecycle:
    // update() must not start a duplicate load E.
    void env.layer.update(env.viewer);
    await env.settle();
    const inFlight = env.pendingFetches.filter((entry) => !entry.settled).length;
    assert.equal(inFlight, 2, 'only load D\'s two fetches remain in flight');

    env.releaseAll();
    await env.settle();
    assert.equal(env.addCalls.count, 3, 'the destroyed load added nothing; the re-enable added once');
    assert.equal(env.dataSources.length, 3);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

async function createRealCableLayerHarness({ mapStackEventTarget = null } = {}) {
  const hostCalls = [];
  // The sweep gate's motion-fallback clock is FROZEN here and advanced only by
  // the tests that exercise it, so every other harness test observes the pure
  // event-dirty behavior with no wall-clock coupling.
  let clockMs = 0;
  const layer = createTeleGeographySubmarineCableLayer({
    overlayHost: {
      setVisible: (...args) => hostCalls.push(['visible', ...args]),
      setEntries: (...args) => hostCalls.push(['entries', ...args]),
      clearSource: (...args) => hostCalls.push(['clear', ...args]),
    },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
    mapStackEventTarget,
    sweepClock: () => clockMs,
  });

  const listeners = { preRender: new Set(), moveEnd: new Set() };
  const dataSources = [];
  const viewer = {
    dataSources: {
      add: (source) => { dataSources.push(source); return Promise.resolve(source); },
      remove: (source) => {
        const index = dataSources.indexOf(source);
        if (index >= 0) dataSources.splice(index, 1);
        return true;
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-40, 35, 4_500_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd: {
        addEventListener: (fn) => {
          listeners.moveEnd.add(fn);
          return () => listeners.moveEnd.delete(fn);
        },
      },
      heading: 0,
      cancelFlight() {},
      flyTo() {},
    },
    scene: {
      canvas: { clientHeight: 900 },
      requestRender() {},
      pick() { return null; },
      preRender: {
        addEventListener: (fn) => {
          listeners.preRender.add(fn);
          return () => listeners.preRender.delete(fn);
        },
      },
    },
  };

  const originalFetch = globalThis.fetch;
  // Node has no `document`, so Point features (whose GeoJSON default marker
  // needs a canvas PinBuilder) cannot load here. Landing references only need
  // `properties.coordinates`, so a line geometry exercises the same path.
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('landing-point')
      ? {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'lisbon',
            properties: { id: 'lisbon', name: 'Lisbon, Portugal', coordinates: [-9.1, 38.7] },
            geometry: { type: 'LineString', coordinates: [[-9.1, 38.7], [-9.05, 38.72]] },
          },
        ],
      }
      : {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'ac1',
            properties: { id: 'ac1', name: 'Atlantic Crossing-1' },
            geometry: { type: 'LineString', coordinates: [[-40, 35], [-30, 40]] },
          },
        ],
      }),
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    // enable() fires load() without awaiting it (legacy contract); poll the
    // layer's own stats until the load settles.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const stats = layer.getStats();
      if (stats.count > 0 || stats.error) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(layer.getStats().error, null, 'harness load must succeed');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const raiseSweep = () => {
    for (const fn of listeners.preRender) fn();
  };
  const advanceClock = (ms) => { clockMs += ms; };
  return { layer, viewer, hostCalls, dataSources, raiseSweep, listeners, advanceClock };
}

test('a real enabled cable layer publishes host entries and has zero native labels', async () => {
  const env = await createRealCableLayerHarness();
  env.raiseSweep();

  const publishes = env.hostCalls.filter(([type]) => type === 'entries');
  assert.ok(publishes.length > 0, 'sweep must publish to the shared host');
  const [, sourceId, entries, options] = publishes.at(-1);
  assert.equal(sourceId, CABLE_OVERLAY_SOURCE_ID);
  assert.equal(entries.length, 2, 'one cable + one landing point reference');
  assert.ok(entries.every((entry) => entry.variant === 'label'));
  assert.deepEqual(options, {
    cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
    collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  });

  const referenceSource = env.dataSources.find((ds) => /References/.test(ds.name || ''));
  assert.ok(referenceSource, 'reference data source must exist');
  const referenceEntities = referenceSource.entities.values;
  assert.ok(referenceEntities.length > 0);
  assert.ok(
    referenceEntities.every((entity) => entity.label === undefined),
    'no reference entity may carry a native LabelGraphics',
  );
  assert.ok(
    referenceEntities.every((entity) => entity.position?.isConstant === true
      && entity.polyline?.positions?.isConstant === true),
    'stem properties must be constants, never per-frame callbacks',
  );

  const stats = env.layer.getStats();
  assert.equal(stats.referenceLabelCount, 2);

  env.layer.disable();
  assert.ok(
    env.hostCalls.some(([type, id]) => type === 'clear' && id === CABLE_OVERLAY_SOURCE_ID),
    'disable must clear the host source',
  );
  assert.deepEqual(
    env.hostCalls.at(-1),
    ['visible', CABLE_OVERLAY_SOURCE_ID, false],
    'disable must hide the host source after clearing it',
  );

  env.layer.destroy(env.viewer);
  assert.equal(env.dataSources.length, 0, 'destroy must remove every data source');
});

test('stems never rebuild mid-drag; exactly one rebuild lands on moveEnd', async () => {
  const env = await createRealCableLayerHarness();
  env.raiseSweep(); // initial sizing at the parked camera

  const referenceSource = env.dataSources.find((ds) => /References/.test(ds.name || ''));
  const entity = referenceSource.entities.values[0];
  let stemRebuilds = 0;
  const originalSet = entity.polyline.positions.setValue.bind(entity.polyline.positions);
  entity.polyline.positions.setValue = (...args) => {
    stemRebuilds++;
    return originalSet(...args);
  };

  // Mid-drag: the camera moves every tick and frames keep rendering, but no
  // moveEnd fires. However long this goes on, the stem constants must never
  // be redefined — each redefinition rebuilt the whole batched stem
  // primitive, and its unready replacement frames were the felt hitch.
  const camera = env.viewer.camera.positionWC;
  for (let tick = 0; tick < 30; tick++) {
    env.viewer.camera.positionWC = Cesium.Cartesian3.add(
      camera,
      new Cesium.Cartesian3(0, 0, 100_000 * (tick + 1)),
      new Cesium.Cartesian3(),
    );
    env.raiseSweep(); // preRender fires every frame during a drag
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(stemRebuilds, 0, 'render ticks without moveEnd must never redefine a stem');

  // The gesture ends close over the cable's reference point (inside the
  // 700 m..85 km stem clamp band, so the re-size is a real tip change):
  // one moveEnd, one sweep, exactly one redefinition.
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-35, 37.5, 400_000);
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(stemRebuilds, 1, 'moveEnd re-sizes the stem exactly once');
  env.raiseSweep();
  assert.equal(stemRebuilds, 1, 'the next frame does not re-run the sweep');

  env.layer.destroy(env.viewer);
});

test('a tracked camera that never emits moveEnd is swept by the motion fallback', async () => {
  const env = await createRealCableLayerHarness();
  // Tracking hands over a mid-altitude follow camera. 400 km keeps the stem
  // inside the 700 m..85 km clamp band, so a sweep is observable as a real
  // tip re-size (at the harness's 4,500 km parking altitude every stem sits
  // pinned at the 85 km clamp and no sweep could be distinguished).
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-35, 37.5, 400_000);
  env.raiseSweep(); // initial sizing at the tracking handoff

  const referenceSource = env.dataSources.find((ds) => /References/.test(ds.name || ''));
  const entity = referenceSource.entities.values[0];
  let stemRebuilds = 0;
  const originalSet = entity.polyline.positions.setValue.bind(entity.polyline.positions);
  entity.polyline.positions.setValue = (...args) => {
    stemRebuilds++;
    return originalSet(...args);
  };

  // Entity tracking / orbit: the follow camera advances every frame and
  // moveEnd NEVER fires. Frames are simulated at 60 Hz on the harness clock.
  const origin = env.viewer.camera.positionWC;
  const frameMs = 1000 / 60;
  const trackFrames = (from, to) => {
    for (let frame = from; frame < to; frame++) {
      env.advanceClock(frameMs);
      env.viewer.camera.positionWC = Cesium.Cartesian3.add(
        origin,
        new Cesium.Cartesian3(0, 0, 200 * (frame + 1)),
        new Cesium.Cartesian3(),
      );
      env.raiseSweep();
    }
  };

  // Inside the first probe window the sweep stays event-dirty-only, so the
  // batched stem primitive is not rebuilt mid-motion (the shipped tradeoff).
  trackFrames(0, 60);
  assert.equal(stemRebuilds, 0, 'inside the probe window a tracked camera still costs no rebuilds');

  // Past the window the fallback fires — exactly once, not per frame.
  trackFrames(60, 130);
  assert.equal(stemRebuilds, 1, 'the tracked camera earns exactly one fallback sweep per window');

  // Tracking stops but frames keep rendering. The motion accumulated since
  // the last fallback sweep settles in exactly ONE further sweep...
  const parkFrames = (count) => {
    for (let frame = 0; frame < count; frame++) {
      env.advanceClock(frameMs);
      env.raiseSweep();
    }
  };
  parkFrames(240); // 4 s parked: two full probe windows
  assert.equal(stemRebuilds, 2, 'a stopped camera settles its residual motion in one further sweep');

  // ...and the parked camera then costs zero sweeps for as long as it sits.
  parkFrames(3600); // 60 s parked
  assert.equal(stemRebuilds, 2, 'a settled parked camera never spends another sweep');

  env.layer.destroy(env.viewer);
});

test('an unchanged cohort never republishes, so a parked camera stays governor-idle', async () => {
  const env = await createRealCableLayerHarness();
  const publishCount = () => env.hostCalls.filter(([type]) => type === 'entries').length;

  env.raiseSweep();
  assert.equal(publishCount(), 1, 'first sweep publishes the cohort');

  // moveEnd with an unchanged camera re-arms the sweep; the identical winner
  // set must NOT reach the host again (each publish costs a requested render).
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(publishCount(), 1, 'identical cohorts are skipped');

  // A real camera move changes distances beyond the 50 km priority quantum,
  // so the next sweep publishes again.
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-40, 35, 6_500_000);
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(publishCount(), 2, 'a changed cohort publishes');

  // disable → enable must force a republish even when the cohort is identical
  // (the hide cleared the host source).
  env.layer.disable();
  env.layer.enable(env.viewer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  env.raiseSweep();
  assert.equal(publishCount(), 3, 're-enable republishes after the hide cleared the source');

  env.layer.destroy(env.viewer);
});
