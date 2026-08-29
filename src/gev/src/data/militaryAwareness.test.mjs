import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Cesium from 'cesium';
import militaryAwarenessLayer, {
  _getAwarenessNavigationStateForTest,
  awarenessClearMatchesSubject,
  awarenessNeedsContinuousRender,
  awarenessRefreshDecision,
  awarenessRefreshIntervalMs,
  awarenessRefreshRequired,
  awarenessResultsAreLive,
  buildAwarenessContextSnapshot,
  canNavigateAwarenessNext,
  contactsWindowFromSnapshot,
  contextTargetFlyToAllowed,
  summarizeInstallationViewport,
  findCompatibleHistoryIndex,
  AWARENESS_QUERY_LIMIT,
  historySubjectSnapshot,
} from './militaryAwareness.js';
import flightsLayer, {
  _setTrackedFlightRefreshStateForTest,
} from './flights.js';
import militaryFlightsLayer, {
  _setTrackedMilitaryRefreshStateForTest,
} from './militaryFlights.js';
import aisLiveVesselsLayer, { _setVesselStateForTest } from './aisLiveVessels.js';
import militaryInstallationsLayer from './militaryInstallations.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';
import {
  AWARENESS_RADIUS_M,
  formatAwarenessLabel,
  getAwarenessNavigationTargets,
} from './militaryAwarenessEngine.js';
import { NAVIGATION_AUTHORITY_EVENT } from '../navigationPolicy.js';

const militaryAwarenessSource = fs.readFileSync(
  new URL('./militaryAwareness.js', import.meta.url),
  'utf8',
);

const AWARENESS_DEPENDENCIES = [
  'flights',
  'military',
  'ais-live-vessels',
  'military-installations',
];

function installAwarenessRuntime({
  isEnabled = () => true,
  isEffectivelyEnabled = isEnabled,
  setEnabled = async () => true,
  getLayerLifecycleState = (layerId) => ({
    enabled: isEnabled(layerId),
    lifecycleState: isEnabled(layerId) ? 'enabled' : 'disabled',
    uncertain: false,
  }),
  // Per-layer getStats override, keyed by layer id. Whatever a caller puts here
  // must be a shape the REAL module actually returns — a fixture that invents a
  // status its module never emits guards nothing. See the settled-but-fetching
  // tests below, which use militaryInstallations' genuine first-fetch readout.
  layerStats = {},
} = {}) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const listeners = new Map();
  let nextTimer = 1;
  let preRenderListener = null;
  const createdElements = [];

  class FakeElement {
    constructor() {
      this.classList = { contains: () => false };
      this.style = { setProperty() {} };
      this._hidden = false;
      // renderResults() writes `hidden = false` on EVERY call, ahead of its
      // markup diff, so counting these writes observes "was the panel
      // repaint path entered?" independently of whether the markup changed.
      this.hiddenWrites = 0;
      this.innerHTML = '';
    }

    get hidden() { return this._hidden; }

    set hidden(value) {
      this._hidden = value;
      this.hiddenWrites += 1;
    }

    setAttribute() {}
    addEventListener() {}
    removeEventListener() {}
    appendChild() {}
    append() {}
    remove() {}
    replaceChildren() {}
  }

  const fakeWindow = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    setInterval() { return nextTimer++; },
    clearInterval() {},
    requestAnimationFrame() { return nextTimer++; },
    cancelAnimationFrame() {},
    dispatch(type, detail) {
      for (const listener of listeners.get(type) || []) listener({ detail });
    },
    // Real dispatch surface: the layer announces navigation authority through
    // it before any camera flight that does not assign a tracked entity.
    dispatchEvent(event) {
      for (const listener of listeners.get(event?.type) || []) listener(event);
      return true;
    },
  };
  const fakeBody = new FakeElement();
  const renderRequests = [];
  const cameraFlights = [];
  const viewer = {
    camera: {
      flyToBoundingSphere(sphere, options) {
        cameraFlights.push({ sphere, options });
      },
      cancelFlight() {},
    },
    scene: {
      // Enough surface for the real render governor to drive this viewer.
      requestRenderMode: false,
      maximumRenderTimeChange: 0,
      requestRender() { renderRequests.push(Date.now()); },
      preRender: {
        addEventListener(listener) {
          preRenderListener = listener;
          return () => { preRenderListener = null; };
        },
      },
    },
    entities: {
      add(entity) { return entity; },
      remove() {},
    },
    container: new FakeElement(),
  };
  const layers = new Map(AWARENESS_DEPENDENCIES.map((layerId) => [layerId, {
    module: {
      getStats() {
        const override = layerStats[layerId];
        if (override) return typeof override === 'function' ? override() : override;
        return { count: 4, status: 'ready', stale: false, error: null };
      },
    },
  }]));

  globalThis.window = fakeWindow;
  globalThis.document = {
    body: fakeBody,
    getElementById() { return null; },
    createElement() {
      const element = new FakeElement();
      createdElements.push(element);
      return element;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  militaryAwarenessLayer.attachDataManager({
    isEnabled,
    isEffectivelyEnabled,
    setEnabled,
    getLayerLifecycleState,
    layers,
  });
  militaryAwarenessLayer.setParams({ passive: true });
  militaryAwarenessLayer.init(viewer);
  militaryAwarenessLayer.enable();

  return {
    dispatch: fakeWindow.dispatch.bind(fakeWindow),
    tick() { preRenderListener?.(); },
    viewer,
    renderRequests,
    cameraFlights,
    window: fakeWindow,
    /** Record every navigation-authority announcement, in order. */
    captureAuthority() {
      const taken = [];
      fakeWindow.addEventListener(
        NAVIGATION_AUTHORITY_EVENT,
        (event) => taken.push(event?.detail?.reason || 'unknown'),
      );
      return taken;
    },
    /** The standalone Context panel element renderResults() paints into. */
    panel() {
      return createdElements.find((element) => element.id === 'military-awareness-panel') || null;
    },
    restore() {
      militaryAwarenessLayer.destroy();
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    },
  };
}

test('awareness disable settles every owned dependency release before resolving', async () => {
  let releasing = false;
  let releaseDependencies;
  const releaseGate = new Promise((resolve) => { releaseDependencies = resolve; });
  const calls = [];
  const runtime = installAwarenessRuntime({
    isEnabled: () => false,
    setEnabled: async (layerId, enabled) => {
      calls.push({ layerId, enabled });
      if (!enabled) await releaseGate;
      return true;
    },
  });

  try {
    militaryAwarenessLayer.setParams({ passive: false });
    militaryAwarenessLayer.enable();
    await nextTurn();
    const disabling = militaryAwarenessLayer.disable().then(() => { releasing = true; });
    await nextTurn();
    assert.equal(releasing, false, 'coordinator OFF waits for owned dependency releases');
    assert.deepEqual(
      calls.filter(({ enabled }) => !enabled).map(({ layerId }) => layerId).sort(),
      [...AWARENESS_DEPENDENCIES].sort(),
    );
    releaseDependencies();
    await disabling;
    assert.equal(releasing, true);
  } finally {
    releaseDependencies();
    runtime.restore();
  }
});

test('same-turn Contacts OFF registers after every owned dependency ON', async () => {
  const calls = [];
  const runtime = installAwarenessRuntime({
    isEnabled: () => false,
    isEffectivelyEnabled: () => false,
    setEnabled: (layerId, enabled) => {
      calls.push({ layerId, enabled });
      return Promise.resolve(true);
    },
  });

  try {
    militaryAwarenessLayer.setParams({ passive: false });
    const disabling = militaryAwarenessLayer.disable();
    assert.deepEqual(
      calls.map(({ layerId, enabled }) => `${layerId}:${enabled ? 'on' : 'off'}`),
      [
        ...AWARENESS_DEPENDENCIES.map((layerId) => `${layerId}:on`),
        ...AWARENESS_DEPENDENCIES.map((layerId) => `${layerId}:off`),
      ],
      'OFF must be the newest manager intent before this JavaScript turn yields',
    );
    await disabling;
    await nextTurn();
    assert.equal(
      calls.slice(AWARENESS_DEPENDENCIES.length).some(({ enabled }) => enabled),
      false,
      'no deferred ON may run after release',
    );
  } finally {
    runtime.restore();
  }
});

test('Contacts does not claim a dependency already enabling for the user', async () => {
  const calls = [];
  const runtime = installAwarenessRuntime({
    isEnabled: () => false,
    isEffectivelyEnabled: (layerId) => layerId === 'flights',
    setEnabled: (layerId, enabled) => {
      calls.push({ layerId, enabled });
      return Promise.resolve(true);
    },
  });

  try {
    militaryAwarenessLayer.setParams({ passive: false });
    await militaryAwarenessLayer.disable();
    assert.equal(
      calls.some(({ layerId }) => layerId === 'flights'),
      false,
      'an in-flight user enable stays outside Contacts ownership',
    );
  } finally {
    runtime.restore();
  }
});

test('operational awareness becomes ready after aircraft while deferred sources keep loading', async () => {
  let enabled = false;
  let releaseAircraft;
  let releaseDeferred;
  const aircraftGate = new Promise((resolve) => { releaseAircraft = resolve; });
  const deferredGate = new Promise((resolve) => { releaseDeferred = resolve; });
  const calls = [];
  const runtime = installAwarenessRuntime({
    isEnabled: () => false,
    setEnabled: async (layerId, nextEnabled) => {
      calls.push({ layerId, enabled: nextEnabled });
      if (nextEnabled) {
        await (['flights', 'military'].includes(layerId) ? aircraftGate : deferredGate);
      }
      return true;
    },
  });

  try {
    await militaryAwarenessLayer.disable();
    militaryAwarenessLayer.setParams({ passive: false });
    const enabling = militaryAwarenessLayer.enable().then(() => { enabled = true; });
    await nextTurn();
    assert.equal(enabled, false, 'coordinator ON waits for aircraft readiness');
    assert.deepEqual(
      calls.filter(({ enabled: nextEnabled }) => nextEnabled).map(({ layerId }) => layerId).sort(),
      [...AWARENESS_DEPENDENCIES].sort(),
    );
    releaseAircraft();
    await enabling;
    assert.equal(enabled, true, 'deferred vessels/installations do not block Contacts');
    assert.equal(calls.filter(({ layerId }) => (
      ['ais-live-vessels', 'military-installations'].includes(layerId)
    )).length, 2, 'deferred requests were started in the same activation');
  } finally {
    releaseAircraft();
    releaseDeferred();
    runtime.restore();
  }
});

test('pending mapped installations render as unknown instead of a false zero', async () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_000);
  const restoreCollections = stubAwarenessCollections({});
  const runtime = installAwarenessRuntime({
    // Deliberately inconsistent visibility intent exercises the defensive
    // lifecycle guard: `enabling` must win over a stale true response.
    isEnabled: () => true,
    getLayerLifecycleState: (layerId) => (layerId === 'military-installations'
      ? { enabled: false, lifecycleState: 'enabling', uncertain: false }
      : { enabled: true, lifecycleState: 'enabled', uncertain: false }),
  });

  try {
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'pending-site', position));
    await nextTurn();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    const installations = snapshot?.cohorts.find(({ id }) => id === 'military-installations');
    assert.equal(installations?.count, null, 'loading is not an observed empty cohort');
    assert.match(installations?.reason || '', /unavailable/i);
    assert.match(
      runtime.panel()?.innerHTML || '',
      /Mapped installations<\/strong><b aria-live="polite">\?<\/b>/,
      'the operator sees ? rather than an all-clear 0 while installations load',
    );
  } finally {
    restoreCollections();
    runtime.restore();
  }
});

// ── The `loading === true && !lastUpdate` predicate in sourceState ────────────
//
// It is a CONTRACT over the whole dependency list, not a fix for one layer, and
// the dependencies reach it by different routes:
//
//   - ais-live-vessels is its REACHABLE producer. enable()/update() both resolve
//     as soon as the first /api/ais-live poll answers, so the manager's
//     lifecycle settles to `enabled` — but until the server-side socket delivers
//     a position, firstConnectPhase stays 'loading' and the module reports busy,
//     no lastUpdate, count 0, and an UNDEFINED status, so the status list alone
//     never catches it either.
//   - military-installations never reaches this window, and these pins are not
//     about it. Its enable() is synchronous and the manager awaits update(),
//     which owns the first Overpass fetch, so the lifecycle stays `enabling`
//     throughout and the sibling `enabling` test above is what covers it.
//     Confirmed live on :4272 across a held 17 s first fetch (34 samples,
//     `enabling` the whole way) and across a failing one.
//
// The readouts below are taken FROM the real module rather than hand-written. A
// fixture that invents a shape its module never emits guards nothing — that is
// exactly how a hole in this gate survived a passing suite once already.

