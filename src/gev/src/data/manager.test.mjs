// Re-entrancy contract for DataLayerManager.toggle() (audit M1 ⊗).
//
// The bug: toggle() awaits the layer's init() + first update() before arming the
// polling interval. A second toggle during that window used to interleave — the
// disable branch ran mid-enable, the interval was armed AFTER the user turned the
// layer off, and a subsequent enable armed a SECOND interval → 2× poll → OpenSky
// 429. The fix serializes toggles per-entry and re-checks enabled after the awaits.
//
// Pure test: the manager only calls the layer module's lifecycle methods and (when
// a toggle container is present) DOM refresh. We pass no container, so it stays
// headless. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager, layerFeedState } from './manager.js';
import {
  contextSnapshotLayerIds,
  shouldCaptureContextSession,
} from '../contextModePolicy.js';

/** Build a mock layer whose init/update resolve on the next microtask, so a
 *  second toggle can land while the first is awaiting. */
function makeSlowLayer(id, { updateInterval = 1000 } = {}) {
  const calls = { enable: 0, disable: 0, update: 0, init: 0, presentation: [] };
  return {
    calls,
    module: {
      id,
      name: id,
      icon: '',
      source: 'test',
      updateInterval,
      async init() { calls.init++; await Promise.resolve(); },
      enable() { calls.enable++; },
      disable() { calls.disable++; },
      async update() { calls.update++; await Promise.resolve(); },
      setLifecyclePresentation(state) { calls.presentation.push({ ...state }); },
      getStats() { return { count: 0, lastUpdate: null }; },
    },
  };
}

test('keeps panel-hidden coordinator layers registered and addressable', () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('military-awareness', { updateInterval: -1 });
  layer.module.showInTogglePanel = false;
  mgr.register(layer.module);
  assert.deepEqual(mgr.getAll().map(({ id, showInTogglePanel }) => ({ id, showInTogglePanel })), [
    { id: 'military-awareness', showInTogglePanel: false },
  ]);
  assert.equal(mgr.isEnabled('military-awareness'), false);
});

test('adopts direct layer params without re-entering the layer setter', () => {
  let params = { selectedFlightsTrackingId: 'flight-a' };
  let setterCalls = 0;
  const manager = new DataLayerManager({});
  manager.register({
    id: 'flights', name: 'Flights', icon: '', source: 'test',
    setParams() { setterCalls += 1; return true; },
    getParams() { return { ...params }; },
  });
  const events = [];
  manager.subscribe((event) => events.push(event));
  assert.equal(manager.adoptLayerParams('flights', {
    selectedFlightsTrackingId: 'flight-a',
  }, { origin: 'user' }), true);
  assert.equal(setterCalls, 0);
  assert.equal(events.at(-1)?.type, 'params');
  assert.equal(events.at(-1)?.params.selectedFlightsTrackingId, 'flight-a');
  params = { selectedFlightsTrackingId: 'flight-b' };
  assert.equal(manager.adoptLayerParams('flights', {
    selectedFlightsTrackingId: 'flight-a',
  }, { origin: 'user' }), false, 'changed live params reject stale adoption');
});

test('adopts settled visibility without re-running lifecycle work', async () => {
  const manager = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  manager.register(layer.module);
  await manager.setEnabled('flights', true, { origin: 'programmatic' });
  const events = [];
  manager.subscribe((event) => events.push(event));
  assert.equal(manager.adoptLayerVisibility('flights', true, {
    origin: 'user',
    adoptedFromSelection: true,
  }), true);
  assert.equal(layer.calls.enable, 1);
  assert.equal(events.at(-1)?.type, 'visibility');
  assert.equal(events.at(-1)?.adoptedFromSelection, true);
  assert.equal(manager.adoptLayerVisibility('flights', false, { origin: 'user' }), false);
});

test('renders ordinary layer rows without recreating a panel-hidden coordinator', async () => {
  const originalDocument = globalThis.document;
  const makeElement = () => {
    const element = {
      children: [],
      className: '',
      dataset: {},
      textContent: '',
      disabled: false,
      attributes: {},
      classList: {
        toggle() {},
      },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener() {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      querySelector(selector) {
        if (selector.startsWith('[data-layer-id="')) {
          const id = selector.slice(16, -2);
          return this.children.find((child) => child.dataset.layerId === id) || null;
        }
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        const visit = (node) => {
          if (String(node.className).split(/\s+/).includes(className)) return node;
          for (const child of node.children || []) {
            const found = visit(child);
            if (found) return found;
          }
          return null;
        };
        return visit(this);
      },
      set innerHTML(value) { if (value === '') this.children = []; },
      get innerHTML() { return ''; },
    };
    return element;
  };
  globalThis.document = { createElement: makeElement };
  const mgr = new DataLayerManager({});
  const ordinary = makeSlowLayer('flights', { updateInterval: -1 });
  const coordinator = makeSlowLayer('military-awareness', { updateInterval: -1 });
  coordinator.module.showInTogglePanel = false;
  mgr.register(ordinary.module);
  mgr.register(coordinator.module);
  const container = makeElement();

  try {
    mgr.buildTogglePanel(container);
    assert.ok(container.querySelector('[data-layer-id="flights"]'));
    assert.equal(container.querySelector('[data-layer-id="military-awareness"]'), null);
    assert.equal(await mgr.setEnabled('military-awareness', true), true);
    mgr._refreshTogglePanel();
    assert.equal(container.querySelector('[data-layer-id="military-awareness"]'), null);
    assert.equal(mgr.getAll().find(({ id }) => id === 'military-awareness').enabled, true);
  } finally {
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('clearSelectedLayers includes hidden coordinators and preserves newer dependency restoration', async () => {
  const mgr = new DataLayerManager({});
  const order = [];
  const satellites = makeSlowLayer('satellites', { updateInterval: -1 });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  const context = makeSlowLayer('military-awareness', { updateInterval: -1 });
  context.module.showInTogglePanel = false;
  satellites.module.disable = () => { order.push('satellites'); };
  missions.module.disable = async () => {
    order.push('rocket-launches');
    await mgr.setEnabled('satellites', true, { origin: 'dependency-restore' });
  };
  context.module.disable = () => { order.push('military-awareness'); };
  for (const layer of [satellites, missions, context]) mgr.register(layer.module);
  await mgr.setEnabled('satellites', true);
  await mgr.setEnabled('rocket-launches', true);
  await mgr.setEnabled('military-awareness', true);

  const result = await mgr.clearSelectedLayers({ origin: 'user' });

  assert.deepEqual(result.targetIds, [
    'military-awareness',
    'rocket-launches',
    'satellites',
  ]);
  assert.deepEqual(order, ['military-awareness', 'rocket-launches']);
  assert.deepEqual(result.clearedIds, ['military-awareness', 'rocket-launches']);
  assert.deepEqual(result.notClearedIds, ['satellites']);
  assert.equal(result.items.find(({ id }) => id === 'satellites')?.superseded, true);
  assert.deepEqual([...mgr.getEnabledLayerIds()], ['satellites']);
  await mgr.destroyAll();
});

test('clearSelectedLayers absorbs a hidden coordinator fire-and-forget dependency release', async () => {
  const mgr = new DataLayerManager({});
  const flights = makeSlowLayer('flights', { updateInterval: -1 });
  const context = makeSlowLayer('military-awareness', { updateInterval: -1 });
  context.module.showInTogglePanel = false;
  let releaseFinished;
  const finished = new Promise((resolve) => { releaseFinished = resolve; });
  context.module.disable = () => {
    void mgr.setEnabled('flights', false, { origin: 'dependency-release' })
      .finally(releaseFinished);
  };
  mgr.register(flights.module);
  mgr.register(context.module);
  await mgr.setEnabled('flights', true);
  await mgr.setEnabled('military-awareness', true);

  const result = await mgr.clearSelectedLayers({ origin: 'user' });
  await finished;

  assert.deepEqual(result.targetIds, ['military-awareness', 'flights']);
  assert.deepEqual(result.notClearedIds, []);
  assert.deepEqual([...mgr.getEnabledLayerIds()], []);
});

test('clearSelectedLayers continues after failures and reports final lifecycle truth', async () => {
  const mgr = new DataLayerManager({});
  const ordinary = makeSlowLayer('flights', { updateInterval: -1 });
  const failing = makeSlowLayer('traffic', { updateInterval: -1 });
  failing.module.disable = () => false;
  mgr.register(ordinary.module);
  mgr.register(failing.module);
  await mgr.setEnabled('flights', true);
  await mgr.setEnabled('traffic', true);

  const result = await mgr.clearSelectedLayers();

  assert.deepEqual(result.clearedIds, ['flights']);
  assert.deepEqual(result.notClearedIds, ['traffic']);
  const failure = result.items.find(({ id }) => id === 'traffic');
  assert.equal(failure.enabled, true);
  assert.equal(failure.lifecycleState, 'enabled');
  assert.equal(failure.uncertain, true);
  assert.equal(await mgr.setEnabled('traffic', false), false);
});

test('newer direct layer intent supersedes clearSelectedLayers without a blind retry', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  let releaseDisable;
  let announceDisable;
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  layer.module.disable = async () => {
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };
  mgr.register(layer.module);
  await mgr.setEnabled('flights', true);

  const clearing = mgr.clearSelectedLayers({ origin: 'user' });
  await disableStarted;
  const newerEnable = mgr.setEnabled('flights', true, { origin: 'voice' });
  releaseDisable();
  const result = await clearing;
  await newerEnable;

  assert.deepEqual(result.notClearedIds, ['flights']);
  assert.equal(mgr.isEnabled('flights'), true);
  assert.deepEqual(mgr.getLayerLifecycleState('flights'), {
    enabled: true,
    lifecycleState: 'enabled',
    uncertain: false,
  });
});

test('clearSelectedLayers does not issue a delayed OFF after a newer explicit ON', async () => {
  const mgr = new DataLayerManager({});
  const flights = makeSlowLayer('flights', { updateInterval: -1 });
  const blocker = makeSlowLayer('traffic', { updateInterval: -1 });
  let releaseBlocker;
  let announceBlocker;
  const blockerStarted = new Promise((resolve) => { announceBlocker = resolve; });
  blocker.module.disable = async () => {
    announceBlocker();
    await new Promise((resolve) => { releaseBlocker = resolve; });
  };
  mgr.register(flights.module);
  mgr.register(blocker.module);
  await mgr.setEnabled('flights', true);
  await mgr.setEnabled('traffic', true);

  const clearing = mgr.clearSelectedLayers({ origin: 'user' });
  await blockerStarted;
  await mgr.setEnabled('flights', true, { origin: 'voice' });
  releaseBlocker();
  const result = await clearing;

  const flightsResult = result.items.find(({ id }) => id === 'flights');
  assert.equal(flightsResult.superseded, true);
  assert.equal(flightsResult.enabled, true);
  assert.deepEqual(result.notClearedIds, ['flights']);
});

test('clearSelectedLayers skips delayed OFF for every newer absolute-intent origin', async (t) => {
  for (const origin of ['user', 'voice', 'programmatic', 'dependency-restore', 'context-restore']) {
    await t.test(origin, async () => {
      const mgr = new DataLayerManager({});
      const flights = makeSlowLayer('flights', { updateInterval: -1 });
      const blocker = makeSlowLayer('traffic', { updateInterval: -1 });
      let releaseBlocker;
      let announceBlocker;
      const blockerStarted = new Promise((resolve) => { announceBlocker = resolve; });
      blocker.module.disable = async () => {
        announceBlocker();
        await new Promise((resolve) => { releaseBlocker = resolve; });
      };
      mgr.register(flights.module);
      mgr.register(blocker.module);
      await mgr.setEnabled('flights', true);
      await mgr.setEnabled('traffic', true);

      const clearing = mgr.clearSelectedLayers({ origin: 'user' });
      await blockerStarted;
      await mgr.setEnabled('flights', true, { origin });
      releaseBlocker();
      const result = await clearing;

      const flightsResult = result.items.find(({ id }) => id === 'flights');
      assert.equal(flightsResult.superseded, true);
      assert.equal(flightsResult.enabled, true);
      assert.deepEqual(result.notClearedIds, ['flights']);
      await mgr.destroyAll();
    });
  }
});

test('Clear All reserves its complete OFF baseline before sequential teardown', async () => {
  const mgr = new DataLayerManager({});
  const first = makeSlowLayer('flights', { updateInterval: -1 });
  const blocker = makeSlowLayer('traffic', { updateInterval: -1 });
  let releaseBlocker;
  let markBlockerStarted;
  const blockerStarted = new Promise((resolve) => { markBlockerStarted = resolve; });
  blocker.module.disable = async () => {
    markBlockerStarted();
    await new Promise((resolve) => { releaseBlocker = resolve; });
  };
  mgr.register(first.module);
  mgr.register(blocker.module);
  await mgr.setEnabled('flights', true);
  await mgr.setEnabled('traffic', true);

  const clearing = mgr.clearSelectedLayers({ origin: 'user' });
  await blockerStarted;
  assert.deepEqual(
    [...mgr.getEnabledLayerIds()],
    [],
    'all captured targets are effectively OFF before the first awaited teardown settles',
  );

  await mgr.setEnabled('flights', true, { origin: 'voice' });
  assert.deepEqual(
    [...mgr.getEnabledLayerIds()],
    ['flights'],
    'a later layer intent supersedes only its own Clear reservation',
  );
  releaseBlocker();
  const result = await clearing;
  assert.equal(result.items.find(({ id }) => id === 'flights')?.superseded, true);
  assert.equal(mgr.isEnabled('flights'), true);
  await mgr.destroyAll();
});

test('a current queued request aborted before its turn publishes one exact cancellation', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  let releaseToggle;
  let markToggleStarted;
  const toggleStarted = new Promise((resolve) => { markToggleStarted = resolve; });
  layer.module.enable = async () => {
    markToggleStarted();
    await new Promise((resolve) => { releaseToggle = resolve; });
  };
  mgr.register(layer.module);
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const occupyingTurn = mgr.toggle('rocket-launches', { origin: 'programmatic' });
  await toggleStarted;
  const controller = new AbortController();
  const queued = mgr._setEnabledWithIntent('rocket-launches', false, {
    origin: 'voice',
    signal: controller.signal,
  });
  controller.abort();
  releaseToggle();
  await occupyingTurn;
  assert.equal(await queued.promise, false);
  const outcome = await mgr._waitForVisibilityIntent('rocket-launches', queued.intentEpoch);
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.cancellationReason, 'caller-abort');
  assert.equal(outcome.phase, 'queued');
  const terminal = changes.filter(({ intentEpoch }) => intentEpoch === queued.intentEpoch);
  assert.deepEqual(terminal.map(({ type }) => type), ['visibility-cancelled']);
  await mgr.destroyAll();
});

test('visibility lifecycle events retain the exact absolute-intent epoch', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  const changes = [];
  mgr.register(layer.module);
  mgr.subscribe((change) => changes.push(change));

  const request = mgr._setEnabledWithIntent('rocket-launches', true, { origin: 'voice' });
  assert.equal(await request.promise, true);

  const ownedChanges = changes.filter(({ layerId }) => layerId === 'rocket-launches');
  assert.ok(ownedChanges.length >= 3);
  assert.ok(
    ownedChanges.every(({ intentEpoch }) => intentEpoch === request.intentEpoch),
    'pre-transition, lifecycle, and settled events remain correlated to one accepted intent',
  );
  await mgr.destroyAll();
});

