import test from 'node:test';
import assert from 'node:assert/strict';

import { DataLayerManager } from './manager.js';
import {
  LAYER_STATE_REGISTRY,
  LAYER_STATE_STORAGE_KEY,
  LayerStateCoordinator,
  REGISTERED_LAYER_IDS,
  SHARE_TRACKING_RESTORE_POLICIES,
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
  normalizeLayerState,
  parseStoredLayerState,
  serializeStoredLayerState,
  validateLayerStateRegistry,
} from './layerState.js';
import radioLayer from './radio.js';
import { stampInitialShareGesture } from '../navigationPolicy.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function paramsForLayer(id) {
  if (id === 'flights' || id === 'military') {
    return { models3d: false, models3dMode: 'proximity', irBoost: true };
  }
  if (id === 'satellites') return { catalog: 'core', showPoints: false, showOrbits: false };
  if (id === 'cctv') {
    return {
      coverageMode: 'on',
      showProjection: true,
      autoHop: false,
      autoHopSec: 22,
      selectedCameraId: 'secret-camera',
      calibrationMode: true,
      calibration: { cameraId: 'secret-camera', values: { heading: 12 } },
    };
  }
  if (id === 'radio') {
    return {
      filter: 'all',
      volume: 0.8,
      selectedStationId: 'private-station',
      audioState: 'playing',
      voiceDucked: true,
    };
  }
  return null;
}

function fakeLayer(id, hooks = {}) {
  let params = paramsForLayer(id);
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    async init() { return hooks.init ? hooks.init() : true; },
    async enable() { return hooks.enable ? hooks.enable() : true; },
    async update() { return hooks.update ? hooks.update() : true; },
    async disable() { return hooks.disable ? hooks.disable() : true; },
    ...(hooks.resolveTrackingRestoreTarget ? {
      async resolveTrackingRestoreTarget(targetId, options) {
        return hooks.resolveTrackingRestoreTarget(targetId, options);
      },
    } : {}),
    ...(params ? {
      setParams(next = {}, options = {}) {
        if (hooks.setParams) {
          const result = hooks.setParams(next, options);
          if (result === false) return false;
          // 'defer' models the production tracking latch: the layer ACCEPTS the
          // request and holds it pending, but getParams() keeps reporting the
          // previous (still-untracked) value until the subject really arrives.
          if (result === 'defer') return true;
        }
        params = { ...params, ...next };
        return true;
      },
      /** Test seam: a deferred subject finally arrives on a later poll. */
      _arrive(next) { params = { ...params, ...next }; },
      getParams() { return { ...params }; },
      ...(hooks.cancelPendingTrackingRestore ? {
        cancelPendingTrackingRestore(options) { hooks.cancelPendingTrackingRestore(options); },
      } : {}),
    } : {}),
  };
}

function productionManager(hooksById = {}) {
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS) manager.register(fakeLayer(id, hooksById[id] || {}));
  manager.finalizeRegistrations(LAYER_STATE_REGISTRY);
  return manager;
}

/**
 * Deterministic clock + timer queue for the pending-tracking window, so the
 * 90 s / 45 s / 300 s expiries are provable without sleeping.
 */
function manualTimers(startMs = 0) {
  let nowMs = startMs;
  let queued = null;
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => { queued = { fn, ms }; return queued; },
    clearTimer: (handle) => { if (queued === handle) queued = null; },
    /** Fire queued polls, advancing the clock, until nothing re-arms. */
    runUntilIdle(maxTicks = 2_000) {
      for (let tick = 0; tick < maxTicks; tick += 1) {
        const pending = queued;
        if (!pending) return;
        queued = null;
        nowMs += pending.ms;
        pending.fn();
      }
      throw new Error('pending-tracking watch never settled');
    },
  };
}

function memoryStorage(initial = null) {
  const values = new Map();
  if (initial !== null) values.set(LAYER_STATE_STORAGE_KEY, initial);
  return {
    writes: [],
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      values.set(key, value);
      this.writes.push([key, value]);
    },
  };
}

function shareSink() {
  return {
    provider: null,
    updates: 0,
    setLayerStateProvider(provider) { this.provider = provider; },
    onLayerStateChange() { this.updates += 1; },
  };
}

function encode(state) {
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(params, state);
  return params.toString();
}

test('production registry is exact, canonical, and rejects incomplete contracts', async () => {
  assert.equal(validateLayerStateRegistry(), true);
  assert.equal(REGISTERED_LAYER_IDS.length, 16);
  assert.equal(new Set(REGISTERED_LAYER_IDS).size, 16);
  assert.deepEqual(REGISTERED_LAYER_IDS, [...REGISTERED_LAYER_IDS].sort());
  assert.throws(
    () => validateLayerStateRegistry([...LAYER_STATE_REGISTRY, LAYER_STATE_REGISTRY[0]]),
    /Duplicate layer-state id/,
  );

  const manager = new DataLayerManager({});
  manager.register(fakeLayer('earthquakes'));
  assert.throws(() => manager.register(fakeLayer('earthquakes')), /Duplicate data-layer id/);
  await assert.rejects(manager.restoreLayerState('earthquakes', { enabled: true }), /finalized/);
  assert.throws(() => manager.finalizeRegistrations([]), /registry mismatch/);
  assert.throws(
    () => manager.finalizeRegistrations([{ id: 'earthquakes', disposition: 'default' }]),
    /Invalid layer serialization disposition/,
  );
  assert.equal(manager.finalizeRegistrations([
    { id: 'earthquakes', disposition: 'enabled-only' },
  ]), true);
  assert.throws(() => manager.register(fakeLayer('radio')), /finalized/);
  assert.throws(() => manager.registerForQa(fakeLayer('radio')), /not authorized/);
  const qaManager = new DataLayerManager({}, { allowQaRegistration: true });
  qaManager.register(fakeLayer('earthquakes'));
  qaManager.finalizeRegistrations([{ id: 'earthquakes', disposition: 'enabled-only' }]);
  qaManager.registerForQa(fakeLayer('radio'));
  assert.equal(qaManager.layers.has('radio'), true);
  assert.equal(await qaManager.unregisterForQa('radio'), true);
  assert.equal(qaManager.layers.has('radio'), false);
});

test('v2 codec distinguishes absent from empty and keeps canonical deterministic ordering', () => {
  assert.equal(decodeLayerStateParams(new URLSearchParams('lat=1&lon=2')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=1&l=e')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=3&l=e')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2')), null);

  const empty = decodeLayerStateParams(new URLSearchParams('v=2&l='));
  assert.deepEqual(empty.enabledLayerIds, []);
  assert.deepEqual(empty.options.cctv, {
    coverageMode: 'on',
    showProjection: true,
    autoHop: false,
  });

  const first = normalizeLayerState({
    enabledLayerIds: ['traffic', 'cctv', 'earthquakes', 'cctv'],
    options: {
      radio: { volume: 0.37, filter: 'news' },
      cctv: { autoHop: true, coverageMode: 'viewshed', showProjection: false },
      flights: { models3dMode: 'all', models3d: true },
      satellites: { catalog: 'dense' },
    },
  });
  const second = normalizeLayerState({
    enabledLayerIds: ['earthquakes', 'cctv', 'traffic'],
    options: {
      satellites: { catalog: 'dense' },
      flights: { models3d: true, models3dMode: 'all' },
      cctv: { showProjection: false, coverageMode: 'viewshed', autoHop: true },
      radio: { filter: 'news', volume: 0.37 },
    },
  });
  assert.equal(encode(first), encode(second));
  assert.deepEqual(decodeLayerStateParams(new URLSearchParams(encode(first))), first);
});

test('unknown enabled-layer tokens reject the payload instead of becoming an empty set', () => {
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2&l=z')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2&l=c.z')), null);
});