/** Drive aisLiveVessels into a state and return the readout IT produces. */
function aisStatsFor(options) {
  _setVesselStateForTest(options);
  return Object.freeze(aisLiveVesselsLayer.getStats());
}

/** Socket connecting: busy, never answered, undefined status. */
const AIS_FIRST_CONNECT_STATS = aisStatsFor({
  enabled: true,
  transportStatus: 'connecting',
  firstConnectPhase: 'loading',
  lastUpdate: null,
});

/** The same module once the socket answers with an honestly empty viewport. */
const AIS_SETTLED_EMPTY_STATS = aisStatsFor({
  enabled: true,
  transportStatus: 'open',
  firstConnectPhase: 'ready',
  lastUpdate: 1_700_000_000_000,
});

/** Answered once, and busy again on a later refresh poll. */
const AIS_REFRESHING_ANSWERED_STATS = aisStatsFor({
  enabled: true,
  loading: true,
  transportStatus: 'open',
  firstConnectPhase: 'ready',
  lastUpdate: 1_700_000_000_000,
  records: [{ mmsi: '1' }, { mmsi: '2' }, { mmsi: '3' }],
});

// Leave the shared module neutral for every test below.
_setVesselStateForTest({ enabled: false });

test('the first-connect readout is the real one, and is exactly what the predicate keys on', () => {
  assert.equal(AIS_FIRST_CONNECT_STATS.loading, true, 'the module reports itself busy while connecting');
  assert.equal(AIS_FIRST_CONNECT_STATS.lastUpdate, null, 'and has never answered');
  assert.equal(AIS_FIRST_CONNECT_STATS.count, 0, 'with a zero that means nothing yet');
  assert.equal(
    AIS_FIRST_CONNECT_STATS.status,
    undefined,
    'and no status at all — the status list cannot be what catches this',
  );
  assert.equal(AIS_SETTLED_EMPTY_STATS.loading, false, 'an answered socket is not busy');
  assert.ok(AIS_SETTLED_EMPTY_STATS.lastUpdate, 'and carries the moment it answered');
  assert.equal(AIS_REFRESHING_ANSWERED_STATS.loading, true, 'a refresh poll is busy again');
  assert.ok(AIS_REFRESHING_ANSWERED_STATS.lastUpdate, 'without erasing the answer already given');
});

test('a vessel feed still connecting after the lifecycle settles reads as unknown, not an all-clear', async () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_000);
  const restoreCollections = stubAwarenessCollections({});
  // The window this pins: enable() and the first poll have RESOLVED, so the
  // manager reports a fully settled `enabled` lifecycle, while the socket has
  // still never delivered a position.
  const runtime = installAwarenessRuntime({
    isEnabled: () => true,
    getLayerLifecycleState: () => ({ enabled: true, lifecycleState: 'enabled', uncertain: false }),
    layerStats: { 'ais-live-vessels': AIS_FIRST_CONNECT_STATS },
  });

  try {
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'connecting-site', position));
    await nextTurn();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    const vessels = snapshot?.cohorts.find(({ id }) => id === 'ais-live-vessels');
    assert.equal(
      vessels?.count,
      null,
      'a source that has never answered has told us nothing — 0 would be a fabricated all-clear',
    );
    assert.match(vessels?.reason || '', /unavailable/i);
    assert.match(
      runtime.panel()?.innerHTML || '',
      /AIS vessels<\/strong><b aria-live="polite">\?<\/b>/,
      'the panel prints ? for the whole settled-but-connecting window',
    );
    assert.doesNotMatch(
      runtime.panel()?.innerHTML || '',
      /AIS vessels<\/strong><b aria-live="polite">0<\/b>/,
      'the panel must never print an all-clear 0 before the feed has answered once',
    );
  } finally {
    restoreCollections();
    runtime.restore();
  }
});

test('a settled vessel feed reporting a real empty viewport recovers to 0', async () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_000);
  const restoreCollections = stubAwarenessCollections({});
  // Same lifecycle, but the socket answered: `lastUpdate` is set and the module
  // is no longer busy, so this zero is an OBSERVATION and must be shown as one.
  // Without this pin the fix above could degenerate into a permanent `?`.
  const runtime = installAwarenessRuntime({
    isEnabled: () => true,
    getLayerLifecycleState: () => ({ enabled: true, lifecycleState: 'enabled', uncertain: false }),
    layerStats: { 'ais-live-vessels': AIS_SETTLED_EMPTY_STATS },
  });

  try {
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'settled-site', position));
    await nextTurn();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    const vessels = snapshot?.cohorts.find(({ id }) => id === 'ais-live-vessels');
    assert.equal(vessels?.count, 0, 'an answered empty viewport is a real observation');
    assert.match(
      runtime.panel()?.innerHTML || '',
      /AIS vessels<\/strong><b aria-live="polite">0<\/b>/,
      'the operator sees the real count once the feed answers',
    );
  } finally {
    restoreCollections();
    runtime.restore();
  }
});

test('a still-answered feed keeps its count through later polls that set loading again', async () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_000);
  const restoreCollections = stubAwarenessCollections({});
  // A refresh poll sets `loading` true again while `lastUpdate` stays set. The
  // guard is deliberately "never answered", not "busy": blanking to ? on every
  // refresh would be its own dishonesty, and a flickering panel besides.
  const runtime = installAwarenessRuntime({
    isEnabled: () => true,
    getLayerLifecycleState: () => ({ enabled: true, lifecycleState: 'enabled', uncertain: false }),
    layerStats: { 'ais-live-vessels': AIS_REFRESHING_ANSWERED_STATS },
  });

  try {
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'refreshing-site', position));
    await nextTurn();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    const vessels = snapshot?.cohorts.find(({ id }) => id === 'ais-live-vessels');
    assert.notEqual(vessels?.count, null, 'a refresh poll does not erase an answer already given');
  } finally {
    restoreCollections();
    runtime.restore();
  }
});

test('voice reports a still-connecting vessel feed as unknown rather than zero', async () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_000);
  const restoreCollections = stubAwarenessCollections({});
  // The same real first-connect readout the panel pins above. The voice surface
  // reads the same cohort the panel does, so it inherited the same fabricated
  // zero and needs its own pin.
  const runtime = installAwarenessRuntime({
    isEnabled: () => true,
    getLayerLifecycleState: () => ({ enabled: true, lifecycleState: 'enabled', uncertain: false }),
    layerStats: { 'ais-live-vessels': AIS_FIRST_CONNECT_STATS },
  });

  try {
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'voice-site', position));
    await nextTurn();

    const spoken = contactsWindowFromSnapshot(militaryAwarenessLayer.getContextSnapshot());
    assert.equal(spoken?.vessels, 'unknown', 'voice must not speak a zero the feed never reported');
  } finally {
    restoreCollections();
    runtime.restore();
  }
});

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function replaceMethod(target, name, replacement, restores) {
  const original = target[name];
  target[name] = replacement;
  restores.push(() => { target[name] = original; });
}

function stubAwarenessCollections({ flights = [], military = [], vessels = [], installations = [] }) {
  const restores = [];
  replaceMethod(flightsLayer, 'getNearby', () => flights, restores);
  replaceMethod(flightsLayer, 'getAllPositions', () => flights.map((item) => ({ ...item, id: item.icao24 })), restores);
  replaceMethod(militaryFlightsLayer, 'getNearby', () => military, restores);
  replaceMethod(militaryFlightsLayer, 'getAllPositions', () => military.map((item) => ({ ...item, id: item.icao24 })), restores);
  replaceMethod(aisLiveVesselsLayer, 'getNearby', () => vessels, restores);
  replaceMethod(aisLiveVesselsLayer, 'getAllPositions', () => vessels.map((item) => ({ ...item, id: item.mmsi })), restores);
  replaceMethod(militaryInstallationsLayer, 'getNearby', () => installations, restores);
  return () => restores.reverse().forEach((restore) => restore());
}

function awarenessSubject(layerId, id, position) {
  return { layerId, id, label: id, position };
}

for (const fixture of [
  { name: 'civilian', layerId: 'flights', layer: flightsLayer, other: militaryFlightsLayer },
  { name: 'military', layerId: 'military', layer: militaryFlightsLayer, other: flightsLayer },
]) {
  test(`Contacts activation adopts an already tracked ${fixture.name} flight`, async () => {
    const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
    const subject = awarenessSubject(fixture.layerId, `${fixture.name}-tracked`, position);
    const runtime = installAwarenessRuntime();
    const restores = [];
    let retrackCalls = 0;

    try {
      const trackedEntity = { gevTrackedId: `${subject.layerId}:${subject.id}` };
      runtime.viewer.trackedEntity = trackedEntity;
      replaceMethod(fixture.layer, 'getTrackedSubject', () => subject, restores);
      replaceMethod(fixture.other, 'getTrackedSubject', () => null, restores);
      replaceMethod(flightsLayer, 'trackById', () => { retrackCalls += 1; return true; }, restores);
      replaceMethod(militaryFlightsLayer, 'trackById', () => { retrackCalls += 1; return true; }, restores);

      militaryAwarenessLayer.setParams({ passive: false });
      await nextTurn();

      const snapshot = militaryAwarenessLayer.getContextSnapshot();
      assert.equal(snapshot?.subject.layerId, subject.layerId);
      assert.equal(snapshot?.subject.id, subject.id);
      assert.equal(snapshot?.navigation.canPrevious, false);
      assert.equal(snapshot?.navigation.canNext, false);
      assert.equal(retrackCalls, 0, 'adoption must not recreate the existing track');
      assert.equal(
        runtime.viewer.trackedEntity,
        trackedEntity,
        'adoption must not replace the source-owned tracked entity',
      );
    } finally {
      restores.reverse().forEach((restore) => restore());
      runtime.restore();
    }
  });
}

test('Contacts activation adopts the production military tracked-subject descriptor', async () => {
  const id = 'ae01ce';
  const position = Cesium.Cartesian3.fromDegrees(-97.03, 31.05, 8_534.4);
  const sourceViewer = { scene: { primitives: { remove() {} } } };
  const runtime = installAwarenessRuntime();
  const restores = [];
  let retrackCalls = 0;

  try {
    _setTrackedMilitaryRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, show: true },
      billboardCollection: { show: true, remove() {} },
      viewer: sourceViewer,
      meta: {
        callsign: 'RCH451 ',
        altitudeFt: 28_000,
        renderAltitudeM: 8_534.4,
        speedMps: 231.5,
        track: 92.1,
        onGround: false,
      },
    });
    const accessorSubject = militaryFlightsLayer.getTrackedSubject();
    assert.equal(accessorSubject?.layerId, 'military');
    assert.equal(accessorSubject?.id, id);
    assert.equal(accessorSubject?.label, 'RCH451');
    assert.notEqual(
      accessorSubject?.position,
      position,
      'the production accessor must detach its Cartesian position',
    );
    assert.ok(Cesium.Cartesian3.equalsEpsilon(
      accessorSubject?.position,
      position,
      Cesium.Math.EPSILON7,
    ));
    accessorSubject.position.x += 100;
    assert.ok(Cesium.Cartesian3.equalsEpsilon(
      militaryFlightsLayer.getTrackedSubject()?.position,
      position,
      Cesium.Math.EPSILON7,
    ), 'mutating one accessor result must not alter the tracked source position');
    runtime.viewer.trackedEntity = { gevTrackedId: `military:${id}` };
    replaceMethod(flightsLayer, 'getTrackedSubject', () => null, restores);
    replaceMethod(flightsLayer, 'trackById', () => { retrackCalls += 1; return true; }, restores);
    replaceMethod(militaryFlightsLayer, 'trackById', () => { retrackCalls += 1; return true; }, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    assert.equal(snapshot?.subject.layerId, 'military');
    assert.equal(snapshot?.subject.id, id);
    assert.equal(snapshot?.subject.label, 'RCH451');
    assert.ok(Cesium.Cartesian3.equalsEpsilon(
      snapshot?.subject.position,
      position,
      Cesium.Math.EPSILON7,
    ));
    assert.equal(retrackCalls, 0, 'production military adoption must preserve tracker ownership');
  } finally {
    restores.reverse().forEach((restore) => restore());
    _setTrackedMilitaryRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, show: true },
      billboardCollection: { show: true, remove() {} },
      viewer: sourceViewer,
      meta: {},
      tracked: false,
    });
    militaryFlightsLayer.destroy(sourceViewer);
    assert.deepEqual(
      militaryFlightsLayer.getAllPositions(),
      [],
      'production military test state must be fully cleared',
    );
    runtime.restore();
  }
});

