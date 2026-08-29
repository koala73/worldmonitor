import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearTrackedSubjectContext,
  getContextStore,
  getSelectedEntityContext,
  refreshTrackedSubjectContext,
  registerEntityContext,
  selectEntityContext,
  selectTrackedSubjectContext,
} from './contextStore.js';

/**
 * The tracking layers (aircraft) publish selection on their own awareness
 * lane, which the readout card and Contacts panel consume. These tests pin the
 * OTHER half of that contract: the same click must also reach the shared
 * selection slot, because voice's `get_entity_context {scope:'selected'}` and
 * the Cockpit's selected-target lookup read only this slot. When they did not,
 * a plainly selected plane answered "there isn't a plane currently selected".
 */

function withWindow(run) {
  const realWindow = globalThis.window;
  const host = new EventTarget();
  globalThis.window = host;
  try {
    return run(host);
  } finally {
    globalThis.window = realWindow;
  }
}

const flightSubject = (id, extra = {}) => ({
  id,
  layerId: 'flights',
  layerName: 'Live Flights',
  source: 'OpenSky Network',
  label: id.toUpperCase(),
  latitude: 30.2672,
  longitude: -97.7431,
  ...extra,
});

test('a tracking layer subject becomes the selected entity context', () => {
  withWindow(() => {
    const record = selectTrackedSubjectContext(flightSubject('aaa001'));
    assert.equal(record?.id, 'aaa001');
    const selected = getSelectedEntityContext();
    assert.equal(selected?.id, 'aaa001');
    assert.equal(selected?.layerId, 'flights');
    assert.equal(selected?.latitude, 30.2672);
  });
});

test('selecting a tracking subject stays off the overlay-click event lane', () => {
  withWindow((host) => {
    const seen = [];
    host.addEventListener('gev:entity-selected', () => seen.push('selected'));
    host.addEventListener('gev:entity-selection-cleared', () => seen.push('cleared'));
    selectTrackedSubjectContext(flightSubject('aaa001'));
    clearTrackedSubjectContext('flights');
    assert.deepEqual(
      seen,
      [],
      'aircraft already publish gev:awareness-subject-* — a second lane would make two surfaces fight over one subject',
    );
  });
});

test('switching contacts moves the subject and leaves no stale record behind', () => {
  withWindow(() => {
    selectTrackedSubjectContext(flightSubject('aaa001'));
    selectTrackedSubjectContext(flightSubject('aaa002', { latitude: 31.1, longitude: -96.9 }));
    const store = getContextStore();
    const flightIds = [...store.entities.values()]
      .filter((record) => record.layerId === 'flights')
      .map((record) => record.id);
    assert.deepEqual(flightIds, ['aaa002']);
    assert.equal(getSelectedEntityContext()?.id, 'aaa002');
  });
});

test('a sibling tracking layer keeps its own subject slot', () => {
  withWindow(() => {
    selectTrackedSubjectContext(flightSubject('aaa001'));
    selectTrackedSubjectContext({
      id: 'bbb101', layerId: 'military', label: 'MIL101', latitude: 30.27, longitude: -97.75,
    });
    const store = getContextStore();
    assert.equal(getSelectedEntityContext()?.id, 'bbb101');
    assert.ok(store.entities.has('aaa001'), 'the flights record survives; only the SELECTION moved');
  });
});

test('the per-poll refresh updates values without stealing the selection', () => {
  withWindow(() => {
    selectTrackedSubjectContext(flightSubject('aaa001'));
    const other = registerEntityContext({ __gevContextId: 'dc-7' }, {
      id: 'dc-7', layerId: 'local-datacenters', label: 'Datacenter 7',
    });
    selectEntityContext(other.entity);
    assert.equal(getSelectedEntityContext()?.id, 'dc-7');

    refreshTrackedSubjectContext(flightSubject('aaa001', { latitude: 31.5 }));
    assert.equal(
      getSelectedEntityContext()?.id,
      'dc-7',
      'a background position refresh must not resurrect a subject the operator replaced',
    );
    assert.equal(getContextStore().entities.get('aaa001').latitude, 31.5);
  });
});

