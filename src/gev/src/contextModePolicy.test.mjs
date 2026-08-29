import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cockpitEntryAllowed,
  contextAllowedLayerIds,
  contextLayerEnableBlockReason,
  contextRestoreLayerIds,
  isExplicitUserIntentOrigin,
  mergeContextTransitionErrors,
  contextSnapshotLayerIds,
  recordContextSessionUserChange,
  recordContextRestoreExplicitChange,
  runWithContextModeChanging,
  settleContextModeChange,
  settleContextIntentReplay,
  settleUserFacingContextAction,
  shouldCaptureContextSession,
  shouldDeferContextEntryDuringClear,
  shouldExitContextForLayerChange,
  spaceMissionEntryCancellationDisposition,
} from './contextModePolicy.js';

test('Context transition errors preserve primary identity and aggregate failed layers', () => {
  const primary = Object.assign(new Error('restore failed'), { failedLayerIds: ['flights'] });
  const replay = Object.assign(new Error('replay failed'), { failedLayerIds: ['radio'] });
  assert.equal(mergeContextTransitionErrors(primary, replay), primary);
  assert.deepEqual(primary.failedLayerIds, ['flights', 'radio']);
});

test('Context transition errors retain a production coordinator failure with replay details', () => {
  const coordinator = Object.assign(new Error('Contacts restore failed'), {
    failedLayerIds: ['military-awareness'],
  });
  const replay = Object.assign(new Error('Radio replay failed'), {
    failedLayerIds: ['radio'],
  });
  const merged = mergeContextTransitionErrors(coordinator, replay);
  assert.deepEqual(merged.failedLayerIds, ['military-awareness', 'radio']);
});

test('explicit Context replay reports rejection and fulfilled-false failures after every sibling settles', async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const rejection = new Error('replay rejected');
  const restoreState = {
    explicitLayerStates: new Map([
      ['radio', true],
      ['slow-companion', false],
    ]),
  };
  let settled = false;
  const replay = settleContextIntentReplay({
    restoreState,
    setEnabled: (layerId) => (layerId === 'radio' ? Promise.reject(rejection) : slow),
  }).finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  releaseSlow(true);
  assert.equal(await replay, rejection);

  const semanticFailure = await settleContextIntentReplay({
    restoreState: { explicitLayerStates: new Map([['radio', true]]) },
    setEnabled: async () => false,
  });
  assert.match(semanticFailure.message, /Context intent replay failed for "radio"/);
});