test('unknown and forbidden option fields are ignored while missing options use codec defaults', () => {
  const decoded = decodeLayerStateParams(new URLSearchParams(
    'v=2&l=c.e&lo=c.c.v_c.z.1_z.c.1_f.e.1_f.m.a_r.f.n_r.v.35',
  ));
  assert.deepEqual(decoded.enabledLayerIds, ['cctv', 'earthquakes']);
  assert.deepEqual(decoded.options.cctv, {
    coverageMode: 'viewshed',
    showProjection: true,
    autoHop: false,
  });
  assert.deepEqual(decoded.options.flights, {
    models3d: true,
    models3dMode: 'all',
    selectedFlightsTrackingId: null,
    selectedMilitaryTrackingId: null,
  });
  assert.deepEqual(decoded.options.radio, { filter: 'news', volume: 0.35 });

  const raw = normalizeLayerState({
    enabledLayerIds: ['cctv', 'unknown-layer'],
    options: {
      cctv: {
        coverageMode: 'off',
        selectedCameraId: 'private-camera',
        calibrationMode: true,
        calibration: { secret: 'do-not-share' },
        autoHopSec: 99,
      },
      flights: { models3d: true, irBoost: true },
      satellites: { catalog: 'dense', showPoints: false, showOrbits: false },
      radio: {
        filter: 'genre:ambient',
        volume: 0.66,
        selectedStationId: 'private-station',
        audioState: 'playing',
        voiceDucked: true,
      },
    },
  });
  const serialized = `${encode(raw)} ${serializeStoredLayerState(raw)}`;
  for (const forbidden of [
    'private-camera', 'calibration', 'autoHopSec', 'irBoost', 'showPoints',
    'showOrbits', 'private-station', 'audioState', 'voiceDucked', 'secret',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('Radio genre ids with spaces and ampersands round-trip through v2', () => {
  for (const filter of ['genre:hip hop', 'genre:r&b']) {
    const state = normalizeLayerState({
      enabledLayerIds: ['radio'],
      options: { radio: { filter, volume: 0.5 } },
    });
    const decoded = decodeLayerStateParams(new URLSearchParams(encode(state)));
    assert.equal(decoded.options.radio.filter, filter);
  }
});

test('mirrored option owners decode into the owner owner-options bucket', () => {
  const decoded = decodeLayerStateParams(new URLSearchParams(
    'v=2&l=f.m&lo=m.u.xyz',
  ));
  assert.deepEqual(decoded.enabledLayerIds, ['flights', 'military']);
  assert.equal(decoded.options.flights.selectedFlightsTrackingId, null);
  assert.equal(decoded.options.flights.selectedMilitaryTrackingId, 'xyz');
});

test('ambiguous cross-family tracking IDs fail closed instead of racing feed arrival', () => {
  const decoded = decodeLayerStateParams(new URLSearchParams(
    'v=2&l=f.m.s&lo=f.t.flightA_f.u.militaryB_s.t.25544',
  ));
  assert.deepEqual(decoded.enabledLayerIds, ['flights', 'military', 'satellites']);
  assert.equal(decoded.options.flights.selectedFlightsTrackingId, null);
  assert.equal(decoded.options.flights.selectedMilitaryTrackingId, null);
  assert.equal(decoded.options.satellites.selectedSatTrackingId, null);

  const canonical = encodeLayerStateParams(new URLSearchParams('v=2'), decoded);
  assert.equal(canonical.has('lo'), false);
});

test('compact URL omits absent-meaning option state and still resolves to it', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights', 'satellites'];
  // Spelled out rather than reused from createDefaultLayerState() on purpose:
  // this is the ledger of what an OMITTED token means, so changing any of these
  // fails HERE and forces the change to be acknowledged.
  //
  // Note this is the absent-meaning ledger, NOT the default ledger — the two
  // diverged for `models3d` on 2026-08-22. Its default moved to `true`, but an
  // omitted `e` still means `false` because that is what schema v2 has always
  // meant to the links already in the wild, so `false` is what belongs in a
  // URL-omission test. The default's own value is pinned in the fresh-boot test
  // below, and the divergence itself in the two codec tests above.
  state.options.flights = { models3d: false, models3dMode: 'proximity', selectedFlightsTrackingId: null, selectedMilitaryTrackingId: null };
  state.options.satellites = { catalog: 'core', showPoints: true, showOrbits: true, selectedSatTrackingId: null };
  const params = encodeLayerStateParams(new URLSearchParams('v=2'), state);
  assert.equal(params.has('lo'), false);
  const roundTrip = decodeLayerStateParams(params);
  assert.equal(roundTrip.options.flights.models3d, false);
  assert.equal(roundTrip.options.flights.models3dMode, 'proximity');
  assert.deepEqual(roundTrip.options.flights.selectedFlightsTrackingId, null);
  assert.deepEqual(roundTrip.options.flights.selectedMilitaryTrackingId, null);
  assert.deepEqual(roundTrip.options.satellites.selectedSatTrackingId, null);
});

test('a fresh boot starts 3D aircraft ON in proximity — codec, both layers, and the rail agree', async () => {
  // Product invariant 2026-08-22: the DISPLAY-rail 3D toggle defaults ON with mode
  // `proximity`, because proximity is itself the budget — models materialize only
  // below the fleet altitude ceiling and only for the nearest MODEL_MAX in view,
  // so "on" costs nothing at globe scale and `all` stays a deliberate opt-in.
  //
  // The reason this is one test rather than four is the early return in `start()`
  // below: with no share payload and no stored state, restoration NEVER RUNS, so
  // nothing pushes the codec default into the layers. Four independent
  // initializers decide what a first-run operator actually sees, and changing any
  // one alone ships a lit button over an unarmed layer, or an armed layer under a
  // dark button. Pinning them together is what makes "state and UI agree" a fact.
  const defaults = createDefaultLayerState().options.flights;
  assert.equal(defaults.models3d, true, 'the durable default is 3D ON');
  assert.equal(defaults.models3dMode, 'proximity', 'and proximity, never all');

  const paramsCalls = [];
  const manager = productionManager({
    flights: { setParams: (params) => { paramsCalls.push({ ...params }); return true; } },
    military: { setParams: (params) => { paramsCalls.push({ ...params }); return true; } },
  });
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  await coordinator.start();
  assert.equal(coordinator.source, 'defaults');
  assert.equal(coordinator.getDurableState().options.flights.models3d, true);
  assert.equal(coordinator.getDurableState().options.flights.models3dMode, 'proximity');
  assert.deepEqual(paramsCalls, [],
    'a fresh boot restores nothing — which is exactly why the module initializers below must match');
  coordinator.destroy();

  // The other three surfaces, read from source, because each is the literal a
  // first-run session actually boots from.
  const { readFile } = await import('node:fs/promises');
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.match(source, /^let _models3dEnabled = true;$/m,
      `${name}: the fleet starts armed, matching the codec default`);
    assert.match(source, /^let _models3dMode = 'proximity';/m,
      `${name}: and starts in proximity, matching the codec default`);
  }
  const ui = await readFile(new URL('../ui.js', import.meta.url), 'utf8');
  assert.match(ui, /^\s*this\._models3dEnabled = true;$/m,
    'ui.js: the DISPLAY rail believes 3D is on before any layer-state sync arrives');
  assert.match(ui, /this\._models3dMode = 'proximity';/,
    'ui.js: and believes the mode is proximity');
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /class="pp-toggle-btn active" id="models3d-toggle" aria-pressed="true"/,
    'index.html: the 3D button paints lit on first paint, before ui.js runs — and says so');
  assert.match(ui, /this\._models3dBtn\?\.setAttribute\('aria-pressed', String\(this\._models3dEnabled\)\)/,
    'ui.js: and keeps aria-pressed synchronized, so the lit state is not colour-only');
  assert.match(html, /class="pp-slider-row visible" id="models3d-mode-row"/,
    'index.html: and the Proximity/All row paints open with it');
  assert.match(html, /id="models3d-mode-proximity"[^>]*aria-checked="true"/,
    'index.html: Proximity is the selected mode in the markup');
});

test('a v2 link written before the flip still means what its author saw: 3D OFF', () => {
  // The regression this pins, caught in review: schema v2 shipped with 3D OFF as
  // the OMITTED default, so every link already in the wild says "off" by saying
  // nothing. Moving the default without moving the codec turned all of them ON —
  // the same omission meaning two different things inside one schema version.
  //
  // `v=2&l=f` is the canonical parent-era link. It must decode OFF forever.
  const parentEra = decodeLayerStateParams(new URLSearchParams('v=2&l=f'));
  assert.equal(parentEra.options.flights.models3d, false,
    'an omitted `e` is a v2 author saying OFF, not "whatever today\'s default is"');

  // The nastier one: an OFF link that DID remember a non-default mode. Reading
  // the omission as the new default would resurrect it as ON + All.
  const parentEraAll = decodeLayerStateParams(new URLSearchParams('v=2&l=f&lo=f.m.a'));
  assert.equal(parentEraAll.options.flights.models3d, false);
  assert.equal(parentEraAll.options.flights.models3dMode, 'all',
    'the mode it really carried survives; only the omission is read as OFF');

  // A parent-era link that carried 3D ON wrote it explicitly (ON was non-default
  // then), so it still restores ON. Both eras round-trip.
  assert.equal(
    decodeLayerStateParams(new URLSearchParams('v=2&l=f&lo=f.e.1')).options.flights.models3d,
    true,
  );
});

test('the new default is written EXPLICITLY, so no omission is ambiguous', () => {
  // Because an absent `e` is pinned to the historical OFF above, the new ON
  // default cannot ride in on the omission — it has to be emitted. This is the
  // other half of the same invariant: break it and fresh ON links silently become
  // OFF links for their recipients.
  const on = createDefaultLayerState();
  on.enabledLayerIds = ['flights'];
  assert.equal(on.options.flights.models3d, true, 'precondition: ON is the default');
  const onEncoded = encode(on);
  assert.match(onEncoded, /(^|&)lo=[^&]*f\.e\.1/,
    'a fresh ON link states ON outright rather than relying on omission');
  assert.equal(decodeLayerStateParams(new URLSearchParams(onEncoded)).options.flights.models3d, true);

  // And OFF is the omission, matching what v2 already meant — one meaning, one
  // encoding, across both eras.
  const off = createDefaultLayerState();
  off.enabledLayerIds = ['flights'];
  off.options.flights = { ...off.options.flights, models3d: false };
  const offEncoded = encode(off);
  assert.doesNotMatch(offEncoded, /f\.e\./,
    'OFF is the absent token, exactly as it was before the flip');
  assert.equal(decodeLayerStateParams(new URLSearchParams(offEncoded)).options.flights.models3d, false);

  // An interim build briefly emitted `f.e.0`; it must still decode as OFF.
  assert.equal(
    decodeLayerStateParams(new URLSearchParams('v=2&l=f&lo=f.e.0')).options.flights.models3d,
    false,
  );
});

test('a share link that carries 3D OFF still restores OFF at both aircraft layers', async () => {
  // The 2026-08-22 default governs FRESH sessions only. It must never overwrite a
  // choice a link states — and after the codec fix above, OFF is stated by the
  // absent token, which is what v2 always meant.
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights', 'military'];
  state.options.flights = { ...state.options.flights, models3d: false };
  const encoded = encode(state);

  const decoded = decodeLayerStateParams(new URLSearchParams(encoded));
  assert.equal(decoded.options.flights.models3d, false, 'the link decodes back to OFF');
  assert.equal(decoded.options.flights.models3dMode, 'proximity');

  // And the restore really pushes OFF at both aircraft layers — `military`
  // mirrors the `flights` option owner, so one shared link disarms both.
  const calls = { flights: [], military: [] };
  const manager = productionManager({
    flights: { setParams: (params) => { calls.flights.push({ ...params }); return true; } },
    military: { setParams: (params) => { calls.military.push({ ...params }); return true; } },
  });
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  await coordinator.start({ shareLayerState: decoded, shareCreatedAtMs: 1_000 });
  assert.deepEqual(calls.flights, [{ models3d: false, models3dMode: 'proximity' }]);
  assert.deepEqual(calls.military, [{ models3d: false, models3dMode: 'proximity' }]);
  assert.equal(coordinator.getDurableState().options.flights.models3d, false);
  coordinator.destroy();
});

test('explicit navigation tracking clear removes the active durable ID from the generated hash', async () => {
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  await coordinator.start();
  await manager.setEnabled('flights', true, { origin: 'user' });
  manager.setLayerParams('flights', { selectedFlightsTrackingId: 'abc123' }, { origin: 'user' });
  assert.equal(coordinator.getDurableState().options.flights.selectedFlightsTrackingId, 'abc123');
  assert.equal(encode(coordinator.getDurableState()).includes('abc123'), true);
  manager.setLayerParams('flights', { selectedFlightsTrackingId: null }, { origin: 'tool' });
  assert.equal(coordinator.getDurableState().options.flights.selectedFlightsTrackingId, null);
  assert.equal(encode(coordinator.getDurableState()).includes('abc123'), false);
  coordinator.destroy();
});

test('a direct Context selection promotes its owned tracker layer before persisting the ID', async () => {
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  await coordinator.start();
  await manager.setEnabled('flights', true, { origin: 'programmatic' });
  manager.setLayerParams(
    'flights',
    { selectedFlightsTrackingId: 'context-flight' },
    { origin: 'programmatic' },
  );
  assert.equal(manager.adoptLayerVisibility('flights', true, {
    origin: 'user',
    adoptedFromSelection: true,
  }), true);
  assert.equal(manager.adoptLayerParams(
    'flights',
    { selectedFlightsTrackingId: 'context-flight' },
    { origin: 'user' },
  ), true);
  const durable = coordinator.getDurableState();
  assert.equal(durable.enabledLayerIds.includes('flights'), true);
  assert.equal(durable.options.flights.selectedFlightsTrackingId, 'context-flight');
  assert.equal(encode(durable).includes('context-flight'), true);
  coordinator.destroy();
});

test('explicit Flight to Satellite replacement keeps the new Satellite ID durable', async () => {
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  await coordinator.start();
  await manager.setEnabled('flights', true, { origin: 'user' });
  await manager.setEnabled('satellites', true, { origin: 'user' });
  manager.setLayerParams('flights', { selectedFlightsTrackingId: 'abc123' }, { origin: 'user' });
  assert.equal(coordinator.getDurableState().options.flights.selectedFlightsTrackingId, 'abc123');

  // UI replacement ordering clears the prior family before a direct tracker
  // publishes its already-applied selection through adoptLayerParams().
  manager.setLayerParams('flights', { selectedFlightsTrackingId: null }, { origin: 'user' });
  manager.setLayerParams('satellites', { selectedSatTrackingId: 25544 }, { origin: 'programmatic' });
  assert.equal(manager.adoptLayerParams(
    'satellites',
    { selectedSatTrackingId: 25544 },
    { origin: 'user' },
  ), true);

  const durable = coordinator.getDurableState();
  assert.equal(durable.options.flights.selectedFlightsTrackingId, null);
  assert.equal(durable.options.flights.selectedMilitaryTrackingId, null);
  assert.equal(durable.options.satellites.selectedSatTrackingId, 25544);
  assert.equal(new URLSearchParams(encode(durable)).get('lo')?.includes('s.t.25544'), true);
  coordinator.destroy();
});

test('explicit layer OFF clears its durable selected entity and prevents later resurrection', async () => {
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  await coordinator.start();
  await manager.setEnabled('flights', true, { origin: 'user' });
  manager.setLayerParams('flights', { selectedFlightsTrackingId: 'abc123' }, { origin: 'user' });
  assert.equal(coordinator.getDurableState().options.flights.selectedFlightsTrackingId, 'abc123');
  await manager.setEnabled('flights', false, { origin: 'user' });
  assert.equal(coordinator.getDurableState().options.flights.selectedFlightsTrackingId, null);
  assert.equal(Boolean(
    new URLSearchParams(encode(coordinator.getDurableState())).get('lo')?.includes('f.t.'),
  ), false);
  coordinator.destroy();
});

test('unrelated explicit params retain the family live active ID while cancelling only pending state', async () => {
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  await coordinator.start();
  assert.equal(manager.setLayerParams('flights', {
    selectedFlightsTrackingId: 'active001',
  }, { origin: 'programmatic' }), true);
  await manager.setEnabled('flights', true, { origin: 'user' });
  assert.equal(manager.setLayerParams('flights', {
    models3d: true,
  }, { origin: 'user' }), true);
  assert.equal(
    coordinator.getDurableState().options.flights.selectedFlightsTrackingId,
    'active001',
  );
  coordinator.destroy();
});

test('stored state is deterministic, rejects other versions, and stays within a tested URL bound', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = [...REGISTERED_LAYER_IDS].reverse();
  state.options.flights = { models3d: true, models3dMode: 'all' };
  state.options.satellites = { catalog: 'dense' };
  state.options.cctv = { coverageMode: 'viewshed', showProjection: false, autoHop: true };
  state.options.radio = { filter: 'genre:experimental-ambient', volume: 1 };
  const stored = serializeStoredLayerState(state);
  assert.deepEqual(parseStoredLayerState(stored), normalizeLayerState(state));
  assert.equal(parseStoredLayerState('{"v":1,"l":[]}'), null);
  assert.ok(encode(state).length < 420, encode(state));
});