test('programmatic ON during Clear All active OFF owns final visibility and reporting', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  let releaseDisable;
  let announceDisable;
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  layer.module.disable = async () => {
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };
  mgr.register(layer.module);
  await mgr.setEnabled('flights', true);

  const clearing = mgr.clearSelectedLayers({ origin: 'user' });
  await disableStarted;
  const newerEnable = mgr.setEnabled('flights', true, { origin: 'programmatic' });
  releaseDisable();
  const result = await clearing;
  await newerEnable;

  const item = result.items.find(({ id }) => id === 'flights');
  assert.equal(item.superseded, true);
  assert.equal(item.cleared, false);
  assert.equal(item.lifecycleState, 'enabling');
  assert.deepEqual(result.notClearedIds, ['flights']);
  assert.deepEqual(mgr.getLayerLifecycleState('flights'), {
    enabled: true,
    lifecycleState: 'enabled',
    uncertain: false,
  });
  // The test-owned slow disable is intentionally left installed; a destroy
  // would start a second unrelated gated disable and obscure this race.
});

test('manager exposes enabling and disabling without changing settled visibility early', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('radio', { updateInterval: -1 });
  let releaseInit;
  let announceInit;
  let releaseDisable;
  let announceDisable;
  const initStarted = new Promise((resolve) => { announceInit = resolve; });
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  layer.module.init = async () => {
    announceInit();
    await new Promise((resolve) => { releaseInit = resolve; });
  };
  layer.module.disable = async () => {
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };
  mgr.register(layer.module);
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const enabling = mgr.setEnabled('radio', true, { origin: 'user' });
  await initStarted;
  assert.deepEqual(mgr.getLayerLifecycleState('radio'), {
    enabled: false,
    lifecycleState: 'enabling',
    uncertain: false,
  });
  assert.equal(mgr.getAll()[0].lifecycleState, 'enabling');
  assert.equal(changes.at(-1)?.type, 'visibility-transition');
  assert.equal(changes.at(-1)?.settledEnabled, false);
  assert.deepEqual(layer.calls.presentation.at(-1), {
    lifecycleState: 'enabling', enabled: false, uncertain: false,
  });
  releaseInit();
  assert.equal(await enabling, true);
  assert.deepEqual(mgr.getLayerLifecycleState('radio'), {
    enabled: true,
    lifecycleState: 'enabled',
    uncertain: false,
  });
  assert.deepEqual(layer.calls.presentation.at(-1), {
    lifecycleState: 'enabled', enabled: true, uncertain: false,
  });

  const disabling = mgr.setEnabled('radio', false, { origin: 'user' });
  await disableStarted;
  assert.deepEqual(mgr.getLayerLifecycleState('radio'), {
    enabled: true,
    lifecycleState: 'disabling',
    uncertain: false,
  });
  assert.equal(changes.at(-1)?.type, 'visibility-transition');
  assert.equal(changes.at(-1)?.settledEnabled, true);
  assert.deepEqual(layer.calls.presentation.at(-1), {
    lifecycleState: 'disabling', enabled: true, uncertain: false,
  });
  releaseDisable();
  assert.equal(await disabling, true);
  assert.deepEqual(mgr.getLayerLifecycleState('radio'), {
    enabled: false,
    lifecycleState: 'disabled',
    uncertain: false,
  });
  assert.deepEqual(layer.calls.presentation.at(-1), {
    lifecycleState: 'disabled', enabled: false, uncertain: false,
  });
  assert.deepEqual(
    changes.filter(({ type }) => type === 'visibility').map(({ enabled }) => enabled),
    [true, false],
  );
});

test('double-toggle during the awaited enable leaves the layer OFF with no leaked interval', async () => {
  const mgr = new DataLayerManager(/* viewer */ {});
  const layer = makeSlowLayer('flights');
  mgr.register(layer.module);

  // Fire two toggles back-to-back WITHOUT awaiting the first — the classic
  // voice+click / double-click race.
  const p1 = mgr.toggle('flights'); // enable
  const p2 = mgr.toggle('flights'); // should be treated as the disable
  await Promise.all([p1, p2]);

  // Net effect of enable-then-disable: layer is OFF...
  assert.equal(mgr.isEnabled('flights'), false, 'layer should end disabled');
  // ...and NO interval is left running (the leak this fix prevents).
  const entry = mgr.layers.get('flights');
  assert.equal(entry.intervalId, null, 'no polling interval should be armed');
});

test('serialized toggles never arm two intervals (2× poll → 429 guard)', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('military');
  mgr.register(layer.module);

  // enable, disable, enable — rapid-fire, unawaited.
  const ps = [mgr.toggle('military'), mgr.toggle('military'), mgr.toggle('military')];
  await Promise.all(ps);

  assert.equal(mgr.isEnabled('military'), true, 'odd number of toggles ends enabled');
  const entry = mgr.layers.get('military');
  assert.notEqual(entry.intervalId, null, 'exactly one interval should be armed');
  // enable ran twice, disable once — and only one interval survives.
  assert.ok(layer.calls.enable >= 1, 'enable was called');
  clearInterval(entry.intervalId); // don't leak the timer out of the test
});

test('setEnabled is idempotent and serializes with toggle', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('satellites', { updateInterval: 0 });
  mgr.register(layer.module);

  await mgr.setEnabled('satellites', true);
  assert.equal(mgr.isEnabled('satellites'), true);
  await mgr.setEnabled('satellites', true); // no-op, already enabled
  assert.equal(layer.calls.enable, 1, 'no redundant enable');

  await mgr.setEnabled('satellites', false);
  assert.equal(mgr.isEnabled('satellites'), false);
  const entry = mgr.layers.get('satellites');
  assert.equal(entry.intervalId, null, 'stats interval cleared on disable');
});

test('idempotent absolute intent publishes its newer origin without rerunning lifecycle', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  const changes = [];
  mgr.register(layer.module);
  mgr.subscribe((change) => changes.push(change));
  await mgr.setEnabled('rocket-launches', true, { origin: 'programmatic' });
  changes.length = 0;

  assert.equal(await mgr.setEnabled('rocket-launches', true, { origin: 'voice' }), true);
  assert.equal(layer.calls.enable, 1, 'the module is not redundantly enabled');
  assert.deepEqual(changes, [{
    type: 'visibility',
    layerId: 'rocket-launches',
    enabled: true,
    origin: 'voice',
    intentEpoch: 2,
  }]);
  await mgr.destroyAll();
});

test('an aborted enable is transactionally cancelled without a settled visibility intent', async () => {
  const mgr = new DataLayerManager({});
  const changes = [];
  let releaseUpdate;
  let announceUpdate;
  let updateShouldWait = true;
  let cleanupFails = true;
  let moduleActive = false;
  const updateStarted = new Promise((resolve) => { announceUpdate = resolve; });
  const layer = makeSlowLayer('radio', { updateInterval: 0 });
  layer.module.enable = () => {
    layer.calls.enable++;
    moduleActive = true;
  };
  layer.module.update = async () => {
    layer.calls.update++;
    if (!updateShouldWait) return;
    updateShouldWait = false;
    announceUpdate();
    await new Promise((resolve) => { releaseUpdate = resolve; });
  };
  // Cleanup failure means the partially enabled module cannot be proven OFF;
  // retain the conservative ON state without emitting settled visibility.
  layer.module.disable = () => {
    layer.calls.disable++;
    moduleActive = false;
    if (cleanupFails) throw new Error('cleanup fixture');
  };
  mgr.register(layer.module);
  mgr.subscribe((change) => changes.push(change));
  const controller = new AbortController();

  const enabling = mgr.setEnabled('radio', true, {
    origin: 'voice',
    signal: controller.signal,
  });
  await updateStarted;
  controller.abort();
  releaseUpdate();
  const changed = await enabling;

  assert.equal(changed, false);
  assert.equal(mgr.isEnabled('radio'), true);
  assert.equal(moduleActive, false, 'module cleanup completed before reporting failure');
  assert.equal(mgr.layers.get('radio').lifecycleUncertain, true);
  assert.equal(mgr.layers.get('radio').intervalId, null);
  assert.equal(changes.some(({ type }) => type === 'visibility'), false);
  assert.equal(changes.at(-1)?.type, 'visibility-failed');
  assert.equal(changes.at(-1)?.phase, 'cancel-enable-cleanup');

  cleanupFails = false;
  const visibilityBeforeRetry = changes.filter(({ type }) => type === 'visibility').length;
  assert.equal(await mgr.setEnabled('radio', true), true);
  assert.equal(moduleActive, true, 'same-state retry performs real enable work');
  assert.equal(mgr.isEnabled('radio'), true);
  assert.equal(mgr.layers.get('radio').lifecycleUncertain, false);
  assert.notEqual(mgr.layers.get('radio').intervalId, null);
  assert.equal(
    changes.filter(({ type }) => type === 'visibility').length,
    visibilityBeforeRetry + 1,
    'only the reconciled retry emits settled visibility',
  );
  clearInterval(mgr.layers.get('radio').intervalId);
});

test('failed enable cleanup leaves reconciliation debt instead of skipping a same-state retry', async (t) => {
  for (const phase of ['init', 'enable', 'update']) {
    for (const cleanupFailure of ['throw', 'false']) {
      await t.test(`${phase} / cleanup ${cleanupFailure}`, async () => {
        const mgr = new DataLayerManager({});
        const changes = [];
        let failPhase = true;
        let failCleanup = true;
        let moduleActive = false;
        const layer = makeSlowLayer(`reconcile-${phase}-${cleanupFailure}`, { updateInterval: 1000 });
        layer.module.init = async () => {
          layer.calls.init++;
          if (failPhase && phase === 'init') throw new Error('init fixture');
        };
        layer.module.enable = async () => {
          layer.calls.enable++;
          moduleActive = true;
          if (failPhase && phase === 'enable') throw new Error('enable fixture');
        };
        layer.module.update = async () => {
          layer.calls.update++;
          if (failPhase && phase === 'update') throw new Error('update fixture');
        };
        layer.module.disable = async () => {
          layer.calls.disable++;
          moduleActive = false;
          if (!failCleanup) return;
          if (cleanupFailure === 'false') return false;
          throw new Error('cleanup fixture');
        };
        mgr.register(layer.module);
        mgr.subscribe((change) => changes.push(change));

        assert.equal(await mgr.setEnabled(layer.module.id, true), false);
        assert.equal(moduleActive, false, 'cleanup made the module inactive');
        assert.equal(mgr.isEnabled(layer.module.id), true, 'manager remains conservatively ON');
        assert.equal(mgr.layers.get(layer.module.id).lifecycleUncertain, true);
        assert.equal(mgr.layers.get(layer.module.id).intervalId, null);
        assert.equal(changes.some(({ type }) => type === 'visibility'), false);
        assert.equal(changes.at(-1)?.type, 'visibility-failed');
        assert.equal(changes.at(-1)?.phase, phase);

        failPhase = false;
        failCleanup = false;
        const enablesBeforeRetry = layer.calls.enable;
        assert.equal(await mgr.setEnabled(layer.module.id, true), true);
        assert.equal(layer.calls.enable, enablesBeforeRetry + 1, 'retry does not take the same-state no-op');
        assert.equal(moduleActive, true);
        assert.equal(mgr.isEnabled(layer.module.id), true);
        assert.equal(mgr.layers.get(layer.module.id).lifecycleUncertain, false);
        assert.notEqual(mgr.layers.get(layer.module.id).intervalId, null);
        assert.equal(changes.filter(({ type }) => type === 'visibility').length, 1);
        clearInterval(mgr.layers.get(layer.module.id).intervalId);
      });
    }
  }
});

test('failed disable is uncertain and same-state enable reconciles module authority', async () => {
  const mgr = new DataLayerManager({});
  const changes = [];
  let rejectDisable = false;
  let moduleActive = false;
  const layer = makeSlowLayer('disable-reconcile', { updateInterval: 1000 });
  layer.module.enable = async () => {
    layer.calls.enable++;
    moduleActive = true;
  };
  layer.module.disable = async () => {
    layer.calls.disable++;
    moduleActive = false;
    if (rejectDisable) throw new Error('disable fixture');
  };
  mgr.register(layer.module);
  await mgr.setEnabled(layer.module.id, true);
  mgr.subscribe((change) => changes.push(change));

  rejectDisable = true;
  assert.equal(await mgr.setEnabled(layer.module.id, false), false);
  assert.equal(moduleActive, false);
  assert.equal(mgr.isEnabled(layer.module.id), true);
  assert.equal(mgr.layers.get(layer.module.id).lifecycleUncertain, true);
  assert.equal(changes.some(({ type }) => type === 'visibility'), false);

  rejectDisable = false;
  const enablesBeforeRetry = layer.calls.enable;
  assert.equal(await mgr.setEnabled(layer.module.id, true), true);
  assert.equal(layer.calls.enable, enablesBeforeRetry + 1);
  assert.equal(moduleActive, true);
  assert.equal(mgr.layers.get(layer.module.id).lifecycleUncertain, false);
  assert.equal(changes.filter(({ type }) => type === 'visibility').length, 1);
  clearInterval(mgr.layers.get(layer.module.id).intervalId);
});