test('production military tracked-subject label falls back to registration before the ICAO hex', async () => {
  const id = 'ae02df';
  const position = Cesium.Cartesian3.fromDegrees(-97.03, 31.05, 6_400);
  const sourceViewer = { scene: { primitives: { remove() {} } } };
  const runtime = installAwarenessRuntime();
  const restores = [];

  try {
    _setTrackedMilitaryRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, show: true },
      billboardCollection: { show: true, remove() {} },
      viewer: sourceViewer,
      meta: {
        callsign: '   ',
        registration: 'N123AB ',
        altitudeFt: 21_000,
        renderAltitudeM: 6_400,
        speedMps: 180.2,
        track: 271.4,
        onGround: false,
      },
    });
    // The proximity list already labels a callsign-less contact by registration;
    // the tracked-subject descriptor must use the same chain instead of the hex.
    assert.equal(militaryFlightsLayer.getNearby(position, 5_000)[0]?.id, 'N123AB');
    assert.equal(militaryFlightsLayer.getTrackedSubject()?.label, 'N123AB');
    // getAllPositions was the last military surface still reading as raw hex.
    const snapshotRow = militaryFlightsLayer.getAllPositions(10)[0];
    assert.equal(snapshotRow?.label, 'N123AB', 'getAllPositions label must use the same chain');
    assert.equal(snapshotRow?.id, id, 'getAllPositions id stays the identity hex');

    runtime.viewer.trackedEntity = { gevTrackedId: `military:${id}` };
    replaceMethod(flightsLayer, 'getTrackedSubject', () => null, restores);
    replaceMethod(flightsLayer, 'trackById', () => true, restores);
    replaceMethod(militaryFlightsLayer, 'trackById', () => true, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    assert.equal(snapshot?.subject.id, id);
    assert.equal(
      snapshot?.subject.label,
      'N123AB',
      'an adopted callsign-less contact must not surface its raw ICAO hex',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    _setTrackedMilitaryRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, show: true },
      billboardCollection: { show: true, remove() {} },
      viewer: sourceViewer,
      meta: {},
      tracked: false,
    });
    militaryFlightsLayer.destroy(sourceViewer);
    assert.deepEqual(
      militaryFlightsLayer.getAllPositions(),
      [],
      'production military test state must be fully cleared',
    );
    runtime.restore();
  }
});

test('a cached Context subject re-reads its label when enrichment lands after selection', async () => {
  // The subject snapshot is captured once at selection. Selecting a
  // callsign-less aircraft BEFORE adsbdb enrichment answers used to freeze the
  // ICAO hex into Context while every other surface later swapped to the
  // registration. The refresh path must re-resolve the label, never the id.
  const id = 'ae1fa4';
  const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);
  const sourceViewer = { camera: { positionCartographic: null }, scene: {} };
  const runtime = installAwarenessRuntime();
  const restores = [];
  // Held by reference so the enrichment step can mutate it in place, exactly
  // as _requestTypeEnrichment's callback does (`meta.registration = …`).
  const meta = {
    callsign: '   ',
    altitude: 10_668,
    renderAltitudeM: 10_700,
    velocity: 250,
    true_track: 95,
    klass: 'airliner',
    onGround: false,
    wasAirborne: true,
    turnRateDps: 0,
    rawLat: 30.21,
    rawLon: -97.71,
  };

  try {
    _setTrackedFlightRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, color: Cesium.Color.WHITE, show: true },
      billboardCollection: { show: true, remove() {} },
      viewer: sourceViewer,
      meta,
    });

    runtime.viewer.trackedEntity = { gevTrackedId: `flights:${id}` };
    replaceMethod(militaryFlightsLayer, 'getTrackedSubject', () => null, restores);
    replaceMethod(flightsLayer, 'trackById', () => true, restores);
    replaceMethod(militaryFlightsLayer, 'trackById', () => true, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();

    // Pre-enrichment: nothing but the hex is known, so the hex is correct here.
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.label, id);
    const panel = runtime.panel();
    assert.ok(panel, 'the Context panel must exist');
    assert.match(panel.innerHTML, /ae1fa4/, 'panel starts on the hex');

    // A refresh that changes NOTHING must not repaint (no per-refresh storm).
    const settledWrites = panel.hiddenWrites;
    await militaryAwarenessLayer.update();
    assert.equal(
      panel.hiddenWrites,
      settledWrites,
      'an unchanged label must not trigger a panel repaint',
    );

    // Enrichment answers. The contact has NOT moved and no source revision
    // changed, so the label is the only thing making this render-worthy.
    meta.registration = 'N123AB ';
    await militaryAwarenessLayer.update();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    assert.equal(
      snapshot?.subject.label,
      'N123AB',
      'Context must adopt the registration once enrichment supplies it',
    );
    assert.equal(snapshot?.subject.id, id, 'subject identity must stay the ICAO hex');
    // The RENDERED panel is the surface the operator actually reads.
    assert.ok(
      panel.hiddenWrites > settledWrites,
      'a changed label must repaint the standalone Context panel',
    );
    assert.match(
      panel.innerHTML,
      /N123AB/,
      'the rendered Context panel must show the registration without a position change',
    );
    assert.doesNotMatch(panel.innerHTML, /ae1fa4/, 'the hex must be gone from the panel');

    // The Cockpit signal list builds its nearby-contact titles with this exact
    // helper over the cohort rows, so the same fixture pins that surface too.
    assert.equal(
      formatAwarenessLabel(flightsLayer.getNearby(position, 250_000, 5)[0]),
      'N123AB',
      'cockpit signal titles must resolve to the registration, not the hex',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    _setTrackedFlightRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, show: true },
      billboardCollection: { show: false, remove() {} },
      viewer: sourceViewer,
      meta: {},
      tracked: false,
    });
    runtime.restore();
  }
});

test('Contacts activation adopts the production civilian tracked-subject descriptor', async () => {
  const id = 'a1b2c3';
  const position = Cesium.Cartesian3.fromDegrees(-97.67, 30.19, 10_668);
  const sourceViewer = { scene: { primitives: { remove() {} } } };
  const runtime = installAwarenessRuntime();
  const restores = [];
  let retrackCalls = 0;

  try {
    _setTrackedFlightRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, show: true },
      billboardCollection: { show: true, remove() {} },
      viewer: sourceViewer,
      meta: {
        callsign: 'DAL123 ',
        altitude: 10_668,
        renderAltitudeM: 10_700,
        velocity: 250,
        true_track: 95,
        onGround: false,
        rawLat: 30.19,
        rawLon: -97.67,
      },
    });
    const accessorSubject = flightsLayer.getTrackedSubject();
    assert.equal(accessorSubject?.layerId, 'flights');
    assert.equal(accessorSubject?.id, id);
    assert.equal(accessorSubject?.label, 'DAL123');
    assert.notEqual(
      accessorSubject?.position,
      position,
      'the production accessor must detach its Cartesian position',
    );
    assert.ok(Cesium.Cartesian3.equalsEpsilon(
      accessorSubject?.position,
      position,
      Cesium.Math.EPSILON7,
    ));
    accessorSubject.position.x += 100;
    assert.ok(Cesium.Cartesian3.equalsEpsilon(
      flightsLayer.getTrackedSubject()?.position,
      position,
      Cesium.Math.EPSILON7,
    ), 'mutating one accessor result must not alter the tracked source position');
    runtime.viewer.trackedEntity = { gevTrackedId: `flights:${id}` };
    replaceMethod(militaryFlightsLayer, 'getTrackedSubject', () => null, restores);
    replaceMethod(flightsLayer, 'trackById', () => { retrackCalls += 1; return true; }, restores);
    replaceMethod(militaryFlightsLayer, 'trackById', () => { retrackCalls += 1; return true; }, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    assert.equal(snapshot?.subject.layerId, 'flights');
    assert.equal(snapshot?.subject.id, id);
    assert.equal(snapshot?.subject.label, 'DAL123');
    assert.ok(Cesium.Cartesian3.equalsEpsilon(
      snapshot?.subject.position,
      position,
      Cesium.Math.EPSILON7,
    ));
    assert.equal(retrackCalls, 0, 'production civilian adoption must preserve tracker ownership');
  } finally {
    restores.reverse().forEach((restore) => restore());
    _setTrackedFlightRefreshStateForTest({
      icao24: id,
      entity: null,
      billboard: { position, show: true },
      billboardCollection: { show: true, remove() {} },
      viewer: sourceViewer,
      meta: {},
      tracked: false,
    });
    flightsLayer.destroy(sourceViewer);
    assert.deepEqual(
      flightsLayer.getAllPositions(),
      [],
      'production civilian test state must be fully cleared',
    );
    runtime.restore();
  }
});