test('restore applies sanitized params after init and before enable', async () => {
  const order = [];
  const manager = productionManager({
    flights: {
      init: () => { order.push('init'); return true; },
      setParams: () => { order.push('params'); return true; },
      enable: () => { order.push('enable'); return true; },
      update: () => { order.push('update'); return true; },
    },
  });
  const outcome = await manager.restoreLayerState('flights', {
    enabled: true,
    params: { models3d: true, models3dMode: 'all' },
  }, { origin: 'share-restore' });
  assert.deepEqual(order, ['init', 'params', 'enable', 'update']);
  assert.equal(outcome.succeeded, true);
  assert.equal(outcome.persistenceWrite, false);
  assert.deepEqual(outcome.appliedOptions, { models3d: true, models3dMode: 'all' });
});

test('manager forwards passive restore origin into module parameter application', async () => {
  const seen = [];
  const manager = productionManager({
    flights: {
      setParams: (_params, options) => { seen.push(options); },
    },
  });
  await manager.restoreLayerState('flights', {
    enabled: false,
    params: { selectedFlightsTrackingId: 'abc123' },
  }, { origin: 'share-restore' });
  assert.deepEqual(seen, [{ origin: 'share-restore', paramsIntentEpoch: 1 }]);
});

test('explicit manager params and visibility revoke module-owned pending tracking restore', async () => {
  const cancellations = [];
  const manager = productionManager({
    flights: {
      cancelPendingTrackingRestore: (options) => { cancellations.push(options); },
    },
  });

  await manager.restoreLayerState('flights', {
    enabled: false,
    params: { selectedFlightsTrackingId: 'late001' },
  }, { origin: 'share-restore' });
  assert.deepEqual(cancellations, [], 'passive restoration cannot cancel itself');

  manager.setLayerParams('flights', { models3d: true }, { origin: 'voice' });
  await manager.setEnabled('flights', false, { origin: 'user' });
  assert.deepEqual(cancellations, [
    { origin: 'voice', reason: 'explicit-params' },
    { origin: 'user', reason: 'explicit-visibility' },
  ]);
});