test('abort rejections from init and enable are cancellations, not lifecycle failures', async (t) => {
  for (const phase of ['init', 'enable']) {
    await t.test(phase, async () => {
      const mgr = new DataLayerManager({});
      const changes = [];
      let announcePhase;
      const phaseStarted = new Promise((resolve) => { announcePhase = resolve; });
      const layer = makeSlowLayer(`radio-${phase}`, { updateInterval: -1 });
      const rejectOnAbort = (_viewer, { signal } = {}) => new Promise((_resolve, reject) => {
        announcePhase();
        signal.addEventListener('abort', () => {
          const error = new Error(`${phase} aborted`);
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      if (phase === 'init') layer.module.init = rejectOnAbort;
      else layer.module.enable = rejectOnAbort;
      mgr.register(layer.module);
      mgr.subscribe((change) => changes.push(change));
      const controller = new AbortController();

      const enabling = mgr.setEnabled(layer.module.id, true, {
        origin: 'voice',
        signal: controller.signal,
      });
      await phaseStarted;
      controller.abort();
      const changed = await enabling;

      assert.equal(changed, false);
      assert.equal(mgr.isEnabled(layer.module.id), false);
      assert.equal(changes.some(({ type }) => type === 'visibility-failed'), false);
      assert.equal(changes.some(({ type }) => type === 'visibility'), false);
      assert.equal(changes.at(-1)?.type, 'visibility-cancelled');
      assert.equal(changes.at(-1)?.intentEpoch, 1);
      assert.equal(changes.at(-1)?.cancellationReason, 'caller-abort');
    });
  }
});

test('failed cancelled-disable compensation preserves manager/module coherence and permits retry', async () => {
  const mgr = new DataLayerManager({});
  const changes = [];
  let releaseDisable;
  let announceDisable;
  let failEnable = false;
  let disableAttempts = 0;
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  const layer = makeSlowLayer('radio', { updateInterval: -1 });
  layer.module.enable = () => {
    layer.calls.enable++;
    if (failEnable) throw new Error('cleanup enable fixture');
  };
  layer.module.disable = async () => {
    layer.calls.disable++;
    disableAttempts++;
    if (disableAttempts > 1) return;
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };
  mgr.register(layer.module);
  await mgr.setEnabled('radio', true);
  failEnable = true;
  mgr.subscribe((change) => changes.push(change));
  const controller = new AbortController();

  const disabling = mgr.setEnabled('radio', false, {
    origin: 'voice',
    signal: controller.signal,
  });
  await disableStarted;
  controller.abort();
  releaseDisable();
  const changed = await disabling;

  assert.equal(changed, false);
  assert.equal(mgr.isEnabled('radio'), false);
  assert.equal(changes.some(({ type }) => type === 'visibility'), false);
  assert.equal(changes.at(-1)?.type, 'visibility-failed');
  assert.equal(changes.at(-1)?.phase, 'cancel-disable-compensation');

  failEnable = false;
  assert.equal(await mgr.setEnabled('radio', true), true);
  assert.equal(mgr.isEnabled('radio'), true, 'same-state retry performs real lifecycle work');
});

test('cancelled Space Missions entry exposes the owning manager intent epoch', async () => {
  const mgr = new DataLayerManager({});
  const changes = [];
  let releaseEnable;
  let announceEnable;
  const enableStarted = new Promise((resolve) => { announceEnable = resolve; });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  missions.module.enable = async () => {
    announceEnable();
    await new Promise((resolve) => { releaseEnable = resolve; });
  };
  mgr.register(missions.module);
  mgr.subscribe((change) => changes.push(change));
  const controller = new AbortController();

  const enabling = mgr.setEnabled('rocket-launches', true, {
    origin: 'user',
    signal: controller.signal,
  });
  await enableStarted;
  controller.abort();
  releaseEnable();
  assert.equal(await enabling, false);

  const cancelled = changes.find(({ type }) => type === 'visibility-cancelled');
  assert.equal(cancelled?.layerId, 'rocket-launches');
  assert.equal(cancelled?.enabled, true);
  assert.equal(cancelled?.intentEpoch, 1);
});

test('lifecycle methods returning false reject their transaction without settled visibility', async (t) => {
  for (const phase of ['init', 'enable', 'update', 'disable']) {
    await t.test(phase, async () => {
      const mgr = new DataLayerManager({});
      const changes = [];
      const layer = makeSlowLayer(`semantic-${phase}`, { updateInterval: -1 });
      layer.module[phase] = async () => false;
      mgr.register(layer.module);
      if (phase === 'disable') {
        layer.module.disable = async () => undefined;
        await mgr.setEnabled(layer.module.id, true);
        layer.module.disable = async () => false;
      }
      mgr.subscribe((change) => changes.push(change));

      const changed = await mgr.setEnabled(layer.module.id, phase !== 'disable');

      assert.equal(changed, false);
      assert.equal(mgr.isEnabled(layer.module.id), phase === 'disable');
      assert.equal(changes.some(({ type }) => type === 'visibility'), false);
      assert.equal(changes.at(-1)?.type, 'visibility-failed');
      assert.equal(changes.at(-1)?.phase, phase);
      assert.equal(
        mgr.getLayerLifecycleState(layer.module.id).lifecycleState,
        phase === 'disable' ? 'enabled' : 'disabled',
      );
    });
  }
});

test('module-local AbortError is a cancellation while the caller signal remains live', async (t) => {
  for (const phase of ['init', 'enable', 'update', 'disable']) {
    await t.test(phase, async () => {
      const mgr = new DataLayerManager({});
      const changes = [];
      const layer = makeSlowLayer(`resource-abort-${phase}`, { updateInterval: -1 });
      const abortLocally = async () => {
        const error = new Error(`${phase} resource cancelled`);
        error.name = 'AbortError';
        throw error;
      };
      if (phase === 'disable') {
        mgr.register(layer.module);
        await mgr.setEnabled(layer.module.id, true);
        layer.module.disable = abortLocally;
      } else {
        layer.module[phase] = abortLocally;
        mgr.register(layer.module);
      }
      mgr.subscribe((change) => changes.push(change));

      const changed = await mgr.setEnabled(layer.module.id, phase !== 'disable');

      assert.equal(changed, false);
      assert.equal(mgr.isEnabled(layer.module.id), phase === 'disable');
      assert.equal(changes.some(({ type }) => type === 'visibility-failed'), false);
      assert.equal(changes.some(({ type }) => type === 'visibility'), false);
      assert.equal(changes.at(-1)?.type, 'visibility-cancelled');
      assert.equal(changes.at(-1)?.cancellationReason, 'resource-abort');
      assert.equal(changes.at(-1)?.phase, phase);
      assert.equal(
        mgr.getLayerLifecycleState(layer.module.id).lifecycleState,
        phase === 'disable' ? 'enabled' : 'disabled',
      );
    });
  }
});

test('a settled resource cancellation cannot disable a later successful retry', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('resource-abort-retry', { updateInterval: -1 });
  const caller = new AbortController();
  layer.module.enable = async () => {
    const error = new Error('resource request cancelled');
    error.name = 'AbortError';
    throw error;
  };
  mgr.register(layer.module);

  assert.equal(await mgr.setEnabled(layer.module.id, true, { signal: caller.signal }), false);
  assert.equal(caller.signal.aborted, false);
  assert.equal(mgr.isEnabled(layer.module.id), false);

  layer.module.enable = async () => undefined;
  assert.equal(await mgr.setEnabled(layer.module.id, true), true);
  assert.equal(mgr.isEnabled(layer.module.id), true);
  const disablesAfterRetry = layer.calls.disable;

  caller.abort();
  await Promise.resolve();

  assert.equal(mgr.isEnabled(layer.module.id), true);
  assert.equal(layer.calls.disable, disablesAfterRetry);
});

test('simultaneous absolute enable requests stay idempotent inside the toggle queue', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('vessels', { updateInterval: 0 });
  mgr.register(layer.module);

  await Promise.all([
    mgr.setEnabled('vessels', true),
    mgr.setEnabled('vessels', true),
    mgr.setEnabled('vessels', true),
  ]);

  assert.equal(mgr.isEnabled('vessels'), true, 'repeated absolute enables end enabled');
  assert.equal(layer.calls.enable, 1, 'the queued desired-state check prevents a second enable');
  assert.equal(layer.calls.disable, 0, 'an absolute enable never turns the layer off');

  await Promise.all([
    mgr.setEnabled('vessels', false),
    mgr.setEnabled('vessels', false),
  ]);
  assert.equal(mgr.isEnabled('vessels'), false, 'repeated absolute disables end disabled');
  assert.equal(layer.calls.disable, 1, 'the queued desired-state check prevents a second disable');
});

test('enabled-layer snapshots restore the exact set through normal visibility events', async () => {
  const mgr = new DataLayerManager({});
  const layers = ['flights', 'satellites', 'earthquakes'].map((id) => makeSlowLayer(id, { updateInterval: 0 }));
  const changes = [];
  for (const layer of layers) mgr.register(layer.module);
  mgr.subscribe((change) => changes.push(change));

  await Promise.all([
    mgr.setEnabled('flights', true),
    mgr.setEnabled('earthquakes', true),
  ]);
  const snapshot = mgr.getEnabledLayerIds();
  assert.deepEqual([...snapshot], ['flights', 'earthquakes']);

  snapshot.add('unknown-layer');
  await Promise.all([
    mgr.setEnabled('flights', false),
    mgr.setEnabled('satellites', true),
  ]);
  const restoreStart = changes.length;
  await mgr.restoreEnabledLayerIds(snapshot, { origin: 'context-restore' });

  assert.deepEqual([...mgr.getEnabledLayerIds()], ['flights', 'earthquakes']);
  assert.deepEqual(
    changes.slice(restoreStart)
      .filter(({ type }) => type === 'visibility')
      .map(({ layerId, enabled, origin }) => ({ layerId, enabled, origin }))
      .sort((a, b) => a.layerId.localeCompare(b.layerId)),
    [
      { layerId: 'earthquakes', enabled: true, origin: 'context-restore' },
      { layerId: 'flights', enabled: true, origin: 'context-restore' },
      { layerId: 'satellites', enabled: false, origin: 'context-restore' },
    ],
    'every accepted registered absolute restore intent emits through the normal manager path',
  );

  await mgr.destroyAll();
});

test('restore waits for every queued layer transition before rethrowing a failure', async () => {
  const mgr = new DataLayerManager({});
  const failing = makeSlowLayer('failing', { updateInterval: 0 });
  const radio = makeSlowLayer('radio', { updateInterval: 0 });
  let releaseRadioDisable;
  const radioDisableGate = new Promise((resolve) => { releaseRadioDisable = resolve; });
  radio.module.disable = async () => radioDisableGate;
  failing.module.enable = async () => {
    throw new Error('real lifecycle enable failure');
  };
  mgr.register(failing.module);
  mgr.register(radio.module);
  await mgr.setEnabled('radio', true);

  let settled = false;
  const restoring = mgr.restoreEnabledLayerIds(new Set(['failing']), { origin: 'context-restore' })
    .finally(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, 'a sibling semantic failure must not release the restore barrier early');

  releaseRadioDisable();
  await assert.rejects(restoring, (error) => {
    assert.match(error.message, /Failed to restore layer "failing" visibility/);
    assert.deepEqual(error.failedLayerIds, ['failing']);
    return true;
  });
  assert.equal(settled, true);
  assert.equal(mgr.isEnabled('failing'), false, 'fulfilled false remains an honest failed state');
  assert.equal(mgr.isEnabled('radio'), false);
  await mgr.destroyAll();
});

test('restore forwards caller cancellation to every visibility intent', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: 0 });
  const controller = new AbortController();
  const receivedSignals = [];
  const originalSetEnabledWithIntent = mgr._setEnabledWithIntent.bind(mgr);
  mgr._setEnabledWithIntent = (layerId, enabled, options) => {
    receivedSignals.push(options?.signal || null);
    return originalSetEnabledWithIntent(layerId, enabled, options);
  };
  mgr.register(layer.module);

  controller.abort();
  await assert.rejects(
    mgr.restoreEnabledLayerIds(new Set(['flights']), {
      origin: 'context-restore',
      signal: controller.signal,
    }),
    /Failed to restore layer "flights" visibility/,
  );
  assert.deepEqual(receivedSignals, [controller.signal]);
  assert.equal(mgr.isEnabled('flights'), false);
  await mgr.destroyAll();
});

test('a partial caller-aborted restore can be compensated to its exact target', async () => {
  const mgr = new DataLayerManager({});
  const flights = makeSlowLayer('flights', { updateInterval: 0 });
  const military = makeSlowLayer('military', { updateInterval: 0 });
  const radio = makeSlowLayer('radio', { updateInterval: 0 });
  mgr.register(flights.module);
  mgr.register(military.module);
  mgr.register(radio.module);
  await mgr.setEnabled('flights', true);
  await mgr.setEnabled('military', true);

  const controller = new AbortController();
  const originalDisable = flights.module.disable;
  flights.module.disable = async (...args) => {
    const result = await originalDisable(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(
    mgr.restoreEnabledLayerIds(new Set(['radio']), {
      origin: 'context-restore',
      signal: controller.signal,
    }),
    /Failed to restore layer/,
  );

  await mgr.restoreEnabledLayerIds(new Set(['radio']), { origin: 'context-restore' });
  assert.deepEqual(new Set(mgr.getEnabledLayerIds()), new Set(['radio']));
  await mgr.destroyAll();
});

test('restore follows superseding intents and requires their authoritative settled target', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('satellites', { updateInterval: 0 });
  mgr.register(layer.module);
  await mgr.setEnabled('satellites', true);

  const originalSetEnabledWithIntent = mgr._setEnabledWithIntent.bind(mgr);
  let injected = false;
  mgr._setEnabledWithIntent = (layerId, enabled, options) => {
    const handle = originalSetEnabledWithIntent(layerId, enabled, options);
    if (!injected && options?.origin === 'context-restore') {
      injected = true;
      originalSetEnabledWithIntent(layerId, false, { origin: 'voice' });
    }
    return handle;
  };
  await assert.rejects(
    mgr.restoreEnabledLayerIds(new Set(['satellites']), { origin: 'context-restore' }),
    /Failed to restore layer "satellites" visibility/,
  );
  assert.equal(mgr.isEnabled('satellites'), false);

  injected = false;
  mgr._setEnabledWithIntent = (layerId, enabled, options) => {
    const handle = originalSetEnabledWithIntent(layerId, enabled, options);
    if (!injected && options?.origin === 'context-restore') {
      injected = true;
      originalSetEnabledWithIntent(layerId, true, { origin: 'voice' });
    }
    return handle;
  };
  await mgr.restoreEnabledLayerIds(new Set(['satellites']), { origin: 'context-restore' });
  assert.equal(mgr.isEnabled('satellites'), true);
  await mgr.destroyAll();
});

test('visibility notifications distinguish user toggles from dependencies', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('earthquakes', { updateInterval: 0 });
  const changes = [];
  mgr.register(layer.module);
  mgr.subscribe((change) => changes.push(change));

  await mgr.toggle('earthquakes', { origin: 'user' });
  await mgr.setEnabled('earthquakes', false);

  const settled = changes.filter(({ type }) => type === 'visibility');
  assert.equal(settled[0].origin, 'user');
  assert.equal(settled[1].origin, 'programmatic');
});