test('Contacts activation reconciles to a newer cross-layer tracked flight after dependencies settle', async () => {
  let releaseDependencies;
  const dependencyGate = new Promise((resolve) => { releaseDependencies = resolve; });
  const positions = {
    first: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000),
    latest: Cesium.Cartesian3.fromDegrees(-97.70, 30.30, 1200),
  };
  let civilianTracked = awarenessSubject('flights', 'first', positions.first);
  let militaryTracked = null;
  const runtime = installAwarenessRuntime({
    isEnabled: () => false,
    setEnabled: async (_layerId, enabled) => {
      if (enabled) await dependencyGate;
      return true;
    },
  });
  const restores = [];

  try {
    runtime.viewer.trackedEntity = { gevTrackedId: 'flights:first' };
    replaceMethod(flightsLayer, 'getTrackedSubject', () => civilianTracked, restores);
    replaceMethod(militaryFlightsLayer, 'getTrackedSubject', () => militaryTracked, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, 'first');

    civilianTracked = null;
    militaryTracked = awarenessSubject('military', 'latest', positions.latest);
    runtime.viewer.trackedEntity = { gevTrackedId: 'military:latest' };
    releaseDependencies();
    await nextTurn();
    await nextTurn();

    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.layerId, 'military');
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, 'latest');
  } finally {
    releaseDependencies();
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('tracked flight cleared during Contacts activation suppresses fallback autofocus', async () => {
  let releaseDependencies;
  const dependencyGate = new Promise((resolve) => { releaseDependencies = resolve; });
  const selectedPosition = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const fallbackPosition = Cesium.Cartesian3.fromDegrees(-97.70, 30.30, 1200);
  let tracked = awarenessSubject('flights', 'selected', selectedPosition);
  const restoreCollections = stubAwarenessCollections({
    flights: [{ icao24: 'fallback', position: fallbackPosition, distanceM: 1000 }],
  });
  const runtime = installAwarenessRuntime({
    isEnabled: () => false,
    setEnabled: async (_layerId, enabled) => {
      if (enabled) await dependencyGate;
      return true;
    },
  });
  const restores = [];
  const focused = [];

  try {
    runtime.viewer.trackedEntity = { gevTrackedId: 'flights:selected' };
    replaceMethod(flightsLayer, 'getTrackedSubject', () => tracked, restores);
    replaceMethod(militaryFlightsLayer, 'getTrackedSubject', () => null, restores);
    replaceMethod(flightsLayer, 'trackById', (id) => focused.push(id) > 0, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, 'selected');

    tracked = null;
    runtime.viewer.trackedEntity = undefined;
    // Deliberately untagged: this is the DESELECT case, and an untagged clear
    // must default to deliberate. An eviction (`reason: 'evicted'`) instead
    // keeps the subject as CONTACT LOST — see the eviction tests below — but
    // must not weaken this one: a real deselect during settlement still has to
    // clear AND suppress the fallback autofocus.
    runtime.dispatch('gev:awareness-subject-cleared', {
      layerId: 'flights',
      id: 'selected',
    });
    releaseDependencies();
    await nextTurn();
    await nextTurn();

    assert.equal(militaryAwarenessLayer.getContextSnapshot(), null);
    assert.deepEqual(focused, []);
  } finally {
    releaseDependencies();
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('awareness clears are scoped to the selected source layer', () => {
  const subject = { layerId: 'ais-live-vessels', id: '123' };
  assert.equal(awarenessClearMatchesSubject(subject, { layerId: 'military-installations' }), false);
  assert.equal(awarenessClearMatchesSubject(subject, { layerId: 'ais-live-vessels' }), true);
  assert.equal(awarenessClearMatchesSubject(subject, null), false);
});

// ===========================================================================
// BEGIN Contact-readout presence block.
// Integrators: this whole delimited block belongs to the Contact-panel
// CONTACT LOST work. Keep it intact and keep any concurrent branch's own
// additions at the END of the file, so the two never collide.
// ===========================================================================

/** Live/absent/unknown presence stub matching the layer `hasContact` contract. */
function stubPresence(layer, verdict, restores) {
  replaceMethod(layer, 'hasContact', () => verdict, restores);
}

test('a fast-culled subject is reported absent so the readout can hold last-known', () => {
  // The Contact panel keeps a culled subject on screen as CONTACT LOST rather
  // than collapsing, so it needs the snapshot to say whether the subject is
  // still carried by its source.
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const runtime = installAwarenessRuntime();
  const restores = [];
  let present = true;

  try {
    replaceMethod(aisLiveVesselsLayer, 'hasContact', () => present, restores);
    replaceMethod(aisLiveVesselsLayer, 'getAllPositions', () => [{ id: '353136000', position }], restores);
    replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);

    militaryAwarenessLayer.setParams({ passive: false });
    runtime.dispatch('gev:awareness-subject-selected', {
      layerId: 'ais-live-vessels',
      id: '353136000',
      label: 'MAERSK DETROIT',
      position,
    });
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subjectPresent, true);

    present = false;
    militaryAwarenessLayer.update();
    assert.equal(
      militaryAwarenessLayer.getContextSnapshot()?.subjectPresent,
      false,
      'a subject its layer no longer carries is absent',
    );

    present = null; // layer disabled or not yet loaded: it cannot answer
    militaryAwarenessLayer.update();
    assert.equal(
      militaryAwarenessLayer.getContextSnapshot()?.subjectPresent,
      false,
      'an unanswerable tick never revives a subject already known absent',
    );

    present = true;
    militaryAwarenessLayer.update();
    assert.equal(
      militaryAwarenessLayer.getContextSnapshot()?.subjectPresent,
      true,
      'a returning subject clears the absent state',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('a layer that cannot answer is never read as a cull', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const runtime = installAwarenessRuntime();
  const restores = [];

  try {
    // `hasContact` returns null while the layer is disabled or unloaded.
    stubPresence(aisLiveVesselsLayer, null, restores);
    replaceMethod(aisLiveVesselsLayer, 'getAllPositions', () => [], restores);
    replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);

    militaryAwarenessLayer.setParams({ passive: false });
    runtime.dispatch('gev:awareness-subject-selected', {
      layerId: 'ais-live-vessels',
      id: '353136000',
      label: 'MAERSK DETROIT',
      position,
    });
    militaryAwarenessLayer.update();
    assert.equal(
      militaryAwarenessLayer.getContextSnapshot()?.subjectPresent,
      true,
      'a silent layer must not fabricate a CONTACT LOST cue',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('presence never comes from the capped position rows', () => {
  // getAllPositions(limit) breaks at its cap and the live flights layer runs
  // ~11k contacts against a 1,000 cap, so "not in the rows" is not "gone".
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const runtime = installAwarenessRuntime();
  const restores = [];
  const saturated = Array.from({ length: 1000 }, (unused, index) => ({
    id: `filler-${index}`,
    position,
  }));

  try {
    stubPresence(flightsLayer, true, restores);
    replaceMethod(flightsLayer, 'getAllPositions', () => saturated, restores);
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);

    militaryAwarenessLayer.setParams({ passive: false });
    runtime.dispatch('gev:awareness-subject-selected', {
      layerId: 'flights',
      id: 'ab4991',
      label: 'N627CT',
      position,
    });
    militaryAwarenessLayer.update();
    assert.equal(
      militaryAwarenessLayer.getContextSnapshot()?.subjectPresent,
      true,
      'a contact past the row cap is still present',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('a mapped installation subject is always present — static data is never culled', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.78, 31.13, 0);
  const runtime = installAwarenessRuntime();
  const restores = [];

  try {
    replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);

    militaryAwarenessLayer.setParams({ passive: false });
    runtime.dispatch('gev:awareness-subject-selected', {
      layerId: 'military-installations',
      id: 'fort-cavazos',
      label: 'FORT CAVAZOS',
      position,
    });
    militaryAwarenessLayer.update();
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subjectPresent, true);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('layer hasContact answers presence in O(1) and declines when unloaded', () => {
  for (const layer of [flightsLayer, militaryFlightsLayer, aisLiveVesselsLayer]) {
    assert.equal(
      typeof layer.hasContact,
      'function',
      'every presence-bearing source layer must expose hasContact',
    );
    // Unloaded layers cannot answer, and must say so rather than guessing.
    assert.equal(layer.hasContact('definitely-not-here'), null);
  }
});

test('hasContact declines while a layer is disabled, whatever its maps still hold', () => {
  // disable() hides the collection but keeps the records, so a map lookup
  // alone would report a preserved subject as FRESH from hidden stale data.
  for (const [name, source, guard] of [
    ['flights', fs.readFileSync(new URL('./flights.js', import.meta.url), 'utf8'),
      /hasContact\(icao24\) \{\s*\n\s*if \(!_billboardCollection \|\| !_billboardCollection\.show \|\| _billboards\.size === 0\) return null;/],
    ['militaryFlights', fs.readFileSync(new URL('./militaryFlights.js', import.meta.url), 'utf8'),
      /hasContact\(icao24\) \{\s*\n\s*if \(!_billboardCollection \|\| !_billboardCollection\.show \|\| _billboards\.size === 0\) return null;/],
    ['aisLiveVessels', fs.readFileSync(new URL('./aisLiveVessels.js', import.meta.url), 'utf8'),
      /hasContact\(mmsi\) \{\s*\n\s*if \(!state\.enabled \|\| !state\.vesselMap \|\| state\.vesselMap\.size === 0\) return null;/],
  ]) {
    assert.match(source, guard, `${name}.hasContact must decline while the layer is disabled`);
  }
});

test('a disabled layer leaves the presence verdict untouched', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const runtime = installAwarenessRuntime();
  const restores = [];
  let verdict = true;

  try {
    replaceMethod(aisLiveVesselsLayer, 'hasContact', () => verdict, restores);
    replaceMethod(aisLiveVesselsLayer, 'getAllPositions', () => [{ id: '353136000', position }], restores);
    replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);

    militaryAwarenessLayer.setParams({ passive: false });
    runtime.dispatch('gev:awareness-subject-selected', {
      layerId: 'ais-live-vessels', id: '353136000', label: 'MAERSK DETROIT', position,
    });

    verdict = false;
    militaryAwarenessLayer.update();
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subjectPresent, false);

    // Layer switched off: null must hold the last verdict, not revive it.
    verdict = null;
    militaryAwarenessLayer.update();
    assert.equal(
      militaryAwarenessLayer.getContextSnapshot()?.subjectPresent,
      false,
      'a disabled layer cannot resurrect a contact already known absent',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

// --- the real eviction path (Finding 1) ------------------------------------
// An aged-out contact does not merely vanish from its collection: the owning
// layer dispatches a selection-clear. Routed as a deliberate clear that nulls
// the snapshot, the panel collapses before the lost-state resolver ever runs.

function selectFlightSubject(runtime, restores, id = 'ab4991') {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 5000);
  replaceMethod(flightsLayer, 'getNearby', () => [], restores);
  replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
  replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
  replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);
  militaryAwarenessLayer.setParams({ passive: false });
  runtime.dispatch('gev:awareness-subject-selected', {
    layerId: 'flights', id, label: 'N627CT', position,
  });
  return position;
}

test('an evicted aircraft becomes CONTACT LOST instead of collapsing the panel', () => {
  const runtime = installAwarenessRuntime();
  const restores = [];
  try {
    stubPresence(flightsLayer, true, restores);
    selectFlightSubject(runtime, restores);
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, 'ab4991');

    // Exactly what flights.js emits when the poll ages a tracked plane out.
    stubPresence(flightsLayer, false, restores);
    runtime.dispatch('gev:awareness-subject-cleared', {
      layerId: 'flights', id: 'ab4991', reason: 'evicted',
    });

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    assert.ok(snapshot, 'an eviction must not null the snapshot — that hides the panel');
    assert.equal(snapshot.subject.id, 'ab4991', 'the lost contact keeps its identity');
    assert.equal(snapshot.subjectPresent, false);
    assert.equal(
      typeof snapshot.navigation?.canNext,
      'boolean',
      'navigation stays resolvable so PREVIOUS/NEXT remain operable',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('an evicted vessel becomes CONTACT LOST instead of collapsing the panel', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const runtime = installAwarenessRuntime();
  const restores = [];
  try {
    replaceMethod(aisLiveVesselsLayer, 'hasContact', () => true, restores);
    replaceMethod(aisLiveVesselsLayer, 'getAllPositions', () => [{ id: '353136000', position }], restores);
    replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);

    militaryAwarenessLayer.setParams({ passive: false });
    runtime.dispatch('gev:awareness-subject-selected', {
      layerId: 'ais-live-vessels', id: '353136000', label: 'MAERSK DETROIT', position,
    });

    // What aisLiveVessels.js emits once a selected vessel exhausts its pin.
    runtime.dispatch('gev:entity-selection-cleared', {
      layerId: 'ais-live-vessels', reason: 'evicted',
    });

    const snapshot = militaryAwarenessLayer.getContextSnapshot();
    assert.ok(snapshot, 'an eviction must not null the snapshot — that hides the panel');
    assert.equal(snapshot.subject.id, '353136000');
    assert.equal(snapshot.subjectPresent, false);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('a deliberate clear still fully clears the subject', () => {
  const runtime = installAwarenessRuntime();
  const restores = [];
  try {
    stubPresence(flightsLayer, true, restores);
    selectFlightSubject(runtime, restores);
    assert.ok(militaryAwarenessLayer.getContextSnapshot());

    // No eviction origin: click-empty-space, Escape, voice stop, layer disable.
    runtime.dispatch('gev:awareness-subject-cleared', { layerId: 'flights', id: 'ab4991' });
    assert.equal(
      militaryAwarenessLayer.getContextSnapshot(),
      null,
      'a deliberate clear must still take the panel down',
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('a deliberate source clear still fully clears the subject', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const runtime = installAwarenessRuntime();
  const restores = [];
  try {
    replaceMethod(aisLiveVesselsLayer, 'hasContact', () => true, restores);
    replaceMethod(aisLiveVesselsLayer, 'getAllPositions', () => [{ id: '353136000', position }], restores);
    replaceMethod(aisLiveVesselsLayer, 'getNearby', () => [], restores);
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryInstallationsLayer, 'getNearby', () => [], restores);

    militaryAwarenessLayer.setParams({ passive: false });
    runtime.dispatch('gev:awareness-subject-selected', {
      layerId: 'ais-live-vessels', id: '353136000', label: 'MAERSK DETROIT', position,
    });
    runtime.dispatch('gev:entity-selection-cleared', { layerId: 'ais-live-vessels' });
    assert.equal(militaryAwarenessLayer.getContextSnapshot(), null);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('production eviction sites actually tag their clears', () => {
  // The event contract above is worthless if the real cull paths never set the
  // origin, so pin the three production call sites.
  const flightsSource = fs.readFileSync(new URL('./flights.js', import.meta.url), 'utf8');
  const militarySource = fs.readFileSync(new URL('./militaryFlights.js', import.meta.url), 'utf8');
  const vesselsSource = fs.readFileSync(new URL('./aisLiveVessels.js', import.meta.url), 'utf8');

  for (const [name, source] of [['flights', flightsSource], ['militaryFlights', militarySource]]) {
    assert.match(
      source,
      /if \(icao24 === _trackedIcao\) \{\s*\n\s*_clearTracking\(false, \{ evicted: true \}\);/,
      `${name} must mark its aged-out cull as an eviction`,
    );
    assert.match(
      source,
      /reason: evicted \? 'evicted' : 'deliberate'/,
      `${name} must carry the clear origin on the dispatched event`,
    );
  }
  assert.match(
    vesselsSource,
    /clearVesselInspection\(\{ evicted: true \}\)/,
    'aisLiveVessels must mark its aged-out selected vessel as an eviction',
  );
  // Fourth cull site: a FIRMS refresh whose new payload no longer carries the
  // selected fire. The fire did not get deselected — it left the feed.
  // The tag alone is not enough — see the behavioral test in
  // firmsInteraction.test.mjs. The clear must also run BEFORE renderCurrentLod,
  // whose registration sweep deletes the record the clear needs to see.
  const firmsSource = fs.readFileSync(new URL('./firmsHeatmap.js', import.meta.url), 'utf8');
  const evictedClear = firmsSource.indexOf('clearSelectedEntityContextForLayer(id, { evicted: true });');
  const lodRebuild = firmsSource.indexOf('renderCurrentLod(true);\n      if (reselected) selectFire(reselected);');
  assert.ok(evictedClear > 0, 'FIRMS must mark a refresh-vanished selection as an eviction');
  assert.ok(lodRebuild > 0, 'the FIRMS refresh must settle its selection before rebuilding');
  assert.ok(
    evictedClear < lodRebuild,
    'the eviction clear must precede the LOD rebuild or it emits nothing at all',
  );
  // …and the deliberate FIRMS paths (layer disable, destroy, deselect) stay untagged.
  assert.equal(
    (firmsSource.match(/clearSelectedEntityContextForLayer\(id\);/g) || []).length,
    3,
    'only the refresh-vanish site is an eviction; disable/destroy/deselect stay deliberate',
  );
  assert.match(
    militaryAwarenessSource,
    /awarenessClearIsEviction/,
    'awareness must branch on the clear origin rather than always clearing',
  );
});

// ===========================================================================
// END Contact-readout presence block.
// ===========================================================================

test('cockpit blocks only non-aircraft Context camera flights', () => {
  const cockpitBody = { classList: { contains: (name) => name === 'cockpit-mode' } };
  assert.equal(contextTargetFlyToAllowed('ais-live-vessels', cockpitBody), false);
  assert.equal(contextTargetFlyToAllowed('military-installations', cockpitBody), false);
  assert.equal(contextTargetFlyToAllowed('flights', cockpitBody), true);
  assert.equal(contextTargetFlyToAllowed('ais-live-vessels', { classList: { contains: () => false } }), true);
});

test('vessel entry and selection framing both use the 3 km focus radius', () => {
  assert.match(militaryAwarenessSource, /const VESSEL_FOCUS_RADIUS_M = 3000;/);
  const focusRadiusUses = militaryAwarenessSource.match(
    /new Cesium\.BoundingSphere\(vessel\.position, VESSEL_FOCUS_RADIUS_M\)/g,
  ) || [];
  assert.equal(focusRadiusUses.length, 2);
});

test('awareness rescans only for invalidation, source change, or meaningful movement', () => {
  assert.equal(awarenessRefreshRequired({
    force: false,
    hasResults: true,
    movementM: 10,
    sourceRevisionChanged: false,
  }), false);
  assert.equal(awarenessRefreshRequired({
    force: false,
    hasResults: true,
    movementM: 250,
    sourceRevisionChanged: false,
  }), true);
  assert.equal(awarenessRefreshRequired({
    force: false,
    hasResults: true,
    movementM: 0,
    sourceRevisionChanged: true,
  }), true);
});

test('installation summaries disclose viewport-scoped coverage', () => {
  const empty = summarizeInstallationViewport([], { available: true, stale: false });
  assert.match(empty.reason, /viewport feed/i);
  assert.match(empty.reason, /not a complete 250 km survey/i);

  const unavailable = summarizeInstallationViewport([], { available: false, stale: false });
  assert.equal(unavailable.reason, 'feed unavailable');
});

test('compact Context snapshots retain installation coverage', () => {
  const snapshot = buildAwarenessContextSnapshot({
    subject: { layerId: 'flights', id: 'abc' },
    evaluatedAt: 123,
    radiusM: 250000,
    cohorts: [{
      id: 'military-installations',
      label: 'Mapped installations',
      source: 'OpenStreetMap',
      coverage: 'CURRENT VIEWPORT ONLY',
      summary: {
        relationship: 'NEARBY', count: 2, reason: 'mapped matches', nearest: [],
      },
    }],
  }, { canNext: true });

  assert.equal(snapshot.cohorts[0].coverage, 'CURRENT VIEWPORT ONLY');
  assert.deepEqual(snapshot.navigation, { canNext: true });
});

test('expanded Context results omit the redundant status heading', () => {
  assert.doesNotMatch(militaryAwarenessSource, /military-awareness-heading/);
  assert.doesNotMatch(militaryAwarenessSource, /GLOBAL CONTEXT <span>CONTEXT ONLY<\/span>/);
  assert.match(militaryAwarenessSource, /military-awareness-subject/);
  assert.match(militaryAwarenessSource, /FLIGHT \/ VESSEL WINDOW/);
  assert.match(militaryAwarenessSource, /military-awareness-controls/);
});

test('Context entry tracks a nearer civilian aircraft over a farther military aircraft', async () => {
  const camera = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const civilianPosition = Cesium.Cartesian3.fromDegrees(-97.73, 30.27, 1000);
  const militaryPosition = Cesium.Cartesian3.fromDegrees(-98.5, 30.27, 1000);
  const restoreCollections = stubAwarenessCollections({
    flights: [{ icao24: 'civilian', position: civilianPosition, distanceM: 1000 }],
    military: [{ icao24: 'military', position: militaryPosition, distanceM: 70000 }],
  });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    runtime.viewer.camera = { positionWC: camera };
    replaceMethod(flightsLayer, 'trackById', (id) => focused.push(`flights:${id}`) > 0, restores);
    replaceMethod(militaryFlightsLayer, 'trackById', (id) => focused.push(`military:${id}`) > 0, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();

    assert.deepEqual(focused, ['flights:civilian']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('Context entry prefers military aircraft on an exact nearest-distance tie', async () => {
  const camera = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const tiedPosition = Cesium.Cartesian3.fromDegrees(-97.73, 30.27, 1000);
  const restoreCollections = stubAwarenessCollections({
    flights: [{ icao24: 'civilian', position: tiedPosition, distanceM: 1000 }],
    military: [{ icao24: 'military', position: tiedPosition, distanceM: 1000 }],
  });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    runtime.viewer.camera = { positionWC: camera };
    replaceMethod(flightsLayer, 'trackById', (id) => focused.push(`flights:${id}`) > 0, restores);
    replaceMethod(militaryFlightsLayer, 'trackById', (id) => focused.push(`military:${id}`) > 0, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();

    assert.deepEqual(focused, ['military:military']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('Context entry retries once on the next refresh after initially empty feeds', async () => {
  const flights = [];
  const camera = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const position = Cesium.Cartesian3.fromDegrees(-97.73, 30.27, 1000);
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    runtime.viewer.camera = { positionWC: camera };
    replaceMethod(flightsLayer, 'trackById', (id) => focused.push(id) > 0, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();
    assert.deepEqual(focused, []);

    flights.push({ icao24: 'recovered', position, distanceM: 1000 });
    runtime.tick();
    assert.deepEqual(focused, ['recovered']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('user deselect cancels a pending Context entry auto-focus retry', async () => {
  const flights = [];
  const camera = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const selectedPosition = Cesium.Cartesian3.fromDegrees(-97.72, 30.27, 1000);
  const replacementPosition = Cesium.Cartesian3.fromDegrees(-97.73, 30.27, 1000);
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    runtime.viewer.camera = { positionWC: camera };
    replaceMethod(flightsLayer, 'trackById', (id) => focused.push(id) > 0, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    await nextTurn();
    assert.deepEqual(focused, []);

    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'user-selected', selectedPosition),
    );
    runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
    flights.push({ icao24: 'replacement', position: replacementPosition, distanceM: 1000 });
    runtime.tick();

    assert.deepEqual(focused, []);
    assert.equal(militaryAwarenessLayer.getContextSnapshot(), null);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('reset camera release preserves the selected Contact for explicit refocus', () => {
  const selectedPosition = Cesium.Cartesian3.fromDegrees(-97.72, 30.27, 1000);
  const runtime = installAwarenessRuntime();
  const restores = [];
  const released = [];
  const releaseOptions = [];

  try {
    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'selected-flight', selectedPosition),
    );
    replaceMethod(flightsLayer, 'stopTracking', (options) => {
      released.push('flights');
      releaseOptions.push(['flights', options]);
      runtime.dispatch('gev:awareness-subject-cleared', {
        layerId: 'flights',
        id: 'selected-flight',
      });
      return true;
    }, restores);
    replaceMethod(militaryFlightsLayer, 'stopTracking', (options) => {
      released.push('military');
      releaseOptions.push(['military', options]);
      return true;
    }, restores);
    replaceMethod(aisLiveVesselsLayer, 'clearSelection', () => released.push('ais') > 0, restores);

    assert.equal(militaryAwarenessLayer.releaseCameraOwnership({ origin: 'tool' }), true);

    assert.deepEqual(released, ['flights', 'military', 'ais']);
    assert.deepEqual(releaseOptions, [
      ['flights', { origin: 'tool' }],
      ['military', { origin: 'tool' }],
    ]);
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, 'selected-flight');
    assert.equal(_getAwarenessNavigationStateForTest().pendingSelectionKey, null);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('same-layer selection clear is suppressed during a synchronous navigation reselect', () => {
  const positions = {
    a: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000),
    b: Cesium.Cartesian3.fromDegrees(-97.73, 30.28, 1000),
  };
  const flights = Object.entries(positions).map(([id, position], index) => ({
    icao24: id,
    callsign: id.toUpperCase(),
    position,
    distanceM: (index + 1) * 1000,
  }));
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];

  try {
    replaceMethod(flightsLayer, 'trackById', () => {
      runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
      return true;
    }, restores);
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', positions.a));

    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, 'a');
    assert.deepEqual(_getAwarenessNavigationStateForTest(), {
      historyKeys: ['flights:a'],
      navigationVisitedKeys: ['flights:a'],
      historyLength: 1,
      navigationIndex: 0,
      suppressedHistoryKey: null,
      pendingSelectionKey: null,
    });
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('FOCUS on an already-tracked subject clears its suppression keys before a later deselect', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const flights = [{
    icao24: 'a',
    callsign: 'A',
    position,
    distanceM: 0,
  }];
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];

  try {
    let refocusCalls = 0;
    let trackCalls = 0;
    let refocusOptions = null;
    replaceMethod(flightsLayer, 'refocusTrackedById', (_id, options) => {
      refocusCalls += 1;
      refocusOptions = options;
      return true;
    }, restores);
    replaceMethod(flightsLayer, 'trackById', () => {
      trackCalls += 1;
      return true;
    }, restores);
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', position));

    assert.equal(militaryAwarenessLayer.focusCurrent({ origin: 'voice' }), true);
    assert.equal(refocusCalls, 1);
    assert.deepEqual(refocusOptions, { origin: 'voice' });
    assert.equal(trackCalls, 0, 'an owned Contact follow should reframe without recreating selection');
    assert.deepEqual(_getAwarenessNavigationStateForTest(), {
      historyKeys: ['flights:a'],
      navigationVisitedKeys: ['flights:a'],
      historyLength: 1,
      navigationIndex: 0,
      suppressedHistoryKey: null,
      pendingSelectionKey: null,
    });

    runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
    assert.equal(militaryAwarenessLayer.getContextSnapshot(), null);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('NEXT wraps through a fresh visited cycle instead of ping-ponging after exhaustion', () => {
  const positions = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, index) => [
    id,
    Cesium.Cartesian3.fromDegrees(-97.74 + index * 0.01, 30.27, 1000),
  ]));
  const flights = Object.entries(positions).map(([id, position], index) => ({
    icao24: id,
    callsign: id.toUpperCase(),
    position,
    distanceM: (index + 1) * 1000,
  }));
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    replaceMethod(flightsLayer, 'trackById', (id) => {
      focused.push(id);
      runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
      runtime.dispatch(
        'gev:awareness-subject-selected',
        awarenessSubject('flights', id, positions[id]),
      );
      return true;
    }, restores);
    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', positions.a));

    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.deepEqual(_getAwarenessNavigationStateForTest(), {
      historyKeys: ['flights:a', 'flights:b'],
      navigationVisitedKeys: ['flights:a', 'flights:b'],
      historyLength: 2,
      navigationIndex: 1,
      suppressedHistoryKey: null,
      pendingSelectionKey: null,
    });
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.deepEqual(focused, ['b', 'c', 'd']);
    assert.deepEqual(
      _getAwarenessNavigationStateForTest().navigationVisitedKeys,
      ['flights:a', 'flights:b', 'flights:c', 'flights:d'],
    );

    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.deepEqual(focused, ['b', 'c', 'd', 'a']);
    assert.deepEqual(
      _getAwarenessNavigationStateForTest().navigationVisitedKeys,
      ['flights:d', 'flights:a'],
    );

    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.deepEqual(focused, ['b', 'c', 'd', 'a', 'b', 'c']);
    assert.notDeepEqual(focused.slice(-4), ['a', 'b', 'a', 'b']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('NEXT reaches beyond the panel cap when more nearby targets exist', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  const positions = Object.fromEntries(ids.map((id, index) => [
    id,
    Cesium.Cartesian3.fromDegrees(-97.74 + index * 0.001, 30.27, 1000),
  ]));
  const flights = Object.entries(positions).map(([id, position], index) => ({
    icao24: id,
    callsign: id.toUpperCase(),
    position,
    distanceM: (index + 1) * 1000,
  }));
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    replaceMethod(flightsLayer, 'trackById', (id) => {
      focused.push(id);
      runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
      runtime.dispatch(
        'gev:awareness-subject-selected',
        awarenessSubject('flights', id, positions[id]),
      );
      return true;
    }, restores);

    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', positions.a));

    for (let index = 0; index < 11; index += 1) {
      assert.equal(militaryAwarenessLayer.navigateNext(), true);
    }

    assert.deepEqual(focused[focused.length - 1], 'l');
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('NEXT jumps to expanded flight search after fully cycling nearby flight candidates', () => {
  const subjectPosition = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const nearby = {
    b: Cesium.Cartesian3.fromDegrees(-97.739, 30.2702, 1000),
    c: Cesium.Cartesian3.fromDegrees(-97.738, 30.2704, 1000),
  };
  const expanded = {
    d: Cesium.Cartesian3.fromDegrees(-97.0, 30.8, 1000),
  };
  const nearbyFlights = Object.entries(nearby).map(([id, position], index) => ({
    icao24: id,
    callsign: id.toUpperCase(),
    position,
    distanceM: (index + 2) * 1000,
  }));
  const farFlight = {
    icao24: 'd',
    callsign: 'D',
    position: expanded.d,
    distanceM: AWARENESS_RADIUS_M + 1000,
  };

  const restoreCollections = stubAwarenessCollections({ flights: nearbyFlights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    let getNearbyCalls = 0;
    replaceMethod(flightsLayer, 'getNearby', (position, radius) => {
      getNearbyCalls += 1;
      if (radius <= AWARENESS_RADIUS_M) {
        return nearbyFlights;
      }
      return [...nearbyFlights, farFlight];
    }, restores);
    replaceMethod(flightsLayer, 'trackById', (id) => {
      focused.push(id);
      runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
      runtime.dispatch(
        'gev:awareness-subject-selected',
        awarenessSubject('flights', id, id === 'a' ? subjectPosition : { b: nearby.b, c: nearby.c, d: expanded.d }[id]),
      );
      return true;
    }, restores);

    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', subjectPosition));
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);

    assert.deepEqual(focused, ['b', 'c', 'd']);
    assert.equal(getNearbyCalls >= 3, true);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('NEXT can restrict navigation to a requested layer', () => {
  const flights = [
    { icao24: 'f1', callsign: 'F1', distanceM: 1000 },
    { icao24: 'f2', callsign: 'F2', distanceM: 1500 },
  ];
  const military = [{ icao24: 'm1', callsign: 'M1', distanceM: 700 }];
  const restoreCollections = stubAwarenessCollections({ flights, military });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    replaceMethod(flightsLayer, 'trackById', (id) => {
      focused.push(`flights:${id}`);
      return true;
    }, restores);
    replaceMethod(militaryFlightsLayer, 'trackById', (id, options) => {
      focused.push({ target: `military:${id}`, options });
      return true;
    }, restores);

    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'f1', Cesium.Cartesian3.ZERO));
    assert.equal(militaryAwarenessLayer.navigateNext({
      targetLayer: 'military',
      origin: 'voice',
    }), true);
    assert.deepEqual(focused, [{
      target: 'military:m1',
      options: { origin: 'voice' },
    }]);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('NEXT can restrict navigation to an aircraftClass', () => {
  const flights = [
    { icao24: 'f1', callsign: 'F1', distanceM: 1000, aircraftClass: 'airliner' },
    { icao24: 'f2', callsign: 'F2', distanceM: 1500, aircraftClass: 'helicopter' },
    { icao24: 'f3', callsign: 'F3', distanceM: 2000, aircraftClass: 'airliner' },
  ];
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    replaceMethod(flightsLayer, 'trackById', (id) => {
      focused.push(id);
      return true;
    }, restores);

    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'f1', Cesium.Cartesian3.ZERO));
    assert.equal(militaryAwarenessLayer.navigateNext({ aircraftClass: 'helicopter' }), true);
    assert.deepEqual(focused, ['f2']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('Cockpit NEXT ignores a nearer vessel and selects the next aircraft', () => {
  const subjectPosition = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const nextPosition = Cesium.Cartesian3.fromDegrees(-97.73, 30.28, 1200);
  const vesselPosition = Cesium.Cartesian3.fromDegrees(-97.739, 30.271, 0);
  const flights = [{
    icao24: 'f2', callsign: 'F2', distanceM: 1500, position: nextPosition,
  }];
  const vessels = [{
    mmsi: 'v1', id: 'v1', name: 'VESSEL', distanceM: 100, position: vesselPosition,
  }];
  const restoreCollections = stubAwarenessCollections({ flights, vessels });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];

  try {
    replaceMethod(flightsLayer, 'trackById', (id) => {
      focused.push(`flights:${id}`);
      return true;
    }, restores);
    replaceMethod(aisLiveVesselsLayer, 'selectById', (id) => {
      focused.push(`vessel:${id}`);
      return true;
    }, restores);

    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'f1', subjectPosition),
    );
    assert.equal(militaryAwarenessLayer.navigateNext({ aircraftOnly: true }), true);
    assert.deepEqual(focused, ['flights:f2']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('history navigation applies layer and aircraft-class filters in both directions', () => {
  const history = [
    { layerId: 'flights', id: 'airliner', aircraftClass: 'airliner' },
    { layerId: 'military', id: 'fighter', aircraftClass: 'fighter' },
    { layerId: 'military', id: 'helo', aircraftClass: 'helicopter' },
  ];
  assert.equal(findCompatibleHistoryIndex(history, 0, 1, {
    targetLayer: 'military', aircraftClass: 'helicopter',
  }), 2);
  assert.equal(findCompatibleHistoryIndex(history, 2, -1, {
    targetLayer: 'flights', aircraftClass: 'airliner',
  }), 0);
  assert.equal(findCompatibleHistoryIndex(history, 2, -1, {
    targetLayer: 'military', aircraftClass: 'helicopter',
  }), -1);
});

test('Cockpit history navigation skips vessels and installations in both directions', () => {
  const history = [
    { layerId: 'flights', id: 'airliner' },
    { layerId: 'ais-live-vessels', id: 'vessel' },
    { layerId: 'military-installations', id: 'base' },
    { layerId: 'military', id: 'fighter' },
  ];
  assert.equal(findCompatibleHistoryIndex(history, 0, 1, { aircraftOnly: true }), 3);
  assert.equal(findCompatibleHistoryIndex(history, 3, -1, { aircraftOnly: true }), 0);
});

test('production-shaped history snapshots retain aircraft class from the selected source record', () => {
  const subject = { layerId: 'military', id: 'helo-1', label: 'HELO1', position: {} };
  const snapshot = historySubjectSnapshot(subject, {
    icao24: 'helo-1',
    aircraftClass: 'helicopter',
  });
  assert.equal(snapshot.aircraftClass, 'helicopter');
  assert.equal(subject.aircraftClass, undefined);
});

test('NEXT steps over a history contact whose layer has since evicted it', () => {
  const positions = Object.fromEntries(['a', 'b', 'c'].map((id, index) => [
    id,
    Cesium.Cartesian3.fromDegrees(-97.74 + index * 0.01, 30.27, 1000),
  ]));
  const flights = Object.entries(positions).map(([id, position], index) => ({
    icao24: id,
    callsign: id.toUpperCase(),
    position,
    distanceM: (index + 1) * 1000,
  }));
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];
  const evicted = new Set();

  try {
    replaceMethod(flightsLayer, 'refocusTrackedById', () => false, restores);
    replaceMethod(flightsLayer, 'trackById', (id) => {
      // An evicted contact is gone from the layer: it cannot be tracked, and
      // it announces no selection.
      if (evicted.has(id)) return false;
      focused.push(id);
      runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
      runtime.dispatch(
        'gev:awareness-subject-selected',
        awarenessSubject('flights', id, positions[id]),
      );
      return true;
    }, restores);

    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', positions.a));
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigatePrevious(), true);
    assert.equal(militaryAwarenessLayer.navigatePrevious(), true);
    assert.deepEqual(
      _getAwarenessNavigationStateForTest().historyKeys,
      ['flights:a', 'flights:b', 'flights:c'],
    );
    assert.equal(_getAwarenessNavigationStateForTest().navigationIndex, 0);

    // CONTACT LOST: the cull evicts b while it still sits in navigation history.
    evicted.add('b');
    focused.length = 0;

    // NEXT must step over the lost entry and reach c, not dead-end on b and
    // report "no further target" for the rest of the session.
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.deepEqual(focused, ['c']);
    assert.equal(_getAwarenessNavigationStateForTest().navigationIndex, 2);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('a fully evicted forward history falls through to the live cohort', () => {
  const positions = Object.fromEntries(['a', 'b', 'c'].map((id, index) => [
    id,
    Cesium.Cartesian3.fromDegrees(-97.74 + index * 0.01, 30.27, 1000),
  ]));
  const flights = Object.entries(positions).map(([id, position], index) => ({
    icao24: id,
    callsign: id.toUpperCase(),
    position,
    distanceM: (index + 1) * 1000,
  }));
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const focused = [];
  const evicted = new Set();

  try {
    replaceMethod(flightsLayer, 'refocusTrackedById', () => false, restores);
    replaceMethod(flightsLayer, 'trackById', (id) => {
      if (evicted.has(id)) return false;
      focused.push(id);
      runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
      runtime.dispatch(
        'gev:awareness-subject-selected',
        awarenessSubject('flights', id, positions[id]),
      );
      return true;
    }, restores);

    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', positions.a));
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigatePrevious(), true);
    assert.equal(_getAwarenessNavigationStateForTest().navigationIndex, 0);

    // Every remaining forward history entry is lost.
    evicted.add('b');
    focused.length = 0;

    // With no reachable history left, NEXT resumes the live cohort search
    // rather than reporting exhaustion.
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.deepEqual(focused, ['c']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('every Context camera flight without a tracked entity takes navigation authority', () => {
  // Aircraft focus stamps for free (it assigns viewer.trackedEntity, and the UI
  // stamps on trackedEntityChanged). Vessels and installations fly WITHOUT ever
  // setting one, so an earlier deferred geocode would still match the
  // generation it captured and could resolve on top of the new Context focus.
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const vessels = [{ mmsi: '111', id: '111', name: 'VESSEL', position, distanceM: 900 }];
  const installations = [{ id: 'inst-1', name: 'BASE', position, distanceM: 1200 }];
  const restoreCollections = stubAwarenessCollections({ vessels, installations });
  const runtime = installAwarenessRuntime();
  const restores = [];
  const taken = runtime.captureAuthority();

  try {
    replaceMethod(aisLiveVesselsLayer, 'selectById', () => true, restores);
    replaceMethod(
      aisLiveVesselsLayer,
      'getAllPositions',
      () => [{ id: '111', position }],
      restores,
    );
    replaceMethod(militaryInstallationsLayer, 'focusById', () => true, restores);

    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject-a', position),
    );

    militaryAwarenessLayer.focusTarget('ais-live-vessels', '111');
    assert.deepEqual(taken, ['context-vessel-focus']);
    // The announcement precedes the flight, never trails it.
    assert.equal(runtime.cameraFlights.length, 1);

    militaryAwarenessLayer.focusTarget('military-installations', 'inst-1');
    assert.deepEqual(taken, ['context-vessel-focus', 'context-installation-focus']);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('Contacts vessel autofocus takes navigation authority before it frames', async () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const restoreCollections = stubAwarenessCollections({});
  const runtime = installAwarenessRuntime();
  const restores = [];
  const taken = [];
  runtime.window.addEventListener(
    NAVIGATION_AUTHORITY_EVENT,
    (event) => taken.push(event?.detail),
  );

  try {
    replaceMethod(militaryFlightsLayer, 'getAllPositions', () => [], restores);
    replaceMethod(flightsLayer, 'getAllPositions', () => [], restores);
    replaceMethod(
      aisLiveVesselsLayer,
      'getAllPositions',
      () => [{ id: '222', position }],
      restores,
    );
    replaceMethod(aisLiveVesselsLayer, 'selectById', () => true, restores);

    militaryAwarenessLayer.setParams({ passive: false });
    // Activation enables dependencies before it auto-focuses.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(runtime.cameraFlights.length, 1, 'autofocus framed a vessel');
    assert.deepEqual(taken, [{
      reason: 'context-vessel-autofocus',
      cancelPendingSelection: false,
    }]);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('NEXT reaches every layer before repeating any contact', () => {
  // The comparator used to rank subject-layer affinity above visited state, so
  // an already-visited same-layer contact outranked every unvisited contact in
  // the other three layers and NEXT ping-ponged inside one layer forever.
  const cohorts = [
    { id: 'flights', summary: { nearest: [{ icao24: 'f1', distanceM: 100 }, { icao24: 'f2', distanceM: 200 }] } },
    { id: 'military', summary: { nearest: [{ icao24: 'm1', distanceM: 300 }] } },
    { id: 'ais-live-vessels', summary: { nearest: [{ mmsi: 'v1', distanceM: 400 }] } },
    { id: 'military-installations', summary: { nearest: [{ id: 'i1', distanceM: 500 }] } },
  ];
  const subject = { layerId: 'flights', id: 'f0' };
  const visited = new Set(['flights:f0']);
  const reached = [];

  // Walk the whole cohort. Under the old comparator step 3 handed back the
  // already-visited f1, because subject-layer affinity outranked visited state.
  for (let step = 0; step < 5; step += 1) {
    const [next] = getAwarenessNavigationTargets(cohorts, subject, [...visited]);
    assert.ok(next, `step ${step} produced no target`);
    const key = `${next.layerId}:${next.id}`;
    assert.equal(visited.has(key), false, `step ${step} repeated ${key}`);
    visited.add(key);
    reached.push(next.layerId);
  }

  assert.deepEqual(
    [...new Set(reached)].sort(),
    ['ais-live-vessels', 'flights', 'military', 'military-installations'],
    'a full cohort walk must reach all four layers, not loop inside one',
  );
});

test('the navigable cohort is generous but finite, and the count stays exact', () => {
  // Caps guard materialization only. A cohort larger than the navigable window
  // must still report its true size — a capped COUNT would be a lie.
  const items = Array.from({ length: 12000 }, (_, index) => ({
    id: `installation-${index}`,
    distanceM: index,
  }));
  const summary = summarizeInstallationViewport(items, { available: true, stale: false });
  assert.equal(summary.count, 12000, 'the count reflects every in-range item');
  assert.equal(summary.nearest.length, 10, 'the panel still shows ten');
  assert.ok(Number.isFinite(AWARENESS_QUERY_LIMIT), 'the fetch limit is finite');
  assert.ok(
    summary.navigationNearest.length < 12000,
    'the navigable window is bounded',
  );
  assert.ok(
    summary.navigationNearest.length >= 5001,
    'and still far beyond the former 5,000 cap',
  );
});

test('walking a cohort does not rescan the source layer per selection', () => {
  // Each selection used to pay a fresh full-layer proximity scan just to recover
  // the aircraft class for its history snapshot. The sweep already holds that
  // record, so a NEXT burst must not grow the scan count.
  const positions = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, index) => [
    id,
    Cesium.Cartesian3.fromDegrees(-97.74 + index * 0.01, 30.27, 1000),
  ]));
  const flights = Object.entries(positions).map(([id, position], index) => ({
    icao24: id,
    callsign: id.toUpperCase(),
    position,
    distanceM: (index + 1) * 1000,
    aircraftClass: 'airliner',
  }));
  const restoreCollections = stubAwarenessCollections({ flights });
  const runtime = installAwarenessRuntime();
  const restores = [];
  let historyScans = 0;

  try {
    const scanning = flightsLayer.getNearby;
    replaceMethod(flightsLayer, 'getNearby', (...args) => {
      // The history-snapshot lookup has a signature all its own: a tight 1 km
      // radius with a 25-row cap. Cohort sweeps use the awareness radius.
      const [, range, maxCount] = args;
      if (range === 1000 && maxCount === 25) historyScans += 1;
      return scanning.apply(flightsLayer, args);
    }, restores);
    replaceMethod(flightsLayer, 'trackById', (id) => {
      runtime.dispatch('gev:entity-selection-cleared', { layerId: 'flights' });
      runtime.dispatch(
        'gev:awareness-subject-selected',
        awarenessSubject('flights', id, positions[id]),
      );
      return true;
    }, restores);

    runtime.dispatch('gev:awareness-subject-selected', awarenessSubject('flights', 'a', positions.a));
    historyScans = 0;

    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);

    // Every contact in this burst is already in the sweep, so the snapshot
    // reads it from there and the extra scans are zero.
    assert.equal(
      historyScans,
      0,
      `a three-step NEXT burst paid ${historyScans} extra layer scans (want 0)`,
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('the contacts window reports exactly the counts the panel renders', () => {
  // Field case: the panel showed 42 while analyst_query reported 8 for the same
  // 250 km question — the panel counts the awareness cohort, analyst counts
  // CURRENTLY-LOADED records, and the flights layer reloads by viewport. Both
  // honest. The window block exists so the panel's numbers travel with the
  // answer, so it must be derived from the panel's own snapshot, not recomputed.
  const results = {
    subject: { layerId: 'flights', id: 'a52e54', label: 'ASA635', position: Cesium.Cartesian3.ZERO },
    evaluatedAt: Date.now(),
    radiusM: AWARENESS_RADIUS_M,
    cohorts: [
      { id: 'flights', label: 'Flights', source: 'OpenSky', summary: { relationship: 'nearby', count: 42, reason: 'observed', nearest: [] } },
      { id: 'military', label: 'Military flights', source: 'adsb.lol', summary: { relationship: 'nearby', count: 13, reason: 'observed', nearest: [] } },
      { id: 'ais-live-vessels', label: 'AIS vessels', source: 'AISStream', summary: { relationship: 'unknown', count: null, reason: 'feed unavailable', nearest: [] } },
    ],
  };
  const snapshot = buildAwarenessContextSnapshot(results, {});
  const window = contactsWindowFromSnapshot(snapshot);

  // Same fixture, both derivations: the window equals the rendered cohort counts.
  const rendered = Object.fromEntries(
    snapshot.cohorts.map((cohort) => [cohort.id, cohort.count]),
  );
  assert.equal(window.flights, rendered.flights);
  assert.equal(window.military, rendered.military);
  assert.equal(window.flights, 42);
  assert.equal(window.military, 13);
  assert.equal(window.aircraft, 55);
  assert.equal(window.centeredOn, 'ASA635');
  assert.equal(window.radiusKm, Math.round(AWARENESS_RADIUS_M / 1000));
  // A feed that cannot answer says so rather than reporting a confident zero.
  assert.equal(rendered['ais-live-vessels'], null);
  assert.equal(window.vessels, 'unknown');
});

test('there is no contacts window without a subject', () => {
  assert.equal(contactsWindowFromSnapshot(null), null);
  assert.equal(contactsWindowFromSnapshot({ cohorts: [] }), null);
});

test('installation summaries keep the full navigation cohort beyond the former 5,000 cap', () => {
  const items = Array.from({ length: 5001 }, (_, index) => ({
    id: `installation-${index}`,
    distanceM: index * 1000,
  }));
  const summary = summarizeInstallationViewport(items, { available: true, stale: false });
  assert.equal(summary.nearest.length, 10);
  assert.equal(summary.navigationNearest.length, 5001);
  assert.equal(AWARENESS_QUERY_LIMIT >= 5001, true);
});

test('unknown subject cohort blocks cross-layer NEXT navigation and availability', () => {
  const vesselPosition = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const militaryPosition = Cesium.Cartesian3.fromDegrees(-97.7, 30.3, 1000);
  const restoreCollections = stubAwarenessCollections({
    military: [{
      icao24: 'm1',
      callsign: 'M1',
      position: militaryPosition,
      distanceM: 5000,
    }],
  });
  const runtime = installAwarenessRuntime({
    isEnabled: (layerId) => layerId !== 'ais-live-vessels',
  });
  const restores = [];
  let focusCalls = 0;

  try {
    replaceMethod(militaryFlightsLayer, 'trackById', () => {
      focusCalls += 1;
      return true;
    }, restores);
    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('ais-live-vessels', 'v1', vesselPosition),
    );

    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.navigation.canNext, false);
    assert.equal(militaryAwarenessLayer.navigateNext(), false);
    assert.equal(focusCalls, 0);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('NEXT availability helper gates only new-target branches on an unknown cohort', () => {
  assert.equal(canNavigateAwarenessNext({
    hasForwardHistory: true,
    hasExpandedFlightTarget: true,
    hasNearbyTarget: true,
    subjectCohortUnknown: true,
  }), true);
  assert.equal(canNavigateAwarenessNext({
    hasExpandedFlightTarget: true,
    subjectCohortUnknown: true,
  }), false);
  assert.equal(canNavigateAwarenessNext({
    hasNearbyTarget: true,
    subjectCohortUnknown: true,
  }), false);
  assert.equal(canNavigateAwarenessNext({
    hasExpandedFlightTarget: true,
    subjectCohortUnknown: false,
  }), true);
});

test('canNext agrees with NEXT for unknown, healthy-empty, and recovered flight feeds', () => {
  const positions = {
    subject: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000),
    contact: Cesium.Cartesian3.fromDegrees(-97.7, 30.3, 1000),
  };
  const military = [{
    icao24: 'm1',
    callsign: 'M1',
    position: positions.contact,
    distanceM: 5000,
  }];
  let flightsEnabled = false;
  const restoreCollections = stubAwarenessCollections({ military });
  const runtime = installAwarenessRuntime({
    isEnabled: (layerId) => layerId !== 'flights' || flightsEnabled,
  });
  const restores = [];
  let focusCalls = 0;

  try {
    replaceMethod(militaryFlightsLayer, 'trackById', () => {
      focusCalls += 1;
      return true;
    }, restores);

    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject', positions.subject),
    );
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.navigation.canNext, false);
    assert.equal(militaryAwarenessLayer.navigateNext(), false);
    assert.equal(focusCalls, 0);

    flightsEnabled = true;
    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject', positions.subject),
    );
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.navigation.canNext, true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(focusCalls, 1);

    flightsEnabled = false;
    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject', positions.subject),
    );
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.navigation.canNext, false);

    flightsEnabled = true;
    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject', positions.subject),
    );
    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.navigation.canNext, true);
    assert.equal(militaryAwarenessLayer.navigateNext(), true);
    assert.equal(focusCalls, 2);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});

test('far-side hidden aircraft cannot enable NEXT when navigation cannot see them', () => {
  const subjectPosition = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const hiddenPosition = Cesium.Cartesian3.fromDegrees(82.26, -30.27, 1000);
  const runtime = installAwarenessRuntime();
  const restores = [];

  try {
    replaceMethod(flightsLayer, 'getNearby', () => [], restores);
    replaceMethod(militaryFlightsLayer, 'getNearby', () => [], restores);
    replaceMethod(flightsLayer, 'getAllPositions', () => [{
      id: 'hidden',
      position: hiddenPosition,
    }], restores);
    replaceMethod(militaryFlightsLayer, 'getAllPositions', () => [], restores);

    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject', subjectPosition),
    );

    assert.equal(militaryAwarenessLayer.getContextSnapshot()?.navigation.canNext, false);
    assert.equal(militaryAwarenessLayer.navigateNext(), false);
  } finally {
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
  }
});

test('runtime listeners exist only while the awareness layer is enabled', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const listeners = new Map();
  let preRenderListeners = 0;
  let nextTimer = 1;

  class FakeElement {
    constructor() {
      this.classList = { contains: () => false };
      this.style = { setProperty() {} };
      this.hidden = false;
      this.innerHTML = '';
    }

    setAttribute() {}
    addEventListener() {}
    removeEventListener() {}
    appendChild() {}
    append() {}
    remove() {}
    replaceChildren() {}
  }

  const fakeWindow = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    setInterval() { return nextTimer++; },
    clearInterval() {},
    requestAnimationFrame(callback) { return nextTimer++; },
    cancelAnimationFrame() {},
  };
  const fakeBody = new FakeElement();
  const viewer = {
    scene: {
      preRender: {
        addEventListener() {
          preRenderListeners += 1;
          return () => { preRenderListeners -= 1; };
        },
      },
    },
    entities: { remove() {} },
    container: new FakeElement(),
  };

  globalThis.window = fakeWindow;
  globalThis.document = {
    body: fakeBody,
    getElementById() { return null; },
    createElement() { return new FakeElement(); },
  };

  try {
    militaryAwarenessLayer.setParams({ passive: true });
    militaryAwarenessLayer.init(viewer);
    assert.equal([...listeners.values()].reduce((count, set) => count + set.size, 0), 0);
    assert.equal(preRenderListeners, 0);

    militaryAwarenessLayer.enable();
    assert.equal([...listeners.values()].reduce((count, set) => count + set.size, 0), 4);
    assert.equal(preRenderListeners, 1);

    militaryAwarenessLayer.disable();
    assert.equal([...listeners.values()].reduce((count, set) => count + set.size, 0), 0);
    assert.equal(preRenderListeners, 0);

    militaryAwarenessLayer.enable();
    militaryAwarenessLayer.destroy();
    assert.equal([...listeners.values()].reduce((count, set) => count + set.size, 0), 0);
    assert.equal(preRenderListeners, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test('awareness runtime parameters return a detached snapshot', () => {
  militaryAwarenessLayer.setParams({ passive: false });
  const snapshot = militaryAwarenessLayer.getParams();
  militaryAwarenessLayer.setParams({ passive: true });
  assert.deepEqual(snapshot, { passive: false });
});

test('Contacts refresh cadence is snappy while the camera moves and parked otherwise', () => {
  assert.equal(awarenessRefreshIntervalMs(false), 750);
  assert.ok(
    awarenessRefreshIntervalMs(true) >= 100 && awarenessRefreshIntervalMs(true) <= 200,
    'a moving camera earns a ~150-200 ms cadence',
  );
});

test('intermittent pose-bin crossings cannot refresh faster than the motion floor', () => {
  // The adversarial pattern: a SLOW continuous drag. The pose signature is
  // quantized, so it crosses a bin only every fourth frame — which a per-frame
  // "unchanged means parked" test reads as a motion-end four times a frame-quad,
  // refreshing at nearly display rate.
  let lastRefreshMs = 0;
  let lastPoseChangeMs = 0;
  let wasMoving = false;
  let refreshes = 0;
  const frames = 60;
  const frameMs = 16;
  for (let frame = 0; frame < frames; frame += 1) {
    const nowMs = 1_000 + frame * frameMs;
    if (frame % 4 === 0) lastPoseChangeMs = nowMs;
    const decision = awarenessRefreshDecision({ nowMs, lastRefreshMs, lastPoseChangeMs, wasMoving });
    wasMoving = decision.moving;
    if (decision.refresh) {
      refreshes += 1;
      lastRefreshMs = nowMs;
    }
  }
  // 960 ms of motion against a 175 ms floor tops out at six refreshes.
  const ceiling = Math.ceil((frames * frameMs) / awarenessRefreshIntervalMs(true));
  assert.ok(
    refreshes <= ceiling,
    `intermittent bin crossings must respect the ${awarenessRefreshIntervalMs(true)} ms floor: `
    + `expected at most ${ceiling} refreshes in ${frames} frames, got ${refreshes}`,
  );
  assert.ok(refreshes >= 4, `motion must still be snappy, got ${refreshes}`);
});

test('motion ends only after the pose has been unchanged through the settle window', () => {
  const parked = (nowMs, lastPoseChangeMs, wasMoving = true) => awarenessRefreshDecision({
    nowMs, lastRefreshMs: nowMs - 10_000, lastPoseChangeMs, wasMoving,
  }).moving;
  assert.equal(parked(1_000, 1_000), true, 'the frame the pose changed is moving');
  assert.equal(parked(1_200, 1_000), true, 'a 200 ms gap between bin crossings is still moving');
  assert.equal(parked(1_249, 1_000), true, 'just inside the settle window is still moving');
  assert.equal(parked(1_250, 1_000), false, 'the settle window expiring ends motion');
});

test('the motion-end settle refresh still respects the motion floor', () => {
  // Motion ends 20 ms after a refresh: the settle must NOT jump the floor.
  const tooSoon = awarenessRefreshDecision({
    nowMs: 2_000, lastRefreshMs: 1_980, lastPoseChangeMs: 1_700, wasMoving: true,
  });
  assert.deepEqual(tooSoon, { moving: false, refresh: false });
  const allowed = awarenessRefreshDecision({
    nowMs: 2_000, lastRefreshMs: 1_800, lastPoseChangeMs: 1_700, wasMoving: true,
  });
  assert.deepEqual(allowed, { moving: false, refresh: true });
});

test('parked Contacts takes no continuous-render hold and requests at most the parked cadence', () => {
  const realNow = Date.now;
  let clockMs = 1_700_000_000_000;
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const neighbour = Cesium.Cartesian3.fromDegrees(-97.7, 30.27, 1000);
  const restoreCollections = stubAwarenessCollections({
    // A real neighbouring contact, so the cohort is genuinely LIVE — an empty
    // or failed cohort must not take the hold (see the failed-feed test below).
    flights: [
      { icao24: 'subject-flight', position, distanceM: 0 },
      { icao24: 'neighbour-flight', position: neighbour, distanceM: 4000 },
    ],
  });
  _resetRenderGovernorForTest();
  const runtime = installAwarenessRuntime();
  const holds = () => getRenderGovernorDiagnostics().holds;

  try {
    Date.now = () => clockMs;
    installRenderGovernor(runtime.viewer);
    runtime.viewer.camera = {
      positionWC: new Cesium.Cartesian3(1_000_000, 200_000, 300_000),
      heading: 0,
      pitch: -0.4,
      roll: 0,
    };

    // 1. Enabled, nothing selected, camera parked — Contacts must not be a
    //    reason the whole scene keeps repainting.
    assert.ok(!holds().includes('military-awareness'), 'enable() must not hold outright');
    for (let frame = 0; frame < 60; frame += 1) { clockMs += 16; runtime.tick(); }
    assert.ok(!holds().includes('military-awareness'), 'a parked empty panel holds nothing');

    // 2. A live subject, still parked: one ring paints, then quiet.
    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject-flight', position),
    );
    const requestsAfterSelect = runtime.renderRequests.length;
    for (let frame = 0; frame < 60; frame += 1) { clockMs += 16; runtime.tick(); }
    assert.ok(!holds().includes('military-awareness'), 'a parked panel holds nothing even with a subject');
    const parkedRequests = runtime.renderRequests.length - requestsAfterSelect;
    // 960 ms parked = at most two 750 ms-cadence frames' worth of requests.
    assert.ok(parkedRequests <= 2, `parked Contacts requested ${parkedRequests} renders in 960 ms`);

    // 3. Moving: the arrows are screen-projected, so per-frame work is real.
    clockMs += 16;
    runtime.viewer.camera.heading += 0.5;
    runtime.tick();
    assert.ok(holds().includes('military-awareness'), 'a moving view earns the hold');

    // 4. Parked again: the hold is dropped on a frame the hold itself bought.
    clockMs += 300;
    runtime.tick();
    assert.ok(!holds().includes('military-awareness'), 'settling releases the hold');

    // 5. Teardown releases even without another frame.
    runtime.viewer.camera.heading += 0.5;
    clockMs += 16;
    runtime.tick();
    assert.ok(holds().includes('military-awareness'));
    militaryAwarenessLayer.disable();
    assert.ok(!holds().includes('military-awareness'), 'disable() drops the hold');
  } finally {
    Date.now = realNow;
    runtime.restore();
    restoreCollections();
    _resetRenderGovernorForTest();
  }
});

test('Contacts needs continuous render only for a live cohort under a moving view', () => {
  const need = (input) => awarenessNeedsContinuousRender(input);
  assert.equal(need({ cameraMoving: true, hasSubject: true, hasLiveResults: true }), true);
  assert.equal(need({ cameraMoving: false, hasSubject: true, hasLiveResults: true }), false);
  assert.equal(need({ cameraMoving: true, hasSubject: false, hasLiveResults: false }), false);
  assert.equal(need({ cameraMoving: true, hasSubject: true, hasLiveResults: false }), false);
});

test('empty and failed cohorts are not "live" — there is no arrow to animate', () => {
  const cohorts = (...counts) => ({ cohorts: counts.map((count) => ({ summary: { count } })) });
  assert.equal(awarenessResultsAreLive(cohorts(3, 0, null)), true, 'one populated cohort is enough');
  assert.equal(awarenessResultsAreLive(cohorts(0, 0, 0)), false, 'healthy but empty feeds animate nothing');
  assert.equal(awarenessResultsAreLive(cohorts(null, null)), false, 'unavailable/stale feeds animate nothing');
  assert.equal(awarenessResultsAreLive(cohorts(0, null)), false);
  assert.equal(awarenessResultsAreLive({ cohorts: [] }), false);
  assert.equal(awarenessResultsAreLive(null), false);
});

test('a moving view over failed feeds takes no continuous-render hold', () => {
  const realNow = Date.now;
  let clockMs = 1_700_000_000_000;
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  // Every dependency reports unavailable, so every cohort summarizes to count
  // null — the exact state the old Boolean(state.results) gate still held for.
  const restoreCollections = stubAwarenessCollections({});
  _resetRenderGovernorForTest();
  const runtime = installAwarenessRuntime({ isEnabled: () => false });
  const holds = () => getRenderGovernorDiagnostics().holds;

  try {
    Date.now = () => clockMs;
    installRenderGovernor(runtime.viewer);
    runtime.viewer.camera = {
      positionWC: new Cesium.Cartesian3(1_000_000, 200_000, 300_000),
      heading: 0,
      pitch: -0.4,
      roll: 0,
    };
    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject-flight', position),
    );
    const results = militaryAwarenessLayer.getContextSnapshot();
    assert.ok(results, 'a subject is selected, so an evaluation exists');
    assert.equal(awarenessResultsAreLive(results), false, 'but every cohort is empty/failed');

    for (let frame = 0; frame < 10; frame += 1) {
      clockMs += 16;
      runtime.viewer.camera.heading += 0.5; // unmistakably moving
      runtime.tick();
    }
    assert.ok(
      !holds().includes('military-awareness'),
      'a moving view with nothing to point at must not pin the governor',
    );
  } finally {
    Date.now = realNow;
    runtime.restore();
    restoreCollections();
    _resetRenderGovernorForTest();
  }
});

test('a moving camera refreshes Contacts more than once inside one parked interval', () => {
  const realNow = Date.now;
  let clockMs = 1_700_000_000_000;
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
  const restoreCollections = stubAwarenessCollections({
    flights: [{ icao24: 'subject-flight', position, distanceM: 0 }],
  });
  const runtime = installAwarenessRuntime();
  const restores = [];
  let refreshes = 0;

  try {
    Date.now = () => clockMs;
    runtime.viewer.camera = {
      positionWC: new Cesium.Cartesian3(1_000_000, 200_000, 300_000),
      heading: 0,
      pitch: -0.4,
      roll: 0,
    };
    replaceMethod(flightsLayer, 'getAllPositions', () => {
      refreshes += 1;
      return [{ id: 'subject-flight', position }];
    }, restores);

    runtime.dispatch(
      'gev:awareness-subject-selected',
      awarenessSubject('flights', 'subject-flight', position),
    );

    // 720 ms of MOVING frames at ~60 Hz — one parked interval's worth of time.
    refreshes = 0;
    for (let frame = 0; frame < 45; frame += 1) {
      clockMs += 16;
      runtime.viewer.camera.heading += 0.02; // "looking around"
      runtime.tick();
    }
    assert.ok(
      refreshes > 1,
      `expected more than one refresh inside a 750 ms motion window, got ${refreshes}`,
    );
    assert.ok(
      refreshes <= Math.ceil(720 / awarenessRefreshIntervalMs(true)),
      `motion must stay under the ${awarenessRefreshIntervalMs(true)} ms floor, got ${refreshes}`,
    );

    // Motion stops. Hysteresis keeps the view "moving" for one settle window,
    // which ends in a single settle refresh; after that the cheap parked
    // cadence resumes at exactly one refresh per 750 ms.
    clockMs += 300;
    runtime.tick();
    refreshes = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      clockMs += 16;
      runtime.tick();
    }
    assert.equal(refreshes, 1, 'a parked camera keeps the single-refresh-per-750 ms cadence');
  } finally {
    Date.now = realNow;
    restores.reverse().forEach((restore) => restore());
    runtime.restore();
    restoreCollections();
  }
});