test('share payload wins over local, passive restore writes nothing, and explicit success persists', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['traffic'];
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const share = shareSink();
  const coordinator = new LayerStateCoordinator(manager, share, { storage });
  const explicitEmpty = createDefaultLayerState();
  await coordinator.start({ shareLayerState: explicitEmpty });

  assert.equal(coordinator.source, 'share');
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, []);
  assert.deepEqual(storage.writes, []);
  assert.equal(share.provider().enabledLayerIds.length, 0);

  await manager.setEnabled('earthquakes', true, { origin: 'user' });
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, ['earthquakes']);
  assert.equal(storage.writes.length, 1);

  await manager.setEnabled('traffic', true, { origin: 'scene' });
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, ['earthquakes']);

  await manager.setEnabled('traffic', true, { origin: 'tool' });
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, ['earthquakes', 'traffic']);

  manager.setLayerParams('cctv', { selectedCameraId: 'private-camera' }, { origin: 'user' });
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(coordinator.getDurableState().options.cctv, {
    coverageMode: 'on',
    showProjection: true,
    autoHop: false,
  });

  manager.setLayerParams('cctv', { coverageMode: 'off' }, { origin: 'scene' });
  assert.equal(storage.writes.length, 2);
  assert.equal(coordinator.getDurableState().options.cctv.coverageMode, 'on');

  manager.setLayerParams('cctv', { coverageMode: 'viewshed' }, { origin: 'voice' });
  assert.equal(storage.writes.length, 3);
  assert.equal(coordinator.getDurableState().options.cctv.coverageMode, 'viewshed');
  coordinator.destroy();
});