test('newer absolute OFF supersedes a slow ON before settled publication', async () => {
  const mgr = new DataLayerManager({});
  let releaseUpdate;
  let markUpdateStarted;
  let moduleActive = false;
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
  const radio = makeSlowLayer('radio', { updateInterval: 0 });
  radio.module.enable = () => {
    radio.calls.enable++;
    moduleActive = true;
  };
  radio.module.update = async () => {
    radio.calls.update++;
    markUpdateStarted();
    await updateGate;
  };
  radio.module.disable = () => {
    radio.calls.disable++;
    moduleActive = false;
  };
  mgr.register(radio.module);
  const requests = [];
  const changes = [];
  const latestToken = Symbol('latest-off');
  mgr.subscribeVisibilityRequests((change) => requests.push(change));
  mgr.subscribe((change) => changes.push(change));

  const enabling = mgr.setEnabled('radio', true, { origin: 'voice' });
  await updateStarted;
  const disabling = mgr.setEnabled('radio', false, {
    origin: 'user',
    notificationToken: latestToken,
  });
  assert.deepEqual(requests.map(({ enabled, origin }) => ({ enabled, origin })), [
    { enabled: true, origin: 'voice' },
    { enabled: false, origin: 'user' },
  ]);

  releaseUpdate();
  assert.deepEqual(await Promise.all([enabling, disabling]), [false, true]);
  assert.equal(mgr.isEnabled('radio'), false);
  assert.equal(moduleActive, false);
  assert.equal(mgr.layers.get('radio').intervalId, null);
  assert.deepEqual(
    changes.filter(({ type }) => type === 'visibility')
      .map(({ enabled, origin, notificationToken }) => ({ enabled, origin, notificationToken })),
    [{ enabled: false, origin: 'user', notificationToken: latestToken }],
    'only the latest absolute request may publish settled visibility',
  );
  assert.equal(
    radio.calls.presentation.some(({ lifecycleState, enabled, uncertain }) => (
      lifecycleState === 'enabled' && enabled && !uncertain
    )),
    false,
    'the superseded ON never exposes certain settled presentation',
  );
  await mgr.destroyAll();
});

test('newer OFF cancels init and enable phases without obsolete settlement', async (t) => {
  for (const phase of ['init', 'enable']) {
    await t.test(phase, async () => {
      const mgr = new DataLayerManager({});
      let releasePhase;
      let markPhaseStarted;
      const phaseGate = new Promise((resolve) => { releasePhase = resolve; });
      const phaseStarted = new Promise((resolve) => { markPhaseStarted = resolve; });
      const radio = makeSlowLayer(`radio-${phase}`, { updateInterval: -1 });
      radio.module[phase] = async () => {
        radio.calls[phase]++;
        markPhaseStarted();
        await phaseGate;
      };
      mgr.register(radio.module);
      const changes = [];
      mgr.subscribe((change) => changes.push(change));

      const enabling = mgr.setEnabled(radio.module.id, true, { origin: 'voice' });
      await phaseStarted;
      const disabling = mgr.setEnabled(radio.module.id, false, { origin: 'user' });
      releasePhase();

      assert.deepEqual(await Promise.all([enabling, disabling]), [false, true]);
      assert.deepEqual(
        changes.filter(({ type }) => type === 'visibility')
          .map(({ enabled, origin }) => ({ enabled, origin })),
        [{ enabled: false, origin: 'user' }],
      );
      assert.equal(mgr.isEnabled(radio.module.id), false);
      assert.equal(
        radio.calls.presentation.some(({ lifecycleState, enabled, uncertain }) => (
          lifecycleState === 'enabled' && enabled && !uncertain
        )),
        false,
      );
      await mgr.destroyAll();
    });
  }
});

test('supersession during a visibility guard cancels the stale request before block publication', async () => {
  const mgr = new DataLayerManager({});
  let releaseGuard;
  let markGuardStarted;
  const guardGate = new Promise((resolve) => { releaseGuard = resolve; });
  const guardStarted = new Promise((resolve) => { markGuardStarted = resolve; });
  const radio = makeSlowLayer('radio', { updateInterval: -1 });
  mgr.register(radio.module);
  mgr.addVisibilityGuard(async (change) => {
    if (change.layerId !== 'radio' || !change.enabled) return null;
    markGuardStarted();
    await guardGate;
    return 'stale guard result';
  });
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const enabling = mgr.setEnabled('radio', true, { origin: 'voice' });
  await guardStarted;
  const disabling = mgr.setEnabled('radio', false, { origin: 'user' });
  releaseGuard();

  assert.deepEqual(await Promise.all([enabling, disabling]), [false, true]);
  assert.equal(changes.some(({ type }) => type === 'visibility-blocked'), false);
  assert.deepEqual(
    changes.filter(({ type }) => ['visibility-cancelled', 'visibility'].includes(type))
      .map(({ type, enabled, origin }) => ({ type, enabled, origin })),
    [
      { type: 'visibility-cancelled', enabled: true, origin: 'voice' },
      { type: 'visibility', enabled: false, origin: 'user' },
    ],
  );
  assert.equal(mgr.isEnabled('radio'), false);
  await mgr.destroyAll();
});

test('newer same-target absolute intent owns the only settled publication', async () => {
  const mgr = new DataLayerManager({});
  let releaseUpdate;
  let markUpdateStarted;
  let firstUpdate = true;
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
  const radio = makeSlowLayer('radio', { updateInterval: -1 });
  radio.module.update = async () => {
    radio.calls.update++;
    if (!firstUpdate) return;
    firstUpdate = false;
    markUpdateStarted();
    await updateGate;
  };
  mgr.register(radio.module);
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const voiceEnable = mgr.setEnabled('radio', true, { origin: 'voice' });
  await updateStarted;
  const userEnable = mgr.setEnabled('radio', true, { origin: 'user' });
  releaseUpdate();

  assert.deepEqual(await Promise.all([voiceEnable, userEnable]), [false, true]);
  assert.deepEqual(
    changes.filter(({ type }) => type === 'visibility')
      .map(({ enabled, origin }) => ({ enabled, origin })),
    [{ enabled: true, origin: 'user' }],
  );
  assert.equal(mgr.isEnabled('radio'), true);
  await mgr.destroyAll();
});

test('cancelled visibility publishes an atomic successor handoff and exact intent outcomes', async () => {
  const mgr = new DataLayerManager({});
  let releaseUpdate;
  let markUpdateStarted;
  let firstUpdate = true;
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  missions.module.update = async () => {
    missions.calls.update++;
    if (!firstUpdate) return;
    firstUpdate = false;
    markUpdateStarted();
    await updateGate;
  };
  mgr.register(missions.module);
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const first = mgr._setEnabledWithIntent('rocket-launches', true, { origin: 'user' });
  await updateStarted;
  const successor = mgr._setEnabledWithIntent('rocket-launches', true, { origin: 'programmatic' });
  releaseUpdate();

  assert.equal(await first.promise, false);
  assert.equal(await successor.promise, true);
  const cancelled = changes.find(({ type, intentEpoch }) => (
    type === 'visibility-cancelled' && intentEpoch === first.intentEpoch
  ));
  assert.deepEqual({
    reason: cancelled?.cancellationReason,
    phase: cancelled?.phase,
    successorIntentEpoch: cancelled?.successorIntentEpoch,
    successorEnabled: cancelled?.successorEnabled,
    successorOrigin: cancelled?.successorOrigin,
  }, {
    reason: 'superseded',
    phase: 'update',
    successorIntentEpoch: successor.intentEpoch,
    successorEnabled: true,
    successorOrigin: 'programmatic',
  });
  assert.equal((await mgr._waitForVisibilityIntent('rocket-launches', successor.intentEpoch))?.succeeded, true);
  assert.deepEqual(
    changes.filter(({ type }) => type === 'visibility').map(({ enabled, origin }) => ({ enabled, origin })),
    [{ enabled: true, origin: 'programmatic' }],
  );
  await mgr.destroyAll();
});

test('same-target uncertain retry retains authoritative visibility until abort cleanup settles', async () => {
  const mgr = new DataLayerManager({});
  const radio = makeSlowLayer('radio', { updateInterval: -1 });
  let enableAttempt = 0;
  let markRetryStarted;
  let releaseCleanup;
  const retryStarted = new Promise((resolve) => { markRetryStarted = resolve; });
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  radio.module.enable = (_viewer, { signal } = {}) => {
    radio.calls.enable++;
    enableAttempt += 1;
    if (enableAttempt !== 2) return Promise.resolve();
    markRetryStarted();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('superseded retry');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  radio.module.disable = async () => {
    radio.calls.disable++;
    await cleanupGate;
  };
  mgr.register(radio.module);
  assert.equal(await mgr.setEnabled('radio', true), true);
  const entry = mgr.layers.get('radio');
  entry.lifecycleUncertain = true;

  const firstRetry = mgr.setEnabled('radio', true, { origin: 'voice' });
  await retryStarted;
  const latestRetry = mgr.setEnabled('radio', true, { origin: 'user' });
  assert.equal(
    mgr.isEnabled('radio'),
    true,
    'supersession does not rewrite the last authoritative boolean before cleanup',
  );

  releaseCleanup();
  assert.deepEqual(await Promise.all([firstRetry, latestRetry]), [false, true]);
  assert.equal(mgr.isEnabled('radio'), true);
  assert.equal(entry.lifecycleUncertain, false);
  await mgr.destroyAll();
});

test('re-entrant absolute request during lifecycle presentation owns settlement and publication', async () => {
  const mgr = new DataLayerManager({});
  const radio = makeSlowLayer('radio', { updateInterval: 1000 });
  let moduleActive = false;
  let reentrantDisable = null;
  let triggered = false;
  radio.module.enable = () => {
    radio.calls.enable++;
    moduleActive = true;
  };
  radio.module.disable = () => {
    radio.calls.disable++;
    moduleActive = false;
  };
  radio.module.setLifecyclePresentation = (state) => {
    radio.calls.presentation.push({ ...state });
    if (!triggered && state.lifecycleState === 'enabled' && state.enabled && !state.uncertain) {
      triggered = true;
      reentrantDisable = mgr.setEnabled('radio', false, { origin: 'user' });
    }
  };
  mgr.register(radio.module);
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const staleEnable = mgr.setEnabled('radio', true, { origin: 'voice' });
  assert.equal(await staleEnable, false);
  assert.ok(reentrantDisable);
  assert.equal(await reentrantDisable, true);
  assert.equal(moduleActive, false);
  assert.equal(mgr.isEnabled('radio'), false);
  assert.equal(mgr.layers.get('radio').intervalId, null);
  assert.deepEqual(
    changes.filter(({ type }) => type === 'visibility')
      .map(({ enabled, origin }) => ({ enabled, origin })),
    [{ enabled: false, origin: 'user' }],
  );
  await mgr.destroyAll();
});

test('newer absolute ON supersedes a slow OFF without publishing stale OFF', async () => {
  const mgr = new DataLayerManager({});
  let releaseDisable;
  let markDisableStarted;
  let firstDisable = true;
  const disableGate = new Promise((resolve) => { releaseDisable = resolve; });
  const disableStarted = new Promise((resolve) => { markDisableStarted = resolve; });
  const radio = makeSlowLayer('radio', { updateInterval: -1 });
  radio.module.disable = async () => {
    radio.calls.disable++;
    if (!firstDisable) return;
    firstDisable = false;
    markDisableStarted();
    await disableGate;
  };
  mgr.register(radio.module);
  await mgr.setEnabled('radio', true);
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const voiceDisable = mgr.setEnabled('radio', false, { origin: 'voice' });
  await disableStarted;
  const userEnable = mgr.setEnabled('radio', true, { origin: 'user' });
  releaseDisable();

  assert.deepEqual(await Promise.all([voiceDisable, userEnable]), [false, true]);
  assert.deepEqual(
    changes.filter(({ type }) => type === 'visibility')
      .map(({ enabled, origin }) => ({ enabled, origin })),
    [{ enabled: true, origin: 'user' }],
  );
  assert.equal(mgr.isEnabled('radio'), true);
  await mgr.destroyAll();
});

test('rapid ON then OFF then ON publishes only the final absolute intent', async () => {
  const mgr = new DataLayerManager({});
  let releaseUpdate;
  let markUpdateStarted;
  let firstUpdate = true;
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
  const radio = makeSlowLayer('radio', { updateInterval: -1 });
  radio.module.update = async () => {
    radio.calls.update++;
    if (!firstUpdate) return;
    firstUpdate = false;
    markUpdateStarted();
    await updateGate;
  };
  mgr.register(radio.module);
  const changes = [];
  mgr.subscribe((change) => changes.push(change));

  const firstOn = mgr.setEnabled('radio', true, { origin: 'voice' });
  await updateStarted;
  const middleOff = mgr.setEnabled('radio', false, { origin: 'programmatic' });
  const finalOn = mgr.setEnabled('radio', true, { origin: 'user' });
  releaseUpdate();

  assert.deepEqual(await Promise.all([firstOn, middleOff, finalOn]), [false, false, true]);
  assert.deepEqual(
    changes.filter(({ type }) => type === 'visibility')
      .map(({ enabled, origin }) => ({ enabled, origin })),
    [{ enabled: true, origin: 'user' }],
  );
  assert.equal(mgr.isEnabled('radio'), true);
  await mgr.destroyAll();
});

test('waitForLayerSettled defers reconciliation until the captured queue completes', async () => {
  const mgr = new DataLayerManager({});
  let releaseEnable;
  let markEnableStarted;
  const enableGate = new Promise((resolve) => { releaseEnable = resolve; });
  const enableStarted = new Promise((resolve) => { markEnableStarted = resolve; });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: 0 });
  missions.module.enable = async () => {
    markEnableStarted();
    await enableGate;
  };
  mgr.register(missions.module);

  const enabling = mgr.setEnabled('rocket-launches', true);
  await enableStarted;
  let settled = false;
  const waiting = mgr.waitForLayerSettled('rocket-launches').then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  releaseEnable();
  await Promise.all([enabling, waiting]);
  assert.equal(settled, true);
  await mgr.destroyAll();
});

