import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftTrackingTarget,
  enterCockpitWithTracking,
  restoreAircraftTrackingOwner,
} from './cockpitTracking.js';

/**
 * Model the two production stamping seams that sit under this transaction:
 *   trackById -> viewer.trackedEntity -> trackedEntityChanged -> stamp
 *   cockpitView.enter() -> onCameraTakeover -> stamp
 * (both wired in ui.js; pinned by cameraHandoff.test.mjs).
 */
function stampingWorld({ entryAllowed = true } = {}) {
  const world = { generation: 0, trackedEntity: null, stamps: [] };
  const stamp = (reason) => {
    world.generation += 1;
    world.stamps.push(reason);
  };
  const makeLayer = (layerId, { trackable = true } = {}) => ({
    layerId,
    trackById(id) {
      if (!trackable) return false;
      world.trackedEntity = { gevTrackedId: `${layerId}:${id}` };
      stamp('trackedEntityChanged'); // the ui.js listener
      return true;
    },
    stopTracking() { world.trackedEntity = null; },
  });
  world.makeLayer = makeLayer;
  world.cockpitView = {
    active: false,
    readAircraftInfo: () => null,
    enter() {
      if (!entryAllowed) return false;
      stamp('onCameraTakeover'); // enter()'s first camera act
      this.active = true;
      return true;
    },
    exit() { this.active = false; return true; },
  };
  return world;
}

test('voice Cockpit entry stamps camera authority on every mutating path', () => {
  // Success: adopting a selected aircraft AND entering both stamp, so a
  // deferred navigation begun before the verb can never resolve on top of the
  // cockpit.
  const world = stampingWorld();
  const selectedLayer = world.makeLayer('flights');
  const entry = enterCockpitWithTracking({
    cockpitView: world.cockpitView,
    selectedLayer,
    selectedTarget: { layerId: 'flights', id: 'abc123' },
    currentLayer: null,
    rollbackLayer: null,
  });
  assert.equal(entry.entered, true);
  assert.deepEqual(world.stamps, ['trackedEntityChanged', 'onCameraTakeover']);
});

test('a refused Cockpit entry still stamps for the tracker it already moved', () => {
  // The adoption happens before enter() can refuse. The mutation is real, so
  // the stamp must be real too — otherwise a pending deferred flight would
  // resolve against a camera owner that changed underneath it.
  const world = stampingWorld({ entryAllowed: false });
  const selectedLayer = world.makeLayer('flights');
  const rollbackLayer = world.makeLayer('military');
  const entry = enterCockpitWithTracking({
    cockpitView: world.cockpitView,
    selectedLayer,
    selectedTarget: { layerId: 'flights', id: 'abc123' },
    currentLayer: selectedLayer,
    rollbackLayer,
    rollbackTarget: { layerId: 'military', id: 'ae01ce' },
  });
  assert.equal(entry.entered, false);
  assert.ok(entry.error, 'a refused entry reports an honest failure');
  // Adoption stamped, and the rollback re-track stamped again.
  assert.deepEqual(world.stamps, ['trackedEntityChanged', 'trackedEntityChanged']);
  assert.equal(world.generation, 2);
  assert.equal(world.trackedEntity.gevTrackedId, 'military:ae01ce');
});

test('a Cockpit entry that mutates nothing takes no camera authority', () => {
  // No selection to adopt and a refusing controller: the transaction must be
  // completely inert, not a silent generation bump that would retire an
  // unrelated deferred navigation.
  const world = stampingWorld({ entryAllowed: false });
  const entry = enterCockpitWithTracking({ cockpitView: world.cockpitView });
  assert.equal(entry.entered, false);
  assert.deepEqual(world.stamps, []);
  assert.equal(world.generation, 0);
});

test('failed Cockpit entry forces the prior retained layer to reacquire viewer ownership', () => {
  const calls = [];
  const layer = {
    stopTracking() { calls.push('stop'); },
    trackById(id, options) { calls.push(['track', id, options]); return true; },
  };
  assert.equal(restoreAircraftTrackingOwner(layer, 'prior-b', { origin: 'voice' }), true);
  assert.deepEqual(calls, ['stop', ['track', 'prior-b', { origin: 'voice' }]]);
});