test('the per-poll refresh will not register a subject that was never selected', () => {
  withWindow(() => {
    assert.equal(refreshTrackedSubjectContext(flightSubject('aaa009')), null);
    assert.equal(getContextStore().entities.has('aaa009'), false);
  });
});

test('deselecting a contact releases the shared slot', () => {
  withWindow(() => {
    selectTrackedSubjectContext(flightSubject('aaa001'));
    clearTrackedSubjectContext('flights');
    assert.equal(getSelectedEntityContext(), null);
    assert.equal(getContextStore().entities.has('aaa001'), false);
  });
});

test('clearing one tracking layer leaves another layer selection alone', () => {
  withWindow(() => {
    const other = registerEntityContext({ __gevContextId: 'dam-3' }, {
      id: 'dam-3', layerId: 'local-dams', label: 'Dam 3',
    });
    selectEntityContext(other.entity);
    clearTrackedSubjectContext('flights');
    assert.equal(getSelectedEntityContext()?.id, 'dam-3');
  });
});

test('the tracking-subject helpers are inert with no window to host the store', () => {
  const realWindow = globalThis.window;
  globalThis.window = undefined;
  try {
    // The aircraft layers call these inside their per-poll refresh; a throw
    // here would abort the rest of the poll.
    assert.equal(selectTrackedSubjectContext(flightSubject('aaa001')), null);
    assert.equal(refreshTrackedSubjectContext(flightSubject('aaa001')), null);
    assert.doesNotThrow(() => clearTrackedSubjectContext('flights'));
  } finally {
    globalThis.window = realWindow;
  }
});

test('a satellite subject uses the same shared slot as aircraft', () => {
  // Satellites were named in the same PRD gap: they publish only the awareness
  // event, so a tracked satellite was invisible to the voice entity tools.
  withWindow(() => {
    selectTrackedSubjectContext(flightSubject('aaa001'));
    selectTrackedSubjectContext({
      id: '25544',
      layerId: 'satellites',
      layerName: 'Satellites',
      source: 'CelesTrak',
      label: 'ISS (ZARYA)',
      latitude: 12.5,
      longitude: -45.2,
      properties: { name: 'ISS (ZARYA)', noradId: '25544', altitude: '420 km' },
    });
    const selected = getSelectedEntityContext();
    assert.equal(selected?.id, '25544');
    assert.equal(selected?.layerId, 'satellites');
    assert.equal(selected?.properties?.noradId, '25544');
  });
});

test('switching satellites leaves no stale orbit record behind', () => {
  withWindow(() => {
    const sat = (id, label) => ({
      id, layerId: 'satellites', label, latitude: 1, longitude: 2,
    });
    selectTrackedSubjectContext(sat('25544', 'ISS (ZARYA)'));
    selectTrackedSubjectContext(sat('20580', 'HST'));
    const ids = [...getContextStore().entities.values()]
      .filter((record) => record.layerId === 'satellites')
      .map((record) => record.id);
    assert.deepEqual(ids, ['20580']);
    assert.equal(getSelectedEntityContext()?.id, '20580');
  });
});

test('deselecting a satellite releases the slot without touching aircraft', () => {
  withWindow(() => {
    selectTrackedSubjectContext(flightSubject('aaa001'));
    selectTrackedSubjectContext({ id: '25544', layerId: 'satellites', label: 'ISS', latitude: 1, longitude: 2 });
    clearTrackedSubjectContext('satellites');
    assert.equal(getSelectedEntityContext(), null, 'the satellite gave the slot back');
    assert.ok(getContextStore().entities.has('aaa001'), 'and the aircraft record is untouched');
  });
});