test('programmatic Context enables neither create nor replace a restoration snapshot', async () => {
  const mgr = new DataLayerManager({});
  const missions = makeSlowLayer('rocket-launches', { updateInterval: 0 });
  mgr.register(missions.module);

  let snapshot = {
    enabledLayerIds: new Set(['flights', 'traffic']),
    marker: 'existing-session',
  };
  const existingSnapshot = snapshot;
  mgr.subscribe((change) => {
    if (!shouldCaptureContextSession(change)) return;
    snapshot = {
      enabledLayerIds: contextSnapshotLayerIds(mgr.getEnabledLayerIds()),
      marker: 'captured-by-user',
    };
  });

  await mgr.setEnabled('rocket-launches', true, { origin: 'programmatic' });
  assert.equal(snapshot, existingSnapshot, 'programmatic enable preserves an existing session snapshot');

  await mgr.setEnabled('rocket-launches', false, { origin: 'programmatic' });
  snapshot = null;
  await mgr.setEnabled('rocket-launches', true, { origin: 'programmatic' });
  assert.equal(snapshot, null, 'programmatic enable does not create a new session snapshot');

  await mgr.destroyAll();
});

test('visibility guards refuse incompatible enables before lifecycle work', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: 0 });
  const changes = [];
  mgr.register(layer.module);
  mgr.subscribe((change) => changes.push(change));
  const removeGuard = mgr.addVisibilityGuard((change) => (
    change.layerId === 'flights' && change.enabled
      ? 'Replay isolation keeps Live Flights off'
      : null
  ));

  const changed = await mgr.setEnabled('flights', true, { origin: 'user' });
  assert.equal(changed, false);
  assert.equal(mgr.isEnabled('flights'), false);
  assert.deepEqual(layer.calls, {
    enable: 0, disable: 0, update: 0, init: 0, presentation: [],
  });
  assert.deepEqual(changes, [
    {
      type: 'visibility-will-change',
      layerId: 'flights',
      enabled: true,
      origin: 'user',
      intentEpoch: 1,
    },
    {
      type: 'visibility-blocked',
      layerId: 'flights',
      enabled: true,
      origin: 'user',
      intentEpoch: 1,
      reason: 'Replay isolation keeps Live Flights off',
    },
  ]);

  removeGuard();
  await mgr.setEnabled('flights', true, { origin: 'programmatic' });
  assert.equal(mgr.isEnabled('flights'), true);
  await mgr.destroyAll();
});

test('failed asynchronous disable stays enabled and reports an explicit lifecycle failure', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: 0 });
  const failure = new Error('poller refused to stop');
  const changes = [];
  layer.module.disable = async () => { throw failure; };
  mgr.register(layer.module);
  mgr.subscribe((change) => changes.push(change));

  await mgr.setEnabled('flights', true);
  const changed = await mgr.setEnabled('flights', false);

  assert.equal(changed, false);
  assert.equal(mgr.isEnabled('flights'), true, 'manager must not publish a false disabled state');
  assert.notEqual(mgr.layers.get('flights').intervalId, null, 'the live refresh interval remains owned');
  const failed = changes.find(({ type }) => type === 'visibility-failed');
  assert.deepEqual({
    layerId: failed?.layerId,
    enabled: failed?.enabled,
    phase: failed?.phase,
    error: failed?.error,
  }, {
    layerId: 'flights',
    enabled: false,
    phase: 'disable',
    error: failure,
  });

  clearInterval(mgr.layers.get('flights').intervalId);
});

test('captured enabled set repairs siblings stopped before an isolation failure', async () => {
  const mgr = new DataLayerManager({});
  const flights = makeSlowLayer('flights', { updateInterval: 0 });
  const traffic = makeSlowLayer('traffic', { updateInterval: 0 });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: 0 });
  traffic.module.disable = async () => { throw new Error('traffic teardown failed'); };
  mgr.register(flights.module);
  mgr.register(traffic.module);
  mgr.register(missions.module);
  await Promise.all([
    mgr.setEnabled('flights', true),
    mgr.setEnabled('traffic', true),
  ]);
  const snapshot = mgr.getEnabledLayerIds();

  const results = await Promise.all([
    mgr.setEnabled('flights', false),
    mgr.setEnabled('traffic', false),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual([...mgr.getEnabledLayerIds()], ['traffic'], 'one sibling stopped before failure surfaced');

  // Model rollback running from inside Rocket Launches' own visibility guard:
  // that entry's queue cannot settle until the guard returns. Excluding the
  // trigger must let every sibling restore without enqueueing behind itself.
  mgr.layers.get('rocket-launches').toggleChain = new Promise(() => {});
  await mgr.restoreEnabledLayerIds(snapshot, {
    origin: 'context-restore',
    excludeLayerIds: ['rocket-launches'],
  });
  assert.deepEqual([...mgr.getEnabledLayerIds()], ['flights', 'traffic']);

  clearInterval(mgr.layers.get('flights').intervalId);
  clearInterval(mgr.layers.get('traffic').intervalId);
});

test('deferred full restore reconciles an uncertain failed Context shell', async () => {
  const mgr = new DataLayerManager({});
  const flights = makeSlowLayer('flights', { updateInterval: 0 });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: 0 });
  let cleanupCanConfirm = false;
  missions.module.enable = async () => { throw new Error('mission activation fixture'); };
  missions.module.disable = async () => cleanupCanConfirm;
  mgr.register(flights.module);
  mgr.register(missions.module);
  await mgr.setEnabled('flights', true);
  const snapshot = mgr.getEnabledLayerIds();
  await mgr.setEnabled('flights', false);

  assert.equal(await mgr.setEnabled('rocket-launches', true, { origin: 'user' }), false);
  assert.equal(mgr.isEnabled('rocket-launches'), true, 'uncertain cleanup stays conservatively ON');
  assert.equal(mgr.layers.get('rocket-launches').lifecycleUncertain, true);

  await mgr.waitForLayerSettled('rocket-launches');
  cleanupCanConfirm = true;
  await mgr.restoreEnabledLayerIds(snapshot, { origin: 'context-restore' });
  assert.equal(mgr.isEnabled('flights'), true);
  assert.equal(mgr.isEnabled('rocket-launches'), false);
  assert.equal(mgr.layers.get('rocket-launches').lifecycleUncertain, false);
  await mgr.destroyAll();
});

test('mission entry guard remains active until the slow Rocket Launches enable settles', async () => {
  const mgr = new DataLayerManager({});
  const flights = makeSlowLayer('flights', { updateInterval: 0 });
  let releaseMissionEnable;
  let markMissionEnableStarted;
  const missionEnableGate = new Promise((resolve) => { releaseMissionEnable = resolve; });
  const missionEnableStarted = new Promise((resolve) => { markMissionEnableStarted = resolve; });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: 0 });
  missions.module.enable = async () => {
    markMissionEnableStarted();
    await missionEnableGate;
  };
  mgr.register(flights.module);
  mgr.register(missions.module);

  let enteringMode = null;
  mgr.addVisibilityGuard(async (change) => {
    if (enteringMode === 'space-missions' && change.enabled && change.layerId !== 'rocket-launches') {
      return 'Replay isolation keeps other layers off';
    }
    if (change.enabled && change.layerId === 'rocket-launches') {
      enteringMode = 'space-missions';
    }
    return null;
  });
  mgr.subscribe((change) => {
    if (
      change.layerId === 'rocket-launches'
      && ['visibility', 'visibility-blocked', 'visibility-failed'].includes(change.type)
    ) {
      enteringMode = null;
    }
  });

  const enablingMissions = mgr.setEnabled('rocket-launches', true, { origin: 'user' });
  await missionEnableStarted;
  const flightsChanged = await mgr.setEnabled('flights', true, { origin: 'user' });
  assert.equal(flightsChanged, false);
  assert.equal(mgr.isEnabled('flights'), false, 'incompatible layer stays off throughout mission startup');
  assert.equal(enteringMode, 'space-missions', 'entry gate remains owned while enable is pending');

  releaseMissionEnable();
  await enablingMissions;
  assert.equal(mgr.isEnabled('rocket-launches'), true);
  assert.equal(enteringMode, null, 'settled visibility releases the entry gate');
  await mgr.destroyAll();
});

test('manager awaits asynchronous dependency teardown before a rapid re-enable', async () => {
  const mgr = new DataLayerManager({});
  const order = [];
  let releaseDisable;
  let markDisableStarted;
  const disableGate = new Promise((resolve) => { releaseDisable = resolve; });
  const disableStarted = new Promise((resolve) => { markDisableStarted = resolve; });
  mgr.register({
    id: 'rocket-launches',
    name: 'missions',
    icon: '',
    source: 'test',
    updateInterval: 0,
    async init() {},
    async enable() { order.push('enable'); },
    async disable() {
      order.push('disable-start');
      markDisableStarted();
      await disableGate;
      order.push('disable-finish');
    },
    async update() {},
    getStats() { return { count: 0, lastUpdate: null }; },
  });
  await mgr.setEnabled('rocket-launches', true);
  const disabling = mgr.setEnabled('rocket-launches', false);
  await disableStarted;
  const reenabling = mgr.setEnabled('rocket-launches', true);
  assert.deepEqual(order, ['enable', 'disable-start']);
  releaseDisable();
  assert.deepEqual(await Promise.all([disabling, reenabling]), [false, true]);
  assert.deepEqual(order, ['enable', 'disable-start', 'disable-finish', 'enable']);
  assert.equal(mgr.isEnabled('rocket-launches'), true);
  await mgr.destroyAll();
});

test('layer feed states distinguish unavailable, fallback, stale, and degraded controls', () => {
  assert.equal(layerFeedState({ error: 'feed down', count: 0, lastUpdate: null }), 'unavailable');
  assert.equal(layerFeedState({
    status: 'unavailable',
    error: 'feed down',
    count: 50,
    lastUpdate: 1,
  }), 'unavailable', 'an explicit total outage stays unavailable while last-good data is preserved');
  assert.equal(layerFeedState({ mode: 'sim', count: 100, lastUpdate: 1 }), 'fallback');
  assert.equal(layerFeedState({ source: 'adsb.lol', count: 10, lastUpdate: 1 }), 'fallback');
  assert.equal(layerFeedState({
    source: 'adsb.lol',
    fallback: false,
    count: 10,
    lastUpdate: 1,
  }), 'nominal', 'an explicitly primary adsb.lol feed is not a fallback');
  assert.equal(layerFeedState({ stale: true, count: 0, lastUpdate: 1 }), 'stale');
  assert.equal(layerFeedState({ error: 'partial group failure', count: 50, lastUpdate: 1 }), 'degraded');
  assert.equal(layerFeedState({ loading: true }), 'loading');
  assert.equal(layerFeedState({ count: 5, lastUpdate: 1 }), 'nominal');
});

test('layer metadata names degraded state instead of presenting an ordinary age', () => {
  const mgr = new DataLayerManager({});
  assert.match(mgr._buildMetaText({
    source: 'AISStream',
    stats: { stale: true, count: 20, lastUpdate: Date.now() - 10_000 },
  }), /^STALE · AISStream · /);
  assert.equal(mgr._buildMetaText({
    source: 'TomTom',
    stats: { mode: 'sim', count: 120, lastUpdate: 1, loadingLabel: 'simulated traffic' },
  }), 'FALLBACK · TomTom · simulated traffic');
  assert.equal(mgr._buildMetaText({
    source: 'CelesTrak',
    stats: { error: 'CelesTrak unreachable', count: 0, lastUpdate: null },
  }), 'UNAVAILABLE · CelesTrak · CelesTrak unreachable');
  assert.equal(mgr._buildMetaText({
    source: 'CelesTrak',
    stats: {
      status: 'unavailable',
      error: 'CelesTrak unreachable',
      count: 50,
      lastUpdate: 1,
    },
  }), 'UNAVAILABLE · CelesTrak · CelesTrak unreachable');
});

test('uncertain lifecycle state overrides ordinary feed status without disabling reconciliation', () => {
  const mgr = new DataLayerManager({});
  const classes = new Map();
  const attributes = new Map();
  const button = {
    classList: {
      toggle(name, active) { classes.set(name, Boolean(active)); },
    },
    dataset: {},
    disabled: false,
    textContent: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
  };
  const layer = {
    name: 'Radio',
    source: 'Radio Browser',
    enabled: true,
    lifecycleState: 'enabled',
    lifecycleUncertain: true,
    stats: { count: 750, lastUpdate: Date.now() },
  };

  mgr._syncToggleButton(button, layer);

  assert.equal(button.textContent, 'UNCERTAIN');
  assert.equal(button.dataset.feedState, 'uncertain');
  assert.equal(button.disabled, false, 'the lifecycle toggle remains available to reconcile authority');
  assert.equal(attributes.get('aria-label'), 'Radio: UNCERTAIN');
  assert.equal(classes.get('lifecycle-uncertain'), true);
  assert.equal(classes.get('feed-nominal'), false);
  assert.equal(
    mgr._buildMetaText(layer),
    'UNCERTAIN · Radio Browser · lifecycle state requires reconciliation',
  );
});