test('Cockpit entry rollback restores the tracker captured before Contacts activation', () => {
  const calls = [];
  const currentLayer = {
    stopTracking(options) { calls.push(['current:stop', options]); },
  };
  const rollbackLayer = {
    stopTracking() { calls.push('prior:stop'); },
    trackById(id, options) { calls.push(['prior:track', id, options]); return true; },
  };
  const result = enterCockpitWithTracking({
    cockpitView: {
      readAircraftInfo: () => ({ layerId: 'flights', icao24: 'newer' }),
      enter: () => false,
    },
    currentLayer,
    rollbackLayer,
    rollbackTarget: { layerId: 'military', id: 'prior' },
    selectionOrigin: 'voice',
  });

  assert.deepEqual(result, { entered: false, error: 'Cockpit entry was unavailable' });
  assert.deepEqual(calls, [
    ['current:stop', { origin: 'voice' }],
    'prior:stop',
    ['prior:track', 'prior', { origin: 'voice' }],
  ]);
});

test('same-target Cockpit entry forwards explicit origin without replacing identity', () => {
  const calls = [];
  const result = enterCockpitWithTracking({
    cockpitView: {
      readAircraftInfo: () => ({ layerId: 'flights', icao24: 'same' }),
      enter: () => { calls.push('enter'); return true; },
    },
    selectedLayer: {
      trackById(id, options) { calls.push(['track', id, options]); return true; },
    },
    selectedTarget: { layerId: 'flights', id: 'same' },
    selectionOrigin: 'voice',
  });

  assert.deepEqual(result, { entered: true, error: null });
  assert.deepEqual(calls, [
    ['track', 'same', { origin: 'voice' }],
    'enter',
  ]);
});

test('failed Cockpit entry clears an attempted durable target when no prior target exists', () => {
  const calls = [];
  const selectedLayer = {
    trackById(id, options) { calls.push(['track', id, options]); return true; },
    stopTracking(options) { calls.push(['stop', options]); },
  };
  const result = enterCockpitWithTracking({
    cockpitView: {
      readAircraftInfo: () => null,
      enter: () => false,
    },
    selectedLayer,
    selectedTarget: { layerId: 'flights', id: 'attempted' },
    rollbackTarget: null,
    selectionOrigin: 'voice',
  });

  assert.deepEqual(result, { entered: false, error: 'Cockpit entry was unavailable' });
  assert.deepEqual(calls, [
    ['track', 'attempted', { origin: 'voice' }],
    ['stop', { origin: 'voice' }],
  ]);
});

test('Cockpit entry exceptions are contained and restore prior tracking ownership', () => {
  const calls = [];
  const result = enterCockpitWithTracking({
    cockpitView: {
      readAircraftInfo: () => ({ layerId: 'flights', icao24: 'current' }),
      enter() { calls.push('enter'); throw new Error('entry exploded'); },
      exit(options) { calls.push(['exit', options]); },
    },
    currentLayer: { stopTracking() { calls.push('current:stop'); } },
    rollbackLayer: {
      stopTracking() { calls.push('prior:stop'); },
      trackById(id) { calls.push(`prior:track:${id}`); return true; },
    },
    rollbackTarget: { layerId: 'military', id: 'prior' },
  });

  assert.deepEqual(result, { entered: false, error: 'entry exploded' });
  assert.deepEqual(calls, [
    'enter',
    'current:stop',
    'prior:stop',
    'prior:track:prior',
    ['exit', { restoreTracking: false }],
  ]);
});

test('a partially mutating selected tracker is stopped when acquisition throws', () => {
  const calls = [];
  const result = enterCockpitWithTracking({
    cockpitView: {
      readAircraftInfo: () => ({ layerId: 'flights', icao24: 'current' }),
      enter: () => assert.fail('Cockpit entry must not follow failed tracking'),
    },
    currentLayer: { stopTracking() { calls.push('current:stop'); } },
    selectedLayer: {
      trackById(id) { calls.push(`selected:track:${id}`); throw new Error('tracking exploded'); },
      stopTracking() { calls.push('selected:stop'); },
    },
    selectedTarget: { layerId: 'military', id: 'selected' },
    rollbackLayer: {
      stopTracking() { calls.push('prior:stop'); },
      trackById(id) { calls.push(`prior:track:${id}`); return true; },
    },
    rollbackTarget: { layerId: 'flights', id: 'current' },
  });

  assert.deepEqual(result, { entered: false, error: 'tracking exploded' });
  assert.deepEqual(calls, [
    'selected:track:selected',
    'selected:stop',
    'prior:stop',
    'prior:track:current',
  ]);
});

test('aircraft tracking targets normalize either supported aircraft identifier', () => {
  assert.deepEqual(
    aircraftTrackingTarget({ layerId: 'flights', icao24: 'abc123' }),
    { layerId: 'flights', id: 'abc123' },
  );
  assert.deepEqual(
    aircraftTrackingTarget({ layerId: 'military', id: 42 }),
    { layerId: 'military', id: '42' },
  );
  assert.equal(aircraftTrackingTarget({ layerId: 'flights' }), null);
});