test('absent share payload restores local state without rewriting it', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['earthquakes', 'radio'];
  local.options.radio = { filter: 'talk', volume: 0.42 };
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage });
  const results = await coordinator.start();
  assert.equal(coordinator.source, 'local');
  assert.equal(manager.isEnabled('earthquakes'), true);
  assert.equal(manager.isEnabled('radio'), true);
  assert.deepEqual(manager.getLayerParams('radio'), {
    filter: 'talk',
    volume: 0.42,
    selectedStationId: 'private-station',
    audioState: 'playing',
    voiceDucked: true,
  });
  assert.equal(results.every((result) => result.persistenceWrite === false), true);
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('historical share payload suppresses unrelated local layer preferences', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['traffic', 'radio'];
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage });
  await coordinator.start({ allowLocalState: false });
  assert.equal(coordinator.source, 'legacy-share');
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, []);
  assert.equal(manager.getEnabledLayerIds().size, 0);
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('one layer failure is isolated from sibling restoration', async () => {
  const manager = productionManager({
    cctv: { init: () => { throw new Error('missing key'); } },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['cctv', 'earthquakes'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  const results = await coordinator.start({ shareLayerState: state });
  assert.equal(manager.isEnabled('cctv'), false);
  assert.equal(manager.isEnabled('earthquakes'), true);
  const failed = results.find((result) => result.layerId === 'cctv');
  assert.equal(failed.succeeded, false);
  assert.equal(failed.phase, 'init');
  assert.equal(failed.errorClass, 'Error');
  assert.equal(failed.error, 'missing key');
  assert.equal(results.find((result) => result.layerId === 'earthquakes').succeeded, true);
  coordinator.destroy();
});

test('later explicit visibility during delayed restore wins for that layer only', async () => {
  const gate = deferred();
  const manager = productionManager();
  const storage = memoryStorage();
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['radio', 'earthquakes'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
    restoreGate: gate.promise,
  });
  const restore = coordinator.start({ shareLayerState: state });
  await manager.setEnabled('radio', false, { origin: 'user' });
  gate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('radio'), false);
  assert.equal(manager.isEnabled('earthquakes'), true);
  assert.equal(results.find((result) => result.layerId === 'radio').cancellationReason, 'superseded');
  assert.equal(storage.writes.length, 1);
  coordinator.destroy();
});

test('share restore waits for a superseding same-target visibility successor', async () => {
  const firstUpdateStarted = deferred();
  const releaseFirstUpdate = deferred();
  const secondUpdateStarted = deferred();
  const releaseSecondUpdate = deferred();
  let updateCount = 0;
  const manager = productionManager({
    radio: {
      update: async () => {
        updateCount += 1;
        if (updateCount === 1) {
          firstUpdateStarted.resolve();
          await releaseFirstUpdate.promise;
        } else if (updateCount === 2) {
          secondUpdateStarted.resolve();
          await releaseSecondUpdate.promise;
        }
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['radio'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });

  let restoreSettled = false;
  const restore = coordinator.start({ shareLayerState: state })
    .then((result) => { restoreSettled = true; return result; });
  await firstUpdateStarted.promise;
  let successorSettled = false;
  const explicitOn = manager.setEnabled('radio', true, { origin: 'user' })
    .then((result) => { successorSettled = true; return result; });
  releaseFirstUpdate.resolve();
  await secondUpdateStarted.promise;
  await Promise.resolve();
  assert.equal(restoreSettled, false, 'aggregate must wait for the authoritative successor');
  assert.equal(successorSettled, false);

  releaseSecondUpdate.resolve();
  assert.equal(await explicitOn, true);
  const results = await restore;
  const radio = results.find((result) => result.layerId === 'radio');
  assert.equal(radio.cancellationReason, 'superseded');
  assert.equal(radio.successorEnabled, true);
  assert.equal(radio.authoritativeIntentEpoch, radio.successorIntentEpoch);
  assert.equal(radio.authoritativeEnabled, true);
  assert.equal(radio.succeeded, true);
  assert.equal(manager.getLayerLifecycleState('radio').lifecycleState, 'enabled');
  coordinator.destroy();
});

test('share restore waits for a superseding opposite-target visibility successor', async () => {
  const updateStarted = deferred();
  const releaseUpdate = deferred();
  const disableStarted = deferred();
  const releaseDisable = deferred();
  const manager = productionManager({
    radio: {
      update: async () => {
        updateStarted.resolve();
        await releaseUpdate.promise;
        return true;
      },
      disable: async () => {
        disableStarted.resolve();
        await releaseDisable.promise;
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['radio'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });

  let restoreSettled = false;
  const restore = coordinator.start({ shareLayerState: state })
    .then((result) => { restoreSettled = true; return result; });
  await updateStarted.promise;
  const explicitOff = manager.setEnabled('radio', false, { origin: 'user' });
  releaseUpdate.resolve();
  await disableStarted.promise;
  await Promise.resolve();
  assert.equal(restoreSettled, false, 'aggregate must wait for the OFF successor to settle');

  releaseDisable.resolve();
  assert.equal(await explicitOff, true);
  const results = await restore;
  const radio = results.find((result) => result.layerId === 'radio');
  assert.equal(radio.cancellationReason, 'superseded');
  assert.equal(radio.successorEnabled, false);
  assert.equal(radio.authoritativeIntentEpoch, radio.successorIntentEpoch);
  assert.equal(radio.authoritativeEnabled, false);
  assert.equal(radio.succeeded, false, 'the newer OFF must not count as successful shared ON');
  assert.equal(manager.getLayerLifecycleState('radio').lifecycleState, 'disabled');
  coordinator.destroy();
});

test('later explicit params during init replace options without cancelling visibility', async () => {
  const initGate = deferred();
  const initStarted = deferred();
  const manager = productionManager({
    flights: {
      init: async () => {
        initStarted.resolve();
        await initGate.promise;
        return true;
      },
    },
  });
  const storage = memoryStorage();
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights'];
  state.options.flights = {
    models3d: true,
    models3dMode: 'all',
    selectedFlightsTrackingId: 'late001',
  };
  const share = shareSink();
  const coordinator = new LayerStateCoordinator(manager, share, { storage });
  const restore = coordinator.start({ shareLayerState: state });
  await initStarted.promise;
  assert.equal(manager.setLayerParams('flights', {
    models3d: false,
    models3dMode: 'proximity',
  }, { origin: 'user' }), true);
  initGate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('flights'), true);
  assert.deepEqual(coordinator.getDurableState().options.flights, {
    models3d: false,
    models3dMode: 'proximity',
    selectedFlightsTrackingId: null,
    selectedMilitaryTrackingId: null,
  });
  assert.equal(results.find((result) => result.layerId === 'flights').succeeded, true);
  assert.equal(storage.writes.length, 1);
  assert.equal(
    new URLSearchParams(encode(share.provider())).get('lo')?.includes('f.t.late001') || false,
    false,
  );
  coordinator.destroy();
});

test('explicit navigation preserves unrelated visibility and option restoration', async () => {
  const initGate = deferred();
  const initStarted = deferred();
  const paramsCalls = [];
  const manager = productionManager({
    flights: {
      init: async () => {
        initStarted.resolve();
        await initGate.promise;
        return true;
      },
      setParams: (params) => { paramsCalls.push(params); return true; },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights'];
  state.options.flights = {
    models3d: true,
    models3dMode: 'all',
    selectedFlightsTrackingId: 'stale-flight',
    selectedMilitaryTrackingId: null,
  };
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  const restore = coordinator.start({ shareLayerState: state });
  await initStarted.promise;
  // Navigation owns only camera and pending entity selection. It must not
  // revoke the layer visibility or unrelated display-option lanes.
  initGate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('flights'), true);
  assert.deepEqual(paramsCalls, [{
    models3d: true,
    models3dMode: 'all',
  }]);
  assert.equal(results.find((result) => result.layerId === 'flights').succeeded, true);
  coordinator.destroy();
});

test('startup gesture clears passive Follow but preserves slow layer and display options', async () => {
  const flightsInit = deferred();
  const flightsStarted = deferred();
  const radioInit = deferred();
  const radioStarted = deferred();
  const manager = productionManager({
    flights: {
      init: async () => {
        flightsStarted.resolve();
        await flightsInit.promise;
        return true;
      },
    },
    radio: {
      init: async () => {
        radioStarted.resolve();
        await radioInit.promise;
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights', 'radio'];
  state.options.flights = {
    models3d: true,
    models3dMode: 'all',
    selectedFlightsTrackingId: 'late-share',
    selectedMilitaryTrackingId: null,
  };
  state.options.radio = { filter: 'genre:r&b', volume: 0.42 };
  const storage = memoryStorage();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage });
  const restore = coordinator.start({ shareLayerState: state });
  await Promise.all([flightsStarted.promise, radioStarted.promise]);

  let cameraGeneration = 0;
  stampInitialShareGesture(({ cancelPendingSelection }) => {
    cameraGeneration += 1;
    if (cancelPendingSelection) {
      coordinator.cancelPendingShareTracking('startup-gesture', { clearSelection: true });
    }
  });
  flightsInit.resolve();
  radioInit.resolve();
  const results = await restore;

  assert.equal(cameraGeneration, 1);
  assert.equal(manager.isEnabled('flights'), true);
  assert.equal(manager.isEnabled('radio'), true);
  assert.deepEqual(manager.getLayerParams('flights'), {
    models3d: true,
    models3dMode: 'all',
    irBoost: true,
    selectedFlightsTrackingId: null,
  });
  assert.deepEqual(manager.getLayerParams('radio'), {
    filter: 'genre:r&b',
    volume: 0.42,
    selectedStationId: 'private-station',
    audioState: 'playing',
    voiceDucked: true,
  });
  assert.equal(results.find((result) => result.layerId === 'flights').succeeded, true);
  assert.equal(results.find((result) => result.layerId === 'radio').succeeded, true);
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('tracking restore refreshes the destination feed before the module resolves Follow', async () => {
  const order = [];
  const manager = productionManager({
    flights: {
      update: () => { order.push('refresh'); return true; },
      resolveTrackingRestoreTarget: (targetId, options) => {
        order.push(`resolve:${targetId}:${options.origin}`);
        return { status: 'found', source: 'test' };
      },
    },
  });
  await manager.setEnabled('flights', true, { origin: 'scene' });
  order.length = 0;
  const result = await manager.resolveLayerTrackingTarget('flights', 'abc123', {
    origin: 'share-restore',
  });
  assert.deepEqual(order, ['refresh', 'resolve:abc123:share-restore']);
  assert.equal(result.status, 'found');
  assert.equal(result.refreshSucceeded, true);
});

test('shared flight selection is deferred until destination refresh and then follows', async () => {
  const storage = memoryStorage();
  const statuses = [];
  const paramsCalls = [];
  const manager = productionManager({
    flights: {
      setParams: (params) => { paramsCalls.push({ ...params }); return true; },
      resolveTrackingRestoreTarget: (targetId) => ({ status: 'found', targetId }),
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights'];
  state.options.flights = {
    ...state.options.flights,
    models3d: true,
    selectedFlightsTrackingId: 'abc123',
  };
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
    onTrackingRestoreStatus: (status) => statuses.push(status),
  });
  await coordinator.start({ shareLayerState: state, shareCreatedAtMs: 1_000 });
  assert.deepEqual(paramsCalls, [{ models3d: true, models3dMode: 'proximity' }]);

  const result = await coordinator.restoreShareTrackingSelection();
  assert.equal(result.status, 'found');
  assert.equal(result.classification, 'followed');
  assert.equal(result.cleared, false);
  assert.equal(statuses.length, 1);
  assert.equal(coordinator.getDurableState().options.flights.selectedFlightsTrackingId, 'abc123');
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('authoritative missing target clears only the passive ID and uses strict expiry boundary', async () => {
  const run = async ({ nowMs, copiedAtMs }) => {
    const storage = memoryStorage();
    const manager = productionManager({
      flights: {
        resolveTrackingRestoreTarget: () => ({ status: 'missing' }),
        setParams: (next) => (
          Object.hasOwn(next, 'selectedFlightsTrackingId') && next.selectedFlightsTrackingId
            ? 'defer'
            : true
        ),
      },
    });
    const state = createDefaultLayerState();
    state.enabledLayerIds = ['flights'];
    state.options.flights = {
      ...state.options.flights,
      models3d: true,
      models3dMode: 'all',
      selectedFlightsTrackingId: 'gone001',
    };
    // The subject is absent, so the verdict now lands only after the pending
    // window has genuinely expired. Drive that window synchronously.
    const timers = manualTimers(nowMs);
    const statuses = [];
    const coordinator = new LayerStateCoordinator(manager, shareSink(), {
      storage,
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onTrackingRestoreStatus: (status) => statuses.push(status),
    });
    await coordinator.start({ shareLayerState: state, shareCreatedAtMs: copiedAtMs });
    const pending = await coordinator.restoreShareTrackingSelection();
    assert.equal(pending.classification, 'pending', 'absence must first be held pending');
    assert.equal(statuses.length, 1, 'pending is published for soft progress feedback');
    assert.equal(statuses[0].classification, 'pending');
    timers.runUntilIdle();
    const result = statuses.at(-1);
    const durable = coordinator.getDurableState();
    coordinator.destroy();
    return { result, durable, writes: storage.writes };
  };

  const boundary = await run({ nowMs: 190_000, copiedAtMs: 100_000 });
  assert.equal(boundary.result.classification, 'unavailable');
  assert.equal(boundary.result.cleared, true);
  assert.equal(boundary.durable.options.flights.selectedFlightsTrackingId, null);
  assert.equal(boundary.durable.options.flights.models3d, true);
  assert.equal(boundary.durable.options.flights.models3dMode, 'all');
  assert.deepEqual(boundary.writes, []);

  const expired = await run({ nowMs: 190_001, copiedAtMs: 100_000 });
  assert.equal(expired.result.classification, 'expired');
});

test('feed failure is not misreported as target absence and malformed time never says expired', async () => {
  const storage = memoryStorage();
  const statuses = [];
  const manager = productionManager({
    satellites: {
      resolveTrackingRestoreTarget: () => ({ status: 'source-unavailable', reason: 'partial catalog' }),
      setParams: (next) => (
        Object.hasOwn(next, 'selectedSatTrackingId') && next.selectedSatTrackingId
          ? 'defer'
          : true
      ),
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['satellites'];
  state.options.satellites = {
    ...state.options.satellites,
    selectedSatTrackingId: 25544,
  };
  const timers = manualTimers();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTrackingRestoreStatus: (status) => statuses.push(status),
  });
  await coordinator.start({ shareLayerState: state, shareCreatedAtMs: null });
  const pending = await coordinator.restoreShareTrackingSelection();
  // A partial catalog is a "not here YET" too — hold it, do not announce.
  assert.equal(pending.classification, 'pending');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].classification, 'pending');
  timers.runUntilIdle();
  const result = statuses.at(-1);
  assert.equal(result.status, 'source-unavailable');
  assert.equal(result.classification, 'source-unavailable');
  assert.equal(result.cleared, true);
  assert.equal(statuses.length, 2);
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

// ---------------------------------------------------------------------------
// Share restore must be as resilient as reload-from-local.
//
// Reload-from-local arms the layer's own deferred-restore latch, which
// re-attempts on every later poll, so a contact that misses the first refresh
// is still picked up. The shared path used to decide on that single refresh:
// it cleared the subject from durable state AND the URL and posted a failure
// notice seconds into startup, so the SAME link healed on reload but never on
// the share. These pin both directions.
// ---------------------------------------------------------------------------

function pendingTrackingFixture({ resolveStatus = 'missing', copiedAtMs = null } = {}) {
  const storage = memoryStorage();
  const statuses = [];
  const paramsCalls = [];
  const cancellations = [];
  const manager = productionManager({
    flights: {
      resolveTrackingRestoreTarget: () => ({ status: resolveStatus }),
      setParams: (next, options) => {
        paramsCalls.push({ params: { ...next }, origin: options?.origin });
        // Production holds the id pending; getParams keeps reporting untracked
        // until the subject actually arrives on a later poll.
        return Object.hasOwn(next, 'selectedFlightsTrackingId') && next.selectedFlightsTrackingId
          ? 'defer'
          : true;
      },
      cancelPendingTrackingRestore: (options) => cancellations.push(options),
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights'];
  state.options.flights = {
    ...state.options.flights,
    selectedFlightsTrackingId: 'late007',
  };
  const timers = manualTimers();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTrackingRestoreStatus: (status) => statuses.push(status),
  });
  return {
    manager,
    coordinator,
    statuses,
    storage,
    timers,
    state,
    copiedAtMs,
    paramsCalls,
    cancellations,
  };
}

test('share tracking policies pin each owner, key, label, and acquisition deadline', () => {
  assert.deepEqual(SHARE_TRACKING_RESTORE_POLICIES, {
    flights: {
      optionOwner: 'flights',
      optionKey: 'selectedFlightsTrackingId',
      expiryWindowMs: 90_000,
      label: 'flight',
    },
    military: {
      optionOwner: 'flights',
      optionKey: 'selectedMilitaryTrackingId',
      expiryWindowMs: 45_000,
      label: 'military flight',
    },
    satellites: {
      optionOwner: 'satellites',
      optionKey: 'selectedSatTrackingId',
      expiryWindowMs: 300_000,
      label: 'satellite',
    },
  });
});

test('a shared subject that has not arrived yet is held pending, never declared gone', async () => {
  const f = pendingTrackingFixture();
  await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
  const pending = await f.coordinator.restoreShareTrackingSelection();

  assert.equal(pending.status, 'pending');
  assert.equal(pending.classification, 'pending');
  assert.equal(pending.cleared, false);
  // No notice, and the subject survives in durable state AND in the URL.
  assert.equal(f.statuses.length, 1, 'a not-yet-arrived subject publishes progress');
  assert.equal(f.statuses[0].classification, 'pending');
  assert.equal(
    f.coordinator.getDurableState().options.flights.selectedFlightsTrackingId,
    'late007',
    'the shared subject must not be cleared while it is still pending',
  );
  // The layer's own deferred-restore latch was armed, under the passive origin.
  const armed = f.paramsCalls.filter((call) => call.params.selectedFlightsTrackingId === 'late007');
  assert.equal(armed.length, 1, 'the layer latch is armed exactly once');
  assert.equal(armed[0].origin, 'share-restore', 'arming must stay passive');
  assert.deepEqual(f.storage.writes, [], 'recipient preferences are never written');
  f.coordinator.destroy();
});

test('a pending shared subject latches on when it arrives on a later poll', async () => {
  const f = pendingTrackingFixture();
  await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
  await f.coordinator.restoreShareTrackingSelection();
  assert.equal(f.statuses.length, 1);
  assert.equal(f.statuses[0].classification, 'pending');

  // The contact shows up on a later feed poll, exactly as the layer latch would.
  f.manager.layers.get('flights').module._arrive({ selectedFlightsTrackingId: 'late007' });
  f.timers.runUntilIdle();

  assert.equal(f.statuses.length, 2);
  assert.equal(f.statuses[1].classification, 'followed');
  assert.equal(f.statuses[1].cleared, false);
  assert.equal(
    f.coordinator.getDurableState().options.flights.selectedFlightsTrackingId,
    'late007',
  );
  assert.deepEqual(f.storage.writes, []);
  f.coordinator.destroy();
});

test('caller abort after pending handoff revokes the watch and layer latch exactly once', async () => {
  const f = pendingTrackingFixture();
  const caller = new AbortController();
  await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
  const pending = await f.coordinator.restoreShareTrackingSelection({ signal: caller.signal });
  assert.equal(pending.classification, 'pending');

  caller.abort('caller-cancelled');
  f.timers.runUntilIdle();
  caller.abort('late-repeat');

  assert.deepEqual(f.statuses.map((status) => status.classification), ['pending', 'cancelled']);
  assert.equal(f.statuses[1].reason, 'caller-cancelled');
  assert.equal(f.cancellations.length, 1, 'the module latch is revoked exactly once');
  assert.equal(f.cancellations[0].reason, 'caller-cancelled');
  assert.equal(
    f.coordinator.getDurableState().options.flights.selectedFlightsTrackingId,
    'late007',
    'cancellation does not rewrite recipient state',
  );
  f.coordinator.destroy();
});

test('a failed deferred-latch arm publishes one terminal failure and never ACQUIRING', async () => {
  for (const armFailure of [
    () => false,
    () => Promise.reject(new Error('async latch rejection')),
    () => { throw new Error('sync latch throw'); },
  ]) {
    const f = pendingTrackingFixture();
    await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
    const setLayerParams = f.manager.setLayerParams.bind(f.manager);
    f.manager.setLayerParams = (layerId, params, options) => (
      params?.selectedFlightsTrackingId
        ? armFailure()
        : setLayerParams(layerId, params, options)
    );

    const result = await f.coordinator.restoreShareTrackingSelection();
    f.timers.runUntilIdle();

    assert.equal(result.status, 'source-unavailable');
    assert.equal(result.classification, 'source-unavailable');
    assert.equal(result.cleared, true);
    assert.deepEqual(
      f.statuses.map((status) => status.classification),
      ['source-unavailable'],
      'a rejected latch never publishes pending progress',
    );
    assert.equal(f.coordinator.getDurableState().options.flights.selectedFlightsTrackingId, null);
    f.coordinator.destroy();
  }
});

test('same-target supersession cancels the old acquisition before publishing the successor', async () => {
  const f = pendingTrackingFixture();
  await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
  await f.coordinator.restoreShareTrackingSelection();
  await f.coordinator.restoreShareTrackingSelection();

  assert.deepEqual(
    f.statuses.map((status) => status.classification),
    ['pending', 'cancelled', 'pending'],
  );
  assert.equal(f.cancellations.length, 1);
  f.coordinator.cancelPendingShareTracking('test-complete');
  f.coordinator.destroy();
});

test('destroying or superseding the coordinator clears pending progress explicitly', async () => {
  for (const teardown of [
    (coordinator) => coordinator.destroy(),
    (coordinator) => coordinator.cancelPendingShareTracking('explicit-navigation'),
    (coordinator) => coordinator.cancelPendingRestores('explicit-navigation'),
  ]) {
    const f = pendingTrackingFixture();
    await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
    await f.coordinator.restoreShareTrackingSelection();
    teardown(f.coordinator);
    f.timers.runUntilIdle();
    assert.deepEqual(
      f.statuses.map((status) => status.classification),
      ['pending', 'cancelled'],
      'an abandoned pending watch publishes the clear event exactly once',
    );
    f.coordinator.destroy();
  }
});

test('tracking resolver false and rejection stay source-unavailable while AbortError stays cancelled', async () => {
  const run = async (resolveTrackingRestoreTarget, { signal = null } = {}) => {
    const manager = productionManager({
      flights: { resolveTrackingRestoreTarget },
    });
    await manager.setEnabled('flights', true, { origin: 'scene' });
    return manager.resolveLayerTrackingTarget('flights', 'abc123', {
      origin: 'share-restore',
      signal,
    });
  };

  const semanticFalse = await run(() => false);
  assert.equal(semanticFalse.status, 'source-unavailable');

  const rejected = await run(() => Promise.reject(new Error('feed unavailable')));
  assert.equal(rejected.status, 'source-unavailable');
  assert.equal(rejected.reason, 'feed unavailable');

  const abortError = new Error('restore cancelled');
  abortError.name = 'AbortError';
  const cancelled = await run(() => Promise.reject(abortError));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.errorClass, 'AbortError');
});

test('late target resolution after coordinator destroy cannot clear state or publish status', async () => {
  const resolution = deferred();
  const statuses = [];
  const storage = memoryStorage();
  const manager = productionManager({
    flights: {
      resolveTrackingRestoreTarget: () => resolution.promise,
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights'];
  state.options.flights = {
    ...state.options.flights,
    selectedFlightsTrackingId: 'stale001',
  };
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
    onTrackingRestoreStatus: (status) => statuses.push(status),
  });
  await coordinator.start({ shareLayerState: state });
  const restore = coordinator.restoreShareTrackingSelection();
  coordinator.destroy();
  resolution.resolve({ status: 'missing' });
  const result = await restore;

  assert.equal(result.status, 'cancelled');
  assert.equal(statuses.length, 0);
  assert.equal(storage.writes.length, 0);
});

test('newer explicit tracked target cancels stale shared resolution without clearing the winner', async () => {
  const resolution = deferred();
  const storage = memoryStorage();
  const manager = productionManager({
    flights: {
      resolveTrackingRestoreTarget: async () => resolution.promise,
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['flights'];
  state.options.flights = {
    ...state.options.flights,
    selectedFlightsTrackingId: 'stale001',
  };
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage });
  await coordinator.start({ shareLayerState: state });
  const restore = coordinator.restoreShareTrackingSelection();
  manager.setLayerParams('flights', {
    selectedFlightsTrackingId: 'newer002',
  }, { origin: 'user' });
  resolution.resolve({ status: 'missing' });
  const result = await restore;
  assert.equal(result.status, 'cancelled');
  assert.equal(coordinator.getDurableState().options.flights.selectedFlightsTrackingId, 'newer002');
  assert.equal(storage.writes.length, 1);
  coordinator.destroy();
});

test('Radio durable params work before enable and never start playback', () => {
  assert.equal(radioLayer.setParams({ filter: 'news', volume: 0.33 }), true);
  assert.deepEqual(radioLayer.getParams(), { filter: 'news', volume: 0.33 });
  assert.equal(radioLayer.getUIState().audioState, 'stopped');
  assert.equal(radioLayer.getUIState().playingStationId, null);
  radioLayer.setParams({ filter: 'all', volume: 0.8 });
});

// ---------------------------------------------------------------------------
// Share IDs and payloads are untrusted input and must be BOUNDED.
//
// A tracking ID is a transponder address, not free text. Identity is never
// truncated to fit: half an address is a different aircraft, not a shorter name
// for the same one, so an out-of-grammar ID is rejected outright and an
// oversized payload fails closed exactly like an unknown layer token.
// ---------------------------------------------------------------------------

test('oversized and out-of-grammar tracking IDs are rejected, never truncated', () => {
  const huge = 'a'.repeat(100_000);

  // Normalization (the durable-state door).
  const normalized = normalizeLayerState({
    enabledLayerIds: ['flights'],
    options: { flights: { selectedFlightsTrackingId: huge } },
  });
  assert.equal(
    normalized.options.flights.selectedFlightsTrackingId,
    null,
    'a 100k-char ID must be rejected, not stored',
  );

  // Decoding (the untrusted-URL door).
  const decoded = decodeLayerStateParams(new URLSearchParams([
    ['v', '2'], ['l', 'f'], ['lo', `f.t.${huge}`],
  ]));
  assert.equal(decoded, null, 'an oversized lo payload fails closed');

  // A merely long-but-under-cap ID is still out of grammar, and rejected
  // WITHOUT taking the rest of the payload down with it.
  const longish = decodeLayerStateParams(new URLSearchParams([
    ['v', '2'], ['l', 'f'], ['lo', `f.e.1_f.t.${'b'.repeat(40)}`],
  ]));
  assert.deepEqual(longish.enabledLayerIds, ['flights']);
  assert.equal(longish.options.flights.selectedFlightsTrackingId, null);
  assert.equal(longish.options.flights.models3d, true, 'sibling options survive');

  for (const bad of ['ab cd', 'ab/cd', '../../etc', 'a'.repeat(17), '<script>', '']) {
    assert.equal(
      normalizeLayerState({
        enabledLayerIds: ['flights'],
        options: { flights: { selectedFlightsTrackingId: bad } },
      }).options.flights.selectedFlightsTrackingId,
      null,
      `out-of-grammar ID rejected: ${JSON.stringify(bad)}`,
    );
  }

  // Real addresses still round-trip untouched, including TIS-B forms.
  for (const good of ['aaa001', 'ae1fa4', '~ab1234', 'A1B2C3']) {
    const state = normalizeLayerState({
      enabledLayerIds: ['flights'],
      options: { flights: { selectedFlightsTrackingId: good } },
    });
    assert.equal(state.options.flights.selectedFlightsTrackingId, good.toLowerCase());
    const params = new URLSearchParams([['v', '2']]);
    encodeLayerStateParams(params, state);
    assert.equal(
      decodeLayerStateParams(params).options.flights.selectedFlightsTrackingId,
      good.toLowerCase(),
      `round-trip preserved: ${good}`,
    );
  }
});

test('an oversized enabled-layer field fails closed instead of decoding a prefix', () => {
  assert.equal(
    decodeLayerStateParams(new URLSearchParams([['v', '2'], ['l', 'f.'.repeat(5_000)]])),
    null,
  );
});

// ---------------------------------------------------------------------------
// The pending watch and the LAYER's deferred-restore latch are two halves of
// one mechanism and must die together.
//
// Aborting only the restore controller was a no-op by the time the watch
// existed (the controller has already settled), so the orphaned timer went on
// to announce "Shared … unavailable" at its deadline — a verdict about work
// nothing was attempting any more. Both paths below cancel the module latch in
// production: an explicit parameter replacement, and the owner layer going
// away (at any origin, including a programmatic disable).
// ---------------------------------------------------------------------------

test('an explicit parameter change revokes the pending watch, not just its controller', async () => {
  const f = pendingTrackingFixture();
  await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
  await f.coordinator.restoreShareTrackingSelection();
  assert.deepEqual(f.statuses.map((status) => status.classification), ['pending']);

  // The operator changes an unrelated Flights option. Production cancels the
  // module latch on exactly this event, so nothing is restoring any more.
  await f.manager.setLayerParams('flights', { models3d: true }, { origin: 'user' });
  f.timers.runUntilIdle();

  assert.deepEqual(
    f.statuses.map((status) => status.classification),
    ['pending', 'cancelled'],
    'a revoked restore clears progress without announcing a terminal failure',
  );
  f.coordinator.destroy();
});

test('the owner layer going away revokes the pending watch at any origin', async () => {
  for (const origin of ['programmatic', 'user']) {
    const f = pendingTrackingFixture();
    await f.coordinator.start({ shareLayerState: f.state, shareCreatedAtMs: f.copiedAtMs });
    await f.coordinator.restoreShareTrackingSelection();
    assert.deepEqual(f.statuses.map((status) => status.classification), ['pending']);

    await f.manager.setEnabled('flights', false, { origin });
    f.timers.runUntilIdle();

    assert.deepEqual(
      f.statuses.map((status) => status.classification),
      ['pending', 'cancelled'],
      `a disabled owner layer clears progress without a terminal failure (origin=${origin})`,
    );
    f.coordinator.destroy();
  }
});