test('pre-transition subscribers capture the exact enabled set before user changes', async () => {
  const mgr = new DataLayerManager({});
  const context = makeSlowLayer('military-awareness', { updateInterval: 0 });
  const satellites = makeSlowLayer('satellites', { updateInterval: 0 });
  const snapshots = [];
  mgr.register(context.module);
  mgr.register(satellites.module);
  await mgr.setEnabled('satellites', true);

  mgr.subscribe((change) => {
    if (
      change.type === 'visibility-will-change'
      && change.layerId === 'military-awareness'
      && change.origin === 'user'
    ) {
      snapshots.push({ enabled: change.enabled, ids: [...mgr.getEnabledLayerIds()] });
    }
  });

  await mgr.toggle('military-awareness', { origin: 'user' });
  await mgr.toggle('military-awareness', { origin: 'user' });

  assert.deepEqual(snapshots, [
    { enabled: true, ids: ['satellites'] },
    { enabled: false, ids: ['military-awareness', 'satellites'] },
  ]);
  await mgr.destroyAll();
});

test('absolute Context entry intent is excluded from its own pre-entry restore snapshot', async () => {
  const mgr = new DataLayerManager({});
  const missions = makeSlowLayer('rocket-launches', { updateInterval: 0 });
  const satellites = makeSlowLayer('satellites', { updateInterval: 0 });
  mgr.register(missions.module);
  mgr.register(satellites.module);
  let snapshot = null;
  mgr.subscribe((change) => {
    if (shouldCaptureContextSession(change)) {
      snapshot = contextSnapshotLayerIds(
        mgr.getEnabledLayerIds(),
        null,
        [change.layerId],
      );
    }
  });

  await mgr.setEnabled('rocket-launches', true, { origin: 'user' });
  assert.deepEqual([...snapshot], []);
  await mgr.setEnabled('rocket-launches', false, { origin: 'user' });
  await mgr.restoreEnabledLayerIds(snapshot, { origin: 'context-restore' });

  assert.equal(mgr.isEnabled('rocket-launches'), false);
  assert.equal(mgr.isEnabled('satellites'), false);
  await mgr.destroyAll();
});

test('destroy waits for pre-destroy restoration before removing a layer', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('satellites', { updateInterval: 0 });
  const order = [];
  layer.module.destroy = () => order.push('destroy');
  mgr.register(layer.module);
  await mgr.setEnabled('satellites', true);

  mgr.subscribeBeforeDestroy(async ({ layerId }) => {
    order.push(`restore-start:${layerId}`);
    await Promise.resolve();
    order.push('restore-finish');
  });

  await mgr.destroyLayer('satellites');
  assert.deepEqual(order, ['restore-start:satellites', 'restore-finish', 'destroy']);
  assert.equal(mgr.layers.has('satellites'), false);
});

test('destroy revokes an in-flight enable before it can publish settled visibility', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  let releaseUpdate;
  let announceUpdate;
  const updateStarted = new Promise((resolve) => { announceUpdate = resolve; });
  layer.module.update = async () => {
    announceUpdate();
    await new Promise((resolve) => { releaseUpdate = resolve; });
  };
  mgr.register(layer.module);
  const changes = [];
  mgr.subscribe((change) => changes.push({ ...change }));

  const enable = mgr._setEnabledWithIntent('rocket-launches', true, { origin: 'user' });
  await updateStarted;
  const destroying = mgr.destroyLayer('rocket-launches');
  assert.equal(mgr.isEffectivelyEnabled('rocket-launches'), false);
  releaseUpdate();

  assert.equal(await enable.promise, false);
  assert.equal(await destroying, true);
  assert.equal(mgr.layers.has('rocket-launches'), false);
  assert.equal(
    changes.some((change) => change.type === 'visibility' && change.enabled === true),
    false,
    'revoked enable never publishes settled ON',
  );
  const cancelled = changes.find((change) => (
    change.type === 'visibility-cancelled' && change.intentEpoch === enable.intentEpoch
  ));
  assert.equal(cancelled?.cancellationReason, 'superseded');
  assert.equal(cancelled?.successorOrigin, 'teardown');
  assert.equal(cancelled?.successorEnabled, false);
});

test('destroy revokes an in-flight public toggle before it can publish settled visibility', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  let releaseUpdate;
  let announceUpdate;
  const updateStarted = new Promise((resolve) => { announceUpdate = resolve; });
  layer.module.update = async () => {
    announceUpdate();
    await new Promise((resolve) => { releaseUpdate = resolve; });
  };
  mgr.register(layer.module);
  const changes = [];
  mgr.subscribe((change) => changes.push({ ...change }));

  const enabling = mgr.toggle('rocket-launches', { origin: 'user' });
  await updateStarted;
  const destroying = mgr.destroyLayer('rocket-launches');
  releaseUpdate();

  assert.equal(await enabling, false);
  assert.equal(await destroying, true);
  assert.equal(mgr.layers.has('rocket-launches'), false);
  assert.equal(
    changes.some((change) => change.type === 'visibility' && change.enabled === true),
    false,
    'revoked public toggle never publishes settled ON',
  );
  const cancelled = changes.find((change) => change.type === 'visibility-cancelled');
  assert.equal(cancelled?.phase, 'update');
  assert.equal(cancelled?.cancellationReason, 'superseded');
  assert.equal(cancelled?.successorOrigin, 'teardown');
});

test('destroyLayer retains an enabled entry when semantic disable fails and permits retry', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('radio', { updateInterval: 1000 });
  let moduleActive = false;
  let rejectDisable = true;
  let destroyCalls = 0;
  layer.module.enable = () => { moduleActive = true; };
  layer.module.disable = () => {
    if (rejectDisable) return false;
    moduleActive = false;
    return true;
  };
  layer.module.destroy = () => { destroyCalls += 1; };
  mgr.register(layer.module);
  await mgr.setEnabled('radio', true);

  assert.equal(await mgr.destroyLayer('radio'), false);
  assert.equal(mgr.layers.has('radio'), true);
  assert.equal(mgr.isEnabled('radio'), true);
  assert.equal(moduleActive, true);
  assert.equal(destroyCalls, 0);
  assert.notEqual(mgr.layers.get('radio').intervalId, null);

  rejectDisable = false;
  assert.equal(await mgr.destroyLayer('radio'), true);
  assert.equal(mgr.layers.has('radio'), false);
  assert.equal(moduleActive, false);
  assert.equal(destroyCalls, 1);
});

test('pre-destroy hook can restore the exact focused-session state and params', async () => {
  const mgr = new DataLayerManager({});
  const local = makeSlowLayer('cctv', { updateInterval: 0 });
  const satellites = makeSlowLayer('satellites', { updateInterval: 0 });
  const missions = makeSlowLayer('rocket-launches', { updateInterval: 0 });
  const satelliteParams = { catalog: 'default', showDots: true };
  satellites.module.getParams = () => satelliteParams;
  satellites.module.setParams = (params) => Object.assign(satelliteParams, params);
  for (const layer of [local, satellites, missions]) mgr.register(layer.module);
  await Promise.all([
    mgr.setEnabled('cctv', true),
    mgr.setEnabled('satellites', true),
  ]);
  const snapshot = {
    enabled: mgr.getEnabledLayerIds(),
    params: mgr.getLayerParams('satellites'),
  };
  await Promise.all([
    mgr.setEnabled('cctv', false),
    mgr.setEnabled('rocket-launches', true),
  ]);
  mgr.setLayerParams('satellites', { catalog: 'dense', showDots: false });

  let stateAtDestroy = null;
  mgr.subscribeBeforeDestroy(async () => {
    mgr.setLayerParams('satellites', snapshot.params);
    await mgr.restoreEnabledLayerIds(snapshot.enabled, { origin: 'context-restore' });
    stateAtDestroy = {
      enabled: [...mgr.getEnabledLayerIds()],
      params: mgr.getLayerParams('satellites'),
    };
  });

  await mgr.destroyLayer('rocket-launches');
  assert.deepEqual(stateAtDestroy, {
    enabled: ['cctv', 'satellites'],
    params: { catalog: 'default', showDots: true },
  });
  assert.deepEqual([...mgr.getEnabledLayerIds()], ['cctv', 'satellites']);
  await mgr.destroyAll();
});

test('layer parameter snapshots are detached from module-owned nested state', () => {
  const mgr = new DataLayerManager({});
  const params = { catalog: 'dense', filters: { altitude: [100, 200] } };
  mgr.register({
    id: 'satellites',
    name: 'satellites',
    icon: '',
    source: 'test',
    getParams() { return params; },
  });

  const snapshot = mgr.getLayerParams('satellites');
  params.catalog = 'default';
  params.filters.altitude[0] = 999;

  assert.deepEqual(snapshot, { catalog: 'dense', filters: { altitude: [100, 200] } });
});

test('feed state: guidance statuses are normal operation, not faults', () => {
  // The Military Installations wide-view prompt: zoom/search guidance must
  // never read DEGRADED — waiting for user action is instruction, not fault.
  assert.equal(layerFeedState({ status: 'zoom-in', error: 'zoom in to search', count: 12 }), 'nominal');
  assert.equal(layerFeedState({ status: 'idle' }), 'nominal');
  assert.equal(layerFeedState({ status: 'empty', error: 'no records in view' }), 'nominal');
  // Honesty carve-out: rendered records from a genuinely stale cache still
  // read STALE through the guidance state.
  assert.equal(layerFeedState({ status: 'zoom-in', stale: true, count: 12 }), 'stale');
  // Loading still wins over guidance, and a real declared outage still wins over everything.
  assert.equal(layerFeedState({ status: 'zoom-in', loading: true }), 'loading');
  assert.equal(layerFeedState({ status: 'unavailable', error: 'down' }), 'unavailable');
  // A bare error with no prior data and no guidance status remains unavailable.
  assert.equal(layerFeedState({ error: 'boom' }), 'unavailable');
});

test('effective visibility counts in-flight transitions as their target state', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  let releaseInit;
  let announceInit;
  const initStarted = new Promise((resolve) => { announceInit = resolve; });
  layer.module.init = async () => {
    announceInit();
    await new Promise((resolve) => { releaseInit = resolve; });
  };
  mgr.register(layer.module);

  // Mid-ENABLING: settled false, effectively true, snapshot includes it.
  const pendingEnable = mgr.setEnabled('flights', true, { origin: 'user' });
  await initStarted;
  assert.equal(mgr.isEnabled('flights'), false, 'settled state stays false during activation');
  assert.equal(mgr.isEffectivelyEnabled('flights'), true, 'in-flight enable is effectively ON');
  assert.ok(mgr.getEnabledLayerIds().has('flights'), 'snapshot captures the in-flight enable');
  releaseInit();
  assert.equal(await pendingEnable, true);

  // Mid-DISABLING: settled true, effectively false, snapshot excludes it.
  let releaseDisable;
  let announceDisable;
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  layer.module.disable = async () => {
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };
  const pendingDisable = mgr.setEnabled('flights', false, { origin: 'user' });
  await disableStarted;
  assert.equal(mgr.isEnabled('flights'), true, 'settled state stays true during teardown');
  assert.equal(mgr.isEffectivelyEnabled('flights'), false, 'in-flight disable is effectively OFF');
  assert.equal(mgr.getEnabledLayerIds().has('flights'), false, 'snapshot honors the in-flight disable');
  releaseDisable();
  await pendingDisable;
  assert.equal(mgr.isEnabled('flights'), false);
});

test('superseded-intent adoption re-runs visibility guards before publishing success', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  let releaseDisable;
  let announceDisable;
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  mgr.register(layer.module);
  assert.equal(await mgr.setEnabled('flights', true, { origin: 'user' }), true);

  // Slow user OFF whose cleanup will be superseded mid-flight. Only the FIRST
  // disable is gated; the guarded adoption's compensating disable must run
  // through unimpeded.
  let disableCalls = 0;
  layer.module.disable = async () => {
    disableCalls += 1;
    if (disableCalls > 1) return;
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };
  const pendingOff = mgr.setEnabled('flights', false, { origin: 'user' });
  await disableStarted;

  // An exclusive mode installs its guard while the OFF is still in flight.
  const guardChanges = [];
  mgr.addVisibilityGuard((change) => {
    guardChanges.push({ ...change });
    return change.layerId === 'flights' && change.enabled
      ? 'Flights are unavailable in this Context mode'
      : null;
  });

  const changes = [];
  mgr.subscribe((change) => changes.push({ ...change }));

  // Newer absolute ON supersedes the OFF; its adoption path must consult the
  // guard instead of announcing the compensated ON state as a success.
  const pendingOn = mgr.setEnabled('flights', true, { origin: 'user' });
  releaseDisable();
  const onResult = await pendingOn;
  await pendingOff;
  await mgr.waitForLayerSettled('flights');

  assert.equal(onResult, false, 'guarded adoption reports the blocked request as unfulfilled');
  assert.ok(
    guardChanges.some((change) => change.layerId === 'flights' && change.enabled),
    'the guard was actually consulted for the adopted ON',
  );
  assert.ok(
    changes.some((change) => change.type === 'visibility-blocked' && change.layerId === 'flights'),
    'the blocked adoption is published as blocked',
  );
  assert.equal(
    changes.some((change) => change.type === 'visibility' && change.layerId === 'flights' && change.enabled === true),
    false,
    'no successful ON visibility event is published past the guard',
  );
  assert.equal(mgr.isEnabled('flights'), false, 'the guard-forbidden adopted state is reconciled OFF');
  assert.equal(mgr.isEffectivelyEnabled('flights'), false);
});