test('a cancelled Context restore never replays an older explicit companion intent', async () => {
  const calls = [];
  const result = await settleContextIntentReplay({
    restoreState: {
      cancelled: true,
      explicitLayerStates: new Map([['radio', true]]),
    },
    setEnabled: async (...args) => { calls.push(args); },
  });

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('user-facing Context actions surface rejection and semantic false without rethrowing', async () => {
  const surfaced = [];
  const rejection = new Error('restore rejected');
  assert.equal(await settleUserFacingContextAction({
    operation: async () => { throw rejection; },
    onFailure: (error) => surfaced.push(error),
  }), false);
  assert.equal(await settleUserFacingContextAction({
    operation: async () => false,
    onFailure: (error) => surfaced.push(error),
  }), false);
  assert.equal(surfaced[0], rejection);
  assert.match(surfaced[1].message, /did not complete/);

  assert.equal(await settleUserFacingContextAction({
    operation: async () => false,
    falseIsFailure: false,
    onFailure: () => assert.fail('handled false must not surface twice'),
  }), false);
  assert.equal(await settleUserFacingContextAction({
    operation: async () => { throw rejection; },
    onFailure: () => { throw new Error('broken toast'); },
  }), false);
});

const userEnable = (layerId) => ({
  type: 'visibility',
  layerId,
  enabled: true,
  origin: 'user',
});

test('user-enabled layers are additive and do not exit Context', () => {
  assert.equal(shouldExitContextForLayerChange({
    contextMode: 'flights',
    globalContextEnabled: true,
    change: userEnable('earthquakes'),
  }), false);
  assert.equal(shouldExitContextForLayerChange({
    contextMode: 'space-missions',
    globalContextEnabled: false,
    change: userEnable('traffic'),
  }), false);
  assert.equal(shouldExitContextForLayerChange({
    contextMode: null,
    globalContextEnabled: true,
    change: userEnable('earthquakes'),
  }), false, 'the neutral shell uses the same permissive rule');
});

test('programmatic Context dependencies and direct mode setup remain allowed', () => {
  assert.equal(shouldExitContextForLayerChange({
    contextMode: 'space-missions',
    globalContextEnabled: true,
    change: { ...userEnable('satellites'), origin: 'programmatic' },
  }), false);
});

test('Space Missions cancellation retains only a newer authoritative ON entry', () => {
  const cancelledEntry = {
    type: 'visibility-cancelled',
    layerId: 'rocket-launches',
    enabled: true,
    intentEpoch: 8,
    cancellationReason: 'superseded',
    successorIntentEpoch: 9,
    successorEnabled: true,
    successorOrigin: 'programmatic',
  };
  assert.equal(spaceMissionEntryCancellationDisposition({
    change: cancelledEntry,
  }), 'replacement');
  assert.equal(spaceMissionEntryCancellationDisposition({
    change: { ...cancelledEntry, successorEnabled: false },
  }), 'restore', 'a newer OFF releases the entry shell');
  assert.equal(spaceMissionEntryCancellationDisposition({
    change: {
      ...cancelledEntry,
      cancellationReason: 'caller-abort',
      successorIntentEpoch: undefined,
      successorEnabled: undefined,
    },
  }), 'restore', 'caller abort at the same epoch restores the isolated session');
  assert.equal(spaceMissionEntryCancellationDisposition({
    change: { ...cancelledEntry, enabled: false },
    currentIntentEpoch: 9,
    effectivelyEnabled: true,
  }), 'ignore');
});

test('only explicit user-owned shell enables capture a Context restoration snapshot', () => {
  const userMissionEnable = {
    type: 'visibility-requested',
    layerId: 'rocket-launches',
    enabled: true,
    origin: 'user',
  };
  assert.equal(shouldCaptureContextSession(userMissionEnable), true);
  assert.equal(shouldCaptureContextSession({ ...userMissionEnable, origin: 'voice' }), true);
  assert.equal(shouldCaptureContextSession({ ...userMissionEnable, type: 'visibility-will-change' }), true);
  assert.equal(shouldCaptureContextSession({ ...userMissionEnable, origin: 'programmatic' }), false);
  assert.equal(shouldCaptureContextSession({ ...userMissionEnable, origin: 'dependency-restore' }), false);
  assert.equal(shouldCaptureContextSession({ ...userMissionEnable, origin: 'context-restore' }), false);
  assert.equal(shouldCaptureContextSession({ ...userMissionEnable, enabled: false }), false);
  assert.equal(shouldCaptureContextSession({ ...userMissionEnable, layerId: 'satellites' }), false);
});

test('voice dependency OFF exits Space Missions like the equivalent UI action', () => {
  assert.equal(shouldExitContextForLayerChange({
    contextMode: 'space-missions',
    globalContextEnabled: false,
    change: { type: 'visibility', layerId: 'satellites', enabled: false, origin: 'voice' },
  }), true);
});

test('only a newer explicit mission request is deferred during Clear All', () => {
  const change = {
    type: 'visibility-requested',
    layerId: 'rocket-launches',
    enabled: true,
    origin: 'voice',
    intentEpoch: 12,
  };
  assert.equal(shouldDeferContextEntryDuringClear({ change, clearInFlight: true }), true);
  assert.equal(shouldDeferContextEntryDuringClear({ change, clearInFlight: false }), false);
  assert.equal(shouldDeferContextEntryDuringClear({
    change: { ...change, origin: 'programmatic' },
    clearInFlight: true,
  }), false);
  assert.equal(shouldDeferContextEntryDuringClear({
    change: { ...change, enabled: false },
    clearInFlight: true,
  }), false);
});

test('a rapid re-entry snapshots the settled restore target, not partial manager state', () => {
  assert.deepEqual(
    [...contextSnapshotLayerIds(
      new Set(['rocket-launches', 'earthquakes']),
      new Set(['flights', 'traffic']),
    )],
    ['flights', 'traffic'],
  );
  assert.deepEqual(
    [...contextSnapshotLayerIds(new Set(['earthquakes']))],
    ['earthquakes'],
  );
  assert.deepEqual(
    [...contextSnapshotLayerIds(
      new Set(['rocket-launches', 'satellites']),
      null,
      ['rocket-launches'],
    )],
    ['satellites'],
    'the synchronous entry intent is not part of the pre-entry snapshot',
  );
});

test('Space Missions blocks unrelated layer enables before replay data can mix', () => {
  const change = { layerId: 'flights', enabled: true, origin: 'user' };
  assert.match(
    contextLayerEnableBlockReason({ contextMode: 'space-missions', change, layerName: 'Live Flights' }),
    /Exit the mode to enable Live Flights/,
  );
  assert.equal(contextLayerEnableBlockReason({
    contextMode: 'space-missions',
    change: { ...change, layerId: 'satellites' },
  }), null);
  assert.equal(contextLayerEnableBlockReason({
    contextMode: 'flights',
    change,
  }), null, 'live cockpit keeps additive user layers');
});

test('the Global Context shell and layers selected while Context is off remain allowed', () => {
  assert.equal(shouldExitContextForLayerChange({
    contextMode: null,
    globalContextEnabled: true,
    change: userEnable('military-awareness'),
  }), false);
  assert.equal(shouldExitContextForLayerChange({
    contextMode: null,
    globalContextEnabled: false,
    change: userEnable('earthquakes'),
  }), false);
});

test('manually disabling a mode dependency exits that Context bundle', () => {
  assert.equal(shouldExitContextForLayerChange({
    contextMode: 'flights',
    globalContextEnabled: true,
    change: { ...userEnable('military'), enabled: false },
  }), true);
  assert.equal(shouldExitContextForLayerChange({
    contextMode: 'space-missions',
    globalContextEnabled: false,
    change: { ...userEnable('satellites'), enabled: false },
  }), true);
});

test('Radio remains an independent companion across Context transitions', () => {
  for (const contextMode of ['flights', 'space-missions']) {
    for (const enabled of [true, false]) {
      assert.equal(shouldExitContextForLayerChange({
        contextMode,
        globalContextEnabled: true,
        change: { type: 'visibility', origin: 'user', layerId: 'radio', enabled },
      }), false);
    }
    assert.equal(contextAllowedLayerIds(contextMode).has('radio'), true);
  }
  assert.equal(contextLayerEnableBlockReason({
    contextMode: 'space-missions',
    change: { type: 'visibility', origin: 'user', layerId: 'radio', enabled: true },
    layerName: 'Radio',
  }), null);
});

test('each Context mode exposes only its shell and dependencies', () => {
  assert.deepEqual(
    [...contextAllowedLayerIds(null)],
    ['military-awareness', 'radio'],
  );
  assert.deepEqual(
    [...contextAllowedLayerIds('space-missions')],
    ['rocket-launches', 'satellites', 'radio'],
  );
});

test('Context restoration keeps the pre-entry set and user-added layers', () => {
  assert.deepEqual(
    [...contextRestoreLayerIds({
      enabledLayerIds: new Set(['flights', 'traffic']),
      userAdded: new Set(['earthquakes', 'traffic']),
    })],
    ['flights', 'traffic', 'earthquakes'],
  );
});

test('Context restoration honors an explicit companion disable', () => {
  assert.deepEqual(
    [...contextRestoreLayerIds({
      enabledLayerIds: new Set(['flights', 'radio']),
      userAdded: new Set(['earthquakes']),
      userRemoved: new Set(['radio']),
    })],
    ['flights', 'earthquakes'],
  );
});

test('the latest explicit Radio state wins across a Context session', () => {
  for (const effectiveContextMode of [null, 'flights', 'space-missions']) {
    for (const origin of ['user', 'voice']) {
      const snapshot = { userAdded: new Set(), userRemoved: new Set() };
      const record = (enabled) => recordContextSessionUserChange({
        snapshot,
        change: { type: 'visibility', origin, layerId: 'radio', enabled },
        effectiveContextMode,
      });

      assert.equal(record(true), true);
      assert.deepEqual([...snapshot.userAdded], ['radio']);
      assert.deepEqual([...snapshot.userRemoved], []);

      assert.equal(record(false), true);
      assert.deepEqual([...snapshot.userAdded], []);
      assert.deepEqual([...snapshot.userRemoved], ['radio']);
      assert.equal(contextRestoreLayerIds(snapshot).has('radio'), false);

      assert.equal(record(true), true);
      assert.deepEqual([...snapshot.userAdded], ['radio']);
      assert.deepEqual([...snapshot.userRemoved], []);
      assert.equal(contextRestoreLayerIds(snapshot).has('radio'), true);
    }
  }
});

test('only direct UI and voice origins count as explicit Context intent', () => {
  assert.equal(isExplicitUserIntentOrigin('user', 'cctv'), true);
  assert.equal(isExplicitUserIntentOrigin('voice', 'radio'), true);
  assert.equal(isExplicitUserIntentOrigin('voice', 'cctv'), true);
  for (const origin of ['programmatic', 'context-restore', 'dependency', 'voice-cleanup', undefined]) {
    assert.equal(isExplicitUserIntentOrigin(origin), false);
    const snapshot = { userAdded: new Set(), userRemoved: new Set() };
    assert.equal(recordContextSessionUserChange({
      snapshot,
      change: { type: 'visibility', origin, layerId: 'radio', enabled: true },
      effectiveContextMode: 'space-missions',
    }), false);
    assert.equal(snapshot.userAdded.size, 0);
  }
});

test('explicit layer intent finishing during restore overrides the stale queued target', () => {
  for (const origin of ['user', 'voice']) {
    const restoreState = {
      enabledLayerIds: new Set(['flights']),
      explicitLayerStates: new Map(),
    };
    assert.equal(recordContextRestoreExplicitChange({
      restoreState,
      change: { type: 'visibility', origin, layerId: 'cctv', enabled: true },
    }), true);
    assert.equal(restoreState.enabledLayerIds.has('cctv'), true);
    assert.deepEqual([...restoreState.explicitLayerStates], [['cctv', true]]);

    assert.equal(recordContextRestoreExplicitChange({
      restoreState,
      change: { type: 'visibility', origin: 'context-restore', layerId: 'cctv', enabled: false },
    }), false);
    assert.deepEqual([...restoreState.explicitLayerStates], [['cctv', true]]);

    assert.equal(recordContextRestoreExplicitChange({
      restoreState,
      change: { type: 'visibility', origin, layerId: 'cctv', enabled: false },
    }), true);
    assert.equal(restoreState.enabledLayerIds.has('cctv'), false);
    assert.deepEqual([...restoreState.explicitLayerStates], [['cctv', false]]);
  }
});

test('cockpit entry requires Contacts context with both aircraft feeds enabled', () => {
  assert.equal(cockpitEntryAllowed({
    contextMode: 'flights',
    contextModeChanging: false,
    flightsEnabled: true,
    militaryEnabled: true,
  }), true);
  assert.equal(cockpitEntryAllowed({
    contextMode: 'flights',
    contextModeChanging: true,
    flightsEnabled: true,
    militaryEnabled: true,
  }), false, 'Cockpit remains unavailable until Contacts activation settles');
  assert.equal(cockpitEntryAllowed({
    contextMode: null,
    contextModeChanging: false,
    flightsEnabled: true,
    militaryEnabled: true,
  }), false, 'ordinary layer selection is not an operational Contacts context');
  assert.equal(cockpitEntryAllowed({
    contextMode: 'flights',
    contextModeChanging: false,
    flightsEnabled: true,
    militaryEnabled: false,
  }), false, 'the military contact feed is required');
  assert.equal(cockpitEntryAllowed({
    contextMode: 'flights',
    contextModeChanging: false,
    flightsEnabled: false,
    militaryEnabled: true,
  }), false, 'the civilian contact feed is required');
});

test('context teardown guard restores coordination state after success and failure', async () => {
  const idleOwner = { _contextModeChanging: false };
  await runWithContextModeChanging(idleOwner, async () => {
    assert.equal(idleOwner._contextModeChanging, true);
  });
  assert.equal(idleOwner._contextModeChanging, false);

  const activeOwner = { _contextModeChanging: true };
  await assert.rejects(
    runWithContextModeChanging(activeOwner, async () => {
      assert.equal(activeOwner._contextModeChanging, true);
      throw new Error('restore failed');
    }),
    /restore failed/,
  );
  assert.equal(activeOwner._contextModeChanging, true);
});

test('leaving a Context transaction re-publishes the settled state to the funnel', () => {
  // Settle-gated consumers (the Contacts detection override) no-op while a
  // transaction is in flight, so dropping the flag without re-running the
  // funnel leaves them holding the pre-transaction state forever.
  const syncs = [];
  const owner = {
    _contextModeChanging: true,
    _syncContextModeButtons() { syncs.push(this._contextModeChanging); },
  };
  settleContextModeChange(owner);
  assert.equal(owner._contextModeChanging, false);
  assert.deepEqual(syncs, [false], 'the funnel runs AFTER the flag clears');

  // Already settled: nothing to re-publish.
  settleContextModeChange(owner);
  assert.deepEqual(syncs, [false]);

  // A nested scope handing back to a still-running outer transaction has
  // settled nothing.
  const nested = {
    _contextModeChanging: true,
    _syncContextModeButtons() { syncs.push('nested'); },
  };
  settleContextModeChange(nested, true);
  assert.equal(nested._contextModeChanging, true);
  assert.deepEqual(syncs, [false]);

  settleContextModeChange(null); // no owner, no throw
});

test('the teardown guard re-publishes on the way out, so a mid-flight exit is not stranded', async () => {
  // The field case: destroying a Contacts dependency layer exits the session
  // inside the guard — the sync it calls there is gated out — and only the
  // guard's own settle can let a settle-gated consumer see mode === null.
  const observed = [];
  const owner = {
    _contextModeChanging: false,
    _contextMode: 'flights',
    _syncContextModeButtons() {
      observed.push({ mode: this._contextMode, changing: this._contextModeChanging });
    },
  };
  await runWithContextModeChanging(owner, async () => {
    owner._contextMode = null;
    owner._syncContextModeButtons(); // gated: changing is still true
  });
  assert.deepEqual(observed, [
    { mode: null, changing: true },
    { mode: null, changing: false },
  ], 'the exit is re-published once the transaction settles');
});

test('the session-starting entry layer is never bookkept as user-added (chip ON→OFF restores exactly)', () => {
  const snapshot = { enabledLayerIds: new Set(['flights', 'ais-live-vessels']), userAdded: new Set() };
  // The exact left-panel regression: the rockets enable event lands while the
  // mode is still being entered (or even null); it must not survive its own exit.
  for (const effectiveContextMode of ['space-missions', null]) {
    recordContextSessionUserChange({
      snapshot,
      change: { type: 'visibility', layerId: 'rocket-launches', enabled: true, origin: 'user' },
      effectiveContextMode,
    });
    assert.equal(snapshot.userAdded.has('rocket-launches'), false);
  }
  recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility', layerId: 'military-awareness', enabled: true, origin: 'user' },
    effectiveContextMode: null,
  });
  assert.equal(snapshot.userAdded.size, 0);
  assert.deepEqual(
    [...contextRestoreLayerIds(snapshot)].sort(),
    ['ais-live-vessels', 'flights'],
  );
});