test('superseding an intent inside the adoption guard publishes the exact successor envelope', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('rocket-launches', { updateInterval: -1 });
  mgr.register(layer.module);
  assert.equal(await mgr.setEnabled('rocket-launches', true, { origin: 'user' }), true);

  let releaseDisable;
  let announceDisable;
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  layer.module.disable = async () => {
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };

  let releaseAdoptionGuard;
  let announceAdoptionGuard;
  const adoptionGuardStarted = new Promise((resolve) => { announceAdoptionGuard = resolve; });
  mgr.addVisibilityGuard(async (change) => {
    if (change.layerId !== 'rocket-launches' || !change.enabled || change.origin !== 'replacement-b') return null;
    announceAdoptionGuard();
    await new Promise((resolve) => { releaseAdoptionGuard = resolve; });
    return null;
  });

  const changes = [];
  mgr.subscribe((change) => changes.push({ ...change }));
  const off = mgr._setEnabledWithIntent('rocket-launches', false, { origin: 'user' });
  await disableStarted;
  const replacementB = mgr._setEnabledWithIntent('rocket-launches', true, { origin: 'replacement-b' });
  releaseDisable();
  await adoptionGuardStarted;
  const replacementC = mgr._setEnabledWithIntent('rocket-launches', true, { origin: 'replacement-c' });
  releaseAdoptionGuard();

  assert.equal(await off.promise, false);
  assert.equal(await replacementB.promise, false);
  assert.equal(await replacementC.promise, true);
  const outcomeB = await mgr._waitForVisibilityIntent('rocket-launches', replacementB.intentEpoch);
  assert.equal(outcomeB.cancellationReason, 'superseded');
  assert.equal(outcomeB.successorIntentEpoch, replacementC.intentEpoch);
  assert.equal(outcomeB.successorEnabled, true);
  assert.equal(outcomeB.successorOrigin, 'replacement-c');
  assert.ok(changes.some((change) => (
    change.type === 'visibility-cancelled'
    && change.intentEpoch === replacementB.intentEpoch
    && change.successorIntentEpoch === replacementC.intentEpoch
  )));
  assert.equal(mgr.isEnabled('rocket-launches'), true);
});

test('effective visibility follows the newest absolute intent in both supersede directions', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  let releaseInit;
  let announceInit;
  const initStarted = new Promise((resolve) => { announceInit = resolve; });
  layer.module.init = async () => {
    announceInit();
    await new Promise((resolve) => { releaseInit = resolve; });
  };
  mgr.register(layer.module);

  // OFF supersedes an in-flight enable: from the synchronous moment of the
  // OFF request, effective visibility must read false even though the
  // superseded transaction's lifecycleState still says 'enabling'.
  const pendingOn = mgr.setEnabled('flights', true, { origin: 'user' });
  await initStarted;
  assert.equal(mgr.isEffectivelyEnabled('flights'), true);
  const pendingOff = mgr.setEnabled('flights', false, { origin: 'user' });
  assert.equal(
    mgr.isEffectivelyEnabled('flights'),
    false,
    'synchronously after OFF supersedes, effective visibility is OFF',
  );
  assert.equal(mgr.getEnabledLayerIds().has('flights'), false);
  releaseInit();
  await pendingOn;
  await pendingOff;
  await mgr.waitForLayerSettled('flights');
  assert.equal(mgr.isEnabled('flights'), false);

  // ON supersedes an in-flight disable: the inverse direction.
  assert.equal(await mgr.setEnabled('flights', true, { origin: 'user' }), true);
  let releaseDisable;
  let announceDisable;
  const disableStarted = new Promise((resolve) => { announceDisable = resolve; });
  let disableCalls = 0;
  layer.module.disable = async () => {
    disableCalls += 1;
    if (disableCalls > 1) return;
    announceDisable();
    await new Promise((resolve) => { releaseDisable = resolve; });
  };
  const pendingOff2 = mgr.setEnabled('flights', false, { origin: 'user' });
  await disableStarted;
  assert.equal(mgr.isEffectivelyEnabled('flights'), false);
  const pendingOn2 = mgr.setEnabled('flights', true, { origin: 'user' });
  assert.equal(
    mgr.isEffectivelyEnabled('flights'),
    true,
    'synchronously after ON supersedes, effective visibility is ON',
  );
  assert.ok(mgr.getEnabledLayerIds().has('flights'));
  releaseDisable();
  await pendingOff2;
  await pendingOn2;
  await mgr.waitForLayerSettled('flights');
  assert.equal(mgr.isEnabled('flights'), true);
  assert.equal(mgr.isEffectivelyEnabled('flights'), true, 'settled fallback after all intents release');
});

test('a newer absolute intent aborts a hung guard-compensation instead of starving', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  let releaseFirstDisable;
  let announceFirstDisable;
  const firstDisableStarted = new Promise((resolve) => { announceFirstDisable = resolve; });
  let hangCompensation = false;
  let compensationAborted = false;
  mgr.register(layer.module);
  assert.equal(await mgr.setEnabled('flights', true, { origin: 'user' }), true);

  let disableCalls = 0;
  layer.module.disable = async (_viewer, { signal } = {}) => {
    disableCalls += 1;
    if (disableCalls === 1) {
      announceFirstDisable();
      await new Promise((resolve) => { releaseFirstDisable = resolve; });
      return;
    }
    if (hangCompensation) {
      // Hang until the manager aborts this transition; resolve on abort so the
      // lifecycle can run its cancellation path.
      await new Promise((resolve) => {
        if (signal?.aborted) { compensationAborted = true; resolve(); return; }
        signal?.addEventListener('abort', () => { compensationAborted = true; resolve(); }, { once: true });
      });
      return false;
    }
  };

  const pendingOff = mgr.setEnabled('flights', false, { origin: 'user' });
  await firstDisableStarted;
  const removeGuard = mgr.addVisibilityGuard((change) => (
    change.layerId === 'flights' && change.enabled ? 'blocked by mode' : null
  ));
  hangCompensation = true;
  const pendingBlockedOn = mgr.setEnabled('flights', true, { origin: 'user' });
  releaseFirstDisable();
  // Give the blocked adoption time to enter its hung compensation.
  await new Promise((resolve) => setTimeout(resolve, 10));
  removeGuard();
  // The newest intent must be able to abort the hung compensation and run.
  const pendingFinalOn = mgr.setEnabled('flights', true, { origin: 'user' });
  const finalOn = await Promise.race([
    pendingFinalOn,
    new Promise((resolve) => setTimeout(() => resolve('starved'), 2000)),
  ]);
  assert.notEqual(finalOn, 'starved', 'newest intent must not starve behind the compensation');
  assert.equal(compensationAborted, true, 'the hung compensation was aborted');
  assert.equal(await pendingBlockedOn, false, 'the guard-blocked request stays unfulfilled');
  assert.equal(finalOn, true, 'the newest ON wins once the guard is gone');
  await pendingOff;
  await mgr.waitForLayerSettled('flights');
  assert.equal(mgr.isEnabled('flights'), true);
});

test('re-entrant setEnabled from a blocked-adoption listener supersedes the compensation cleanly', async () => {
  const mgr = new DataLayerManager({});
  const layer = makeSlowLayer('flights', { updateInterval: -1 });
  let releaseFirstDisable;
  let announceFirstDisable;
  const firstDisableStarted = new Promise((resolve) => { announceFirstDisable = resolve; });
  mgr.register(layer.module);
  assert.equal(await mgr.setEnabled('flights', true, { origin: 'user' }), true);

  let disableCalls = 0;
  layer.module.disable = async () => {
    disableCalls += 1;
    if (disableCalls === 1) {
      announceFirstDisable();
      await new Promise((resolve) => { releaseFirstDisable = resolve; });
    }
  };

  const pendingOff = mgr.setEnabled('flights', false, { origin: 'user' });
  await firstDisableStarted;
  let removeGuard = mgr.addVisibilityGuard((change) => (
    change.layerId === 'flights' && change.enabled ? 'blocked by mode' : null
  ));

  // The moment the blocked event is announced, a listener re-enters with a
  // newer absolute intent — this used to land in the unregistered-compensation
  // window and starve, or orphan the transitional presentation.
  let reentrantResult = null;
  const effectiveDuringBlocked = [];
  const unsubscribe = mgr.subscribe((change) => {
    if (change.type !== 'visibility-blocked' || change.layerId !== 'flights') return;
    effectiveDuringBlocked.push(mgr.isEffectivelyEnabled('flights'));
    removeGuard();
    reentrantResult = mgr.setEnabled('flights', true, { origin: 'user' });
  });

  const pendingBlockedOn = mgr.setEnabled('flights', true, { origin: 'user' });
  releaseFirstDisable();

  const blockedOn = await pendingBlockedOn;
  const reentrant = await Promise.race([
    (async () => reentrantResult === null ? 'never-fired' : await reentrantResult)(),
    new Promise((resolve) => setTimeout(() => resolve('starved'), 2000)),
  ]);
  await pendingOff;
  await mgr.waitForLayerSettled('flights');
  unsubscribe();

  assert.equal(blockedOn, false, 'the guard-blocked request stays unfulfilled');
  assert.notEqual(reentrant, 'starved', 'the re-entrant newest intent must not starve');
  assert.notEqual(reentrant, 'never-fired', 'the blocked event fired and re-entered');
  assert.deepEqual(
    effectiveDuringBlocked,
    [false],
    'during the blocked callback, effective visibility reads the reconciliation target (OFF)',
  );
  assert.equal(mgr.isEnabled('flights'), true, 'the re-entrant ON wins after the guard is removed');
  const lifecycle = mgr.getLayerLifecycleState('flights');
  assert.equal(lifecycle.lifecycleState, 'enabled', 'no orphaned transitional presentation');
  assert.equal(lifecycle.uncertain, false);
});

test('every manager registration exposes the normalized loading and refresh contract', () => {
  const mgr = new DataLayerManager({});
  mgr.register({
    id: 'minimal',
    name: 'Minimal',
    icon: '',
    source: 'test',
    updateInterval: -1,
    init() {},
    enable() {},
    disable() {},
    update() {},
  });
  mgr.register({
    id: 'specific',
    name: 'Specific',
    icon: '',
    source: 'test',
    updateInterval: -1,
    init() {},
    enable() {},
    disable() {},
    update() {},
    getStats() {
      return {
        count: 4,
        lastUpdate: 123,
        error: 'module-owned error',
        available: false,
        customHealth: 'preserved',
      };
    },
  });
  mgr.layers.get('specific').initialized = true;

  for (const layer of mgr.getAll()) {
    assert.equal(typeof layer.stats.loading, 'boolean', `${layer.id} loading must be normalized`);
    assert.equal(typeof layer.stats.refreshing, 'boolean', `${layer.id} refreshing must be normalized`);
    assert.ok(Object.hasOwn(layer.stats, 'managerRefreshError'));
  }
  const specific = mgr.getAll().find(({ id }) => id === 'specific').stats;
  assert.equal(specific.error, 'module-owned error');
  assert.equal(specific.available, false);
  assert.equal(specific.customHealth, 'preserved');
});

test('periodic refresh publishes work, failure, and later manager-owned recovery', async () => {
  const mgr = new DataLayerManager({});
  let updateResult = true;
  let moduleError = null;
  let releaseUpdate;
  let updateStarted;
  const started = new Promise((resolve) => { updateStarted = resolve; });
  const events = [];
  mgr.register({
    id: 'flights',
    name: 'Live Flights',
    icon: '',
    source: 'test',
    updateInterval: 30000,
    init() {},
    enable() {},
    disable() {},
    async update() {
      updateStarted();
      await new Promise((resolve) => { releaseUpdate = resolve; });
      return updateResult;
    },
    getStats() {
      return { count: 8, lastUpdate: 123, error: moduleError, available: true };
    },
  });
  const entry = mgr.layers.get('flights');
  entry.initialized = true;
  entry.enabled = true;
  entry.lifecycleState = 'enabled';
  mgr.subscribe((event) => events.push(event));

  updateResult = false;
  const failedRefresh = mgr._runPeriodicUpdate('flights', entry);
  await started;
  assert.equal(mgr.getAll()[0].stats.refreshing, true);
  assert.equal(mgr.getAll()[0].lifecycleState, 'enabled');
  releaseUpdate();
  assert.equal(await failedRefresh, false);
  assert.match(mgr.getAll()[0].stats.managerRefreshError, /refresh rejected/);
  assert.deepEqual(events.map(({ type }) => type), ['refresh-transition', 'refresh-failed']);

  updateStarted = () => {};
  updateResult = true;
  entry.module.update = async () => true;
  assert.equal(await mgr._runPeriodicUpdate('flights', entry), true);
  assert.equal(mgr.getAll()[0].stats.managerRefreshError, null);
  assert.deepEqual(events.map(({ type }) => type), [
    'refresh-transition',
    'refresh-failed',
    'refresh-transition',
    'refresh',
  ]);
  assert.equal(mgr.isEnabled('flights'), true, 'refresh state never owns visibility');

  let explicitRefreshCalls = 0;
  entry.module.update = async (_viewer, { signal } = {}) => {
    assert.equal(signal, null);
    explicitRefreshCalls += 1;
    return true;
  };
  assert.equal(await mgr.refreshLayer('flights'), true);
  assert.equal(explicitRefreshCalls, 1, 'an enabled layer can be refreshed on demand');
});

test('periodic rejection preserves a module-specific error and recovers independently', async () => {
  const mgr = new DataLayerManager({});
  let moduleError = 'upstream-specific outage';
  let shouldReject = true;
  mgr.register({
    id: 'satellites',
    name: 'Satellites',
    icon: '',
    source: 'test',
    updateInterval: 0,
    refreshInterval: 300000,
    init() {},
    enable() {},
    disable() {},
    async update() {
      if (shouldReject) throw new Error('network rejected');
      return true;
    },
    getStats() {
      return { count: 12, lastUpdate: 456, error: moduleError, available: false };
    },
  });
  const entry = mgr.layers.get('satellites');
  entry.initialized = true;
  entry.enabled = true;
  entry.lifecycleState = 'enabled';

  assert.equal(await mgr._runPeriodicUpdate('satellites', entry), false);
  let stats = mgr.getAll()[0].stats;
  assert.equal(stats.error, 'upstream-specific outage');
  assert.equal(stats.available, false);
  assert.equal(stats.managerRefreshError, 'network rejected');

  shouldReject = false;
  moduleError = null;
  entry.module.getStats = () => ({ count: 13, lastUpdate: 789, error: null, available: true });
  assert.equal(await mgr._runPeriodicUpdate('satellites', entry), true);
  stats = mgr.getAll()[0].stats;
  assert.equal(stats.error, null);
  assert.equal(stats.available, true);
  assert.equal(stats.managerRefreshError, null);
});

test('disable invalidates an active periodic refresh without publishing stale settlement', async () => {
  const mgr = new DataLayerManager({});
  let releaseRefresh;
  let announceRefresh;
  const refreshStarted = new Promise((resolve) => { announceRefresh = resolve; });
  const events = [];
  mgr.register({
    id: 'flights',
    name: 'Live Flights',
    icon: '',
    source: 'test',
    updateInterval: 30000,
    init() {},
    enable() {},
    disable() {},
    async update() {
      announceRefresh();
      await new Promise((resolve) => { releaseRefresh = resolve; });
      throw new Error('late refresh failure');
    },
    getStats() {
      return { count: 4, lastUpdate: 123, error: null, available: true };
    },
  });
  const entry = mgr.layers.get('flights');
  entry.initialized = true;
  entry.enabled = true;
  entry.lifecycleState = 'enabled';
  mgr.subscribe((event) => events.push(event));

  const pendingRefresh = mgr._runPeriodicUpdate('flights', entry);
  await refreshStarted;
  const waitingRefresh = mgr.refreshLayer('flights');
  await Promise.resolve();
  const pendingDisable = mgr.setEnabled('flights', false, { origin: 'user' });
  assert.equal(await waitingRefresh, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseRefresh();
  assert.equal(await pendingRefresh, false);
  assert.equal(await pendingDisable, true);

  assert.equal(mgr.isEnabled('flights'), false);
  assert.equal(entry.refreshing, false);
  assert.equal(entry.managerRefreshError, null);
  assert.ok(events.some(({ type }) => type === 'refresh-transition'));
  assert.ok(events.some(({ type, reason }) => (
    type === 'refresh-cancelled' && reason === 'layer-disabled'
  )));
  assert.ok(!events.some(({ type }) => type === 'refresh-failed' || type === 'refresh'));
});

test('destroy settles an explicit refresh waiting behind invalidated periodic work', async () => {
  const mgr = new DataLayerManager({});
  let releaseRefresh;
  let announceRefresh;
  const refreshStarted = new Promise((resolve) => { announceRefresh = resolve; });
  const events = [];
  mgr.register({
    id: 'flights',
    name: 'Live Flights',
    icon: '',
    source: 'test',
    updateInterval: 30000,
    init() {},
    enable() {},
    disable() {},
    async update() {
      announceRefresh();
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return true;
    },
    getStats() {
      return { count: 4, lastUpdate: 123, error: null, available: true };
    },
  });
  const entry = mgr.layers.get('flights');
  entry.initialized = true;
  entry.enabled = true;
  entry.lifecycleState = 'enabled';
  mgr.subscribe((event) => events.push(event));

  const periodicRefresh = mgr._runPeriodicUpdate('flights', entry);
  await refreshStarted;
  const requestedRefresh = mgr.refreshLayer('flights');
  await Promise.resolve();
  const destroy = mgr.destroyLayer('flights');

  assert.equal(await requestedRefresh, false);
  assert.ok(events.some(({ type, reason }) => (
    type === 'refresh-cancelled' && reason === 'layer-destroyed'
  )));
  releaseRefresh();
  assert.equal(await periodicRefresh, false);
  assert.equal(await destroy, true);
});

// ── Per-layer row controls (chips + color legend) ───────────────────────────
// The satellites layer is the first consumer: a DENSE catalog chip and a class
// legend rendered under its row. The manager owns the DOM and the param write;
// the layer only declares what it wants, so the chip can never disagree with
// the layer's real state.

/** DOM double rich enough for the row-controls render path. */
function makeControlElement() {
  const element = {
    children: [],
    className: '',
    dataset: {},
    style: {},
    attributes: {},
    listeners: {},
    textContent: '',
    hidden: false,
    disabled: false,
    title: '',
    type: '',
    classList: { toggle() {} },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) n.parent = this; this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    remove() {
      const siblings = this.parent?.children;
      if (siblings) this.parent.children = siblings.filter((n) => n !== this);
      // Browsers blur a node the moment it leaves the document. Modelling that
      // is the whole point: it is exactly what in-place chip reconciliation
      // exists to avoid, so a regression to rebuild-everything must fail here.
      if (globalThis.document?.activeElement === this) globalThis.document.activeElement = null;
    },
    focus() { if (globalThis.document) globalThis.document.activeElement = this; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    closest(selector) {
      const className = selector.slice(1);
      return String(this.className).split(/\s+/).includes(className) ? this : null;
    },
    querySelector(selector) {
      if (selector.startsWith('[data-layer-id="')) {
        const id = selector.slice(16, -2);
        return this.children.find((child) => child.dataset.layerId === id) || null;
      }
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      const visit = (node) => {
        if (String(node.className).split(/\s+/).includes(className)) return node;
        for (const child of node.children || []) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    },
    set innerHTML(value) { if (value === '') this.children = []; },
    get innerHTML() { return ''; },
  };
  return element;
}

/** Collect every node in a rendered subtree carrying `className`. */
function collectByClass(node, className) {
  const found = [];
  const visit = (current) => {
    if (String(current.className).split(/\s+/).includes(className)) found.push(current);
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return found;
}

/** A layer that declares a two-state chip plus a legend, like satellites. */
function makeRowControlLayer() {
  let mode = 'core';
  return {
    get mode() { return mode; },
    module: {
      id: 'satellites',
      name: 'Satellites',
      icon: '',
      source: 'CelesTrak',
      updateInterval: -1,
      async init() {},
      enable() {},
      disable() {},
      async update() {},
      getStats() { return { count: 3, lastUpdate: Date.now() }; },
      setParams(params) { if (params.catalog) mode = params.catalog; },
      getParams() { return { catalog: mode }; },
      getRowControls() {
        const dense = mode === 'dense';
        return {
          chips: [{
            id: 'catalog',
            label: 'DENSE',
            active: dense,
            title: 'toggle the dense catalog',
            params: { catalog: dense ? 'core' : 'dense' },
          }],
          legend: [
            { klass: 'nav', label: 'NAV', color: '#4fd8ff', blurb: 'GNSS', count: 2 },
            { klass: 'geo', label: 'GEO', color: '#c89bff', blurb: 'belt', count: 5 },
          ],
        };
      },
    },
  };
}

test('a layer that declares row controls renders its chips and color legend', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeControlElement };
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  const container = makeControlElement();

  try {
    mgr.buildTogglePanel(container);
    const row = container.querySelector('[data-layer-id="satellites"]');
    const controls = row.querySelector('.data-toggle-controls');
    assert.ok(controls, 'the row gained a controls block');
    // Disabled layers stay quiet — no chip, no legend.
    assert.equal(controls.hidden, true);

    assert.equal(await mgr.setEnabled('satellites', true), true);
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, false);

    const chips = collectByClass(controls, 'data-toggle-chip');
    assert.equal(chips.length, 1);
    assert.equal(chips[0].textContent, 'DENSE');
    assert.equal(chips[0].dataset.chipId, 'catalog');
    assert.equal(chips[0].attributes['aria-pressed'], 'false');
    assert.equal(chips[0].title, 'toggle the dense catalog');

    const swatches = collectByClass(controls, 'data-toggle-legend-swatch');
    assert.deepEqual(swatches.map((s) => s.style.background), ['#4fd8ff', '#c89bff'],
      'each legend swatch is painted the exact class color');
    const items = collectByClass(controls, 'data-toggle-legend-item');
    assert.deepEqual(items.map((i) => i.title), ['GNSS', 'belt']);
    assert.equal(items.length, 2);
  } finally {
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('clicking a row chip applies the params it declared and re-renders', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeControlElement };
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  const container = makeControlElement();

  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const row = container.querySelector('[data-layer-id="satellites"]');
    const controls = row.querySelector('.data-toggle-controls');
    const chip = collectByClass(controls, 'data-toggle-chip')[0];

    controls.listeners.click({ target: chip });
    assert.equal(layer.mode, 'dense', 'the chip wrote the params it declared');
    // setLayerParams refreshes the panel, so the chip already reflects the flip.
    const afterOn = collectByClass(controls, 'data-toggle-chip')[0];
    assert.equal(afterOn.attributes['aria-pressed'], 'true');
    assert.equal(afterOn.className.includes('active'), true);

    controls.listeners.click({ target: afterOn });
    assert.equal(layer.mode, 'core', 'the chip toggles back rather than latching');
    assert.equal(collectByClass(controls, 'data-toggle-chip')[0].attributes['aria-pressed'], 'false');
  } finally {
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('a click outside a chip is inert, and a throwing layer cannot blank the panel', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeControlElement };
  const warn = console.warn;
  console.warn = () => {};
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  const container = makeControlElement();

  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const row = container.querySelector('[data-layer-id="satellites"]');
    const controls = row.querySelector('.data-toggle-controls');

    const legendItem = collectByClass(controls, 'data-toggle-legend-item')[0];
    controls.listeners.click({ target: legendItem });
    assert.equal(layer.mode, 'core', 'the legend is not a control');
    controls.listeners.click({ target: { closest: () => null } });
    assert.equal(layer.mode, 'core');

    layer.module.getRowControls = () => { throw new Error('boom'); };
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, true, 'a throwing layer collapses to an empty block');
    assert.ok(container.querySelector('[data-layer-id="satellites"]'), 'the row itself survives');
  } finally {
    console.warn = warn;
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('keyboard focus on a chip survives the refresh its own click triggers', async () => {
  // _syncRowControls runs on EVERY panel refresh, including the one the chip's
  // own click triggers. Rebuilding the button would blur it every time, so a
  // keyboard user loses their place on activation.
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeControlElement, activeElement: null };
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  const container = makeControlElement();

  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const controls = container
      .querySelector('[data-layer-id="satellites"]')
      .querySelector('.data-toggle-controls');
    const chip = collectByClass(controls, 'data-toggle-chip')[0];

    chip.focus();
    assert.equal(globalThis.document.activeElement, chip, 'the chip starts focused');

    controls.listeners.click({ target: chip });
    assert.equal(globalThis.document.activeElement, chip,
      'activating the chip does not blur it');
    assert.equal(collectByClass(controls, 'data-toggle-chip')[0], chip,
      'the SAME button node is reused across the click-driven refresh');

    mgr._refreshTogglePanel();
    mgr._refreshTogglePanel();
    assert.equal(globalThis.document.activeElement, chip,
      'repeated refreshes never steal focus');
    // Legend entries hold no focus, so they may be replaced — never duplicated.
    assert.equal(collectByClass(controls, 'data-toggle-legend-item').length, 2);

    // ...and a chip that genuinely goes away still releases focus.
    layer.module.getRowControls = () => ({ chips: [], legend: [] });
    mgr._refreshTogglePanel();
    assert.equal(globalThis.document.activeElement, null);
  } finally {
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('an async layer pushes its own row refresh, and a busy chip refuses clicks', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeControlElement };
  const mgr = new DataLayerManager({});

  let settled = false;
  let writes = 0;
  const module = {
    id: 'satellites',
    name: 'Satellites',
    icon: '',
    source: 'CelesTrak',
    updateInterval: -1,
    async init() {},
    enable() {},
    disable() {},
    async update() {},
    getStats() { return { count: 1, lastUpdate: Date.now() }; },
    setParams() { writes += 1; },
    getRowControls() {
      return {
        chips: [{
          id: 'catalog',
          label: settled ? 'DENSE' : 'DENSE ···',
          active: settled,
          busy: !settled,
          disabled: !settled,
          state: settled ? 'active' : 'loading',
          title: 'x',
          params: { catalog: 'core' },
        }],
        legend: [],
      };
    },
    setRowControlsListener(fn) { module._listener = fn; },
  };
  mgr.register(module);
  const container = makeControlElement();

  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    assert.equal(typeof module._listener, 'function', 'the manager installed its listener');

    const controls = container
      .querySelector('[data-layer-id="satellites"]')
      .querySelector('.data-toggle-controls');
    const chip = collectByClass(controls, 'data-toggle-chip')[0];
    assert.equal(chip.textContent, 'DENSE ···');
    assert.equal(chip.disabled, true);
    assert.equal(chip.attributes['aria-busy'], 'true');
    assert.equal(chip.attributes['aria-pressed'], 'false', 'busy is never reported as active');
    assert.equal(chip.className.includes('chip-loading'), true);

    controls.listeners.click({ target: chip });
    assert.equal(writes, 0, 'a disabled chip is inert');

    // The layer settles and pushes its own refresh — no panel poll involved.
    settled = true;
    module._listener();
    assert.equal(chip.textContent, 'DENSE');
    assert.equal(chip.disabled, false);
    assert.equal(chip.attributes['aria-pressed'], 'true');
    assert.equal(chip.attributes['aria-busy'], 'false');

    controls.listeners.click({ target: chip });
    assert.equal(writes, 1, 'the settled chip writes again');
  } finally {
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('a layer that surrenders its row controls hides the block entirely', async () => {
  // Space Missions borrows the satellite layer with showPoints:false; the row
  // must not advertise a legend for an empty sky or offer a chip whose write
  // the dependency owner will silently revert.
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: makeControlElement };
  const mgr = new DataLayerManager({});
  let surrendered = false;
  const layer = makeRowControlLayer();
  const inner = layer.module.getRowControls;
  layer.module.getRowControls = () => (surrendered ? { chips: [], legend: [] } : inner());
  mgr.register(layer.module);
  const container = makeControlElement();

  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const controls = container
      .querySelector('[data-layer-id="satellites"]')
      .querySelector('.data-toggle-controls');
    assert.equal(controls.hidden, false);
    assert.equal(collectByClass(controls, 'data-toggle-chip').length, 1);

    surrendered = true;
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, true);
    assert.equal(collectByClass(controls, 'data-toggle-chip').length, 0,
      'the chip is removed, not merely hidden behind a style');
    assert.equal(collectByClass(controls, 'data-toggle-legend-item').length, 0);

    surrendered = false;
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, false, 'the row returns when the owner releases it');
    assert.equal(collectByClass(controls, 'data-toggle-chip').length, 1);
  } finally {
    await mgr.destroyAll();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