test('mid-session user additions are recorded, removed on disable, and judged against the effective mode', () => {
  const snapshot = { enabledLayerIds: new Set(['flights']), userAdded: new Set() };
  recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility', layerId: 'cctv', enabled: true, origin: 'user' },
    effectiveContextMode: 'flights',
  });
  assert.equal(snapshot.userAdded.has('cctv'), true);
  // A dependency of the mode being ENTERED is not a user addition.
  recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility', layerId: 'satellites', enabled: true, origin: 'user' },
    effectiveContextMode: 'space-missions',
  });
  assert.equal(snapshot.userAdded.has('satellites'), false);
  // Disabling a recorded addition removes it before any exit restore reads it.
  recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility', layerId: 'cctv', enabled: false, origin: 'user' },
    effectiveContextMode: 'flights',
  });
  assert.equal(snapshot.userAdded.has('cctv'), false);
});

test('a selected Context dependency becomes user-owned for exit restoration', () => {
  const snapshot = { enabledLayerIds: new Set(), userAdded: new Set() };
  assert.equal(recordContextSessionUserChange({
    snapshot,
    change: {
      type: 'visibility',
      layerId: 'flights',
      enabled: true,
      origin: 'user',
      adoptedFromSelection: true,
    },
    effectiveContextMode: 'flights',
  }), true);
  assert.equal(snapshot.userAdded.has('flights'), true);
  assert.equal(contextRestoreLayerIds(snapshot).has('flights'), true);
});

test('session bookkeeping ignores programmatic origins, non-visibility events, and a missing snapshot', () => {
  const snapshot = { enabledLayerIds: new Set(), userAdded: new Set() };
  assert.equal(recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility', layerId: 'cctv', enabled: true, origin: 'programmatic' },
    effectiveContextMode: null,
  }), false);
  assert.equal(recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility-will-change', layerId: 'cctv', enabled: true, origin: 'user' },
    effectiveContextMode: null,
  }), false);
  assert.equal(recordContextSessionUserChange({
    snapshot: null,
    change: { type: 'visibility', layerId: 'cctv', enabled: true, origin: 'user' },
    effectiveContextMode: null,
  }), false);
  assert.equal(snapshot.userAdded.size, 0);
});
