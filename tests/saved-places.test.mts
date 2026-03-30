import test from 'node:test';
import assert from 'node:assert/strict';

import { createSavedPlacesStore } from '../src/services/saved-places.ts';

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

async function withGlobalLocalStorage(storage, fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  try {
    return await fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('migrates one legacy proximity location into the first saved place', async () => {
  const storage = createMemoryStorage();
  storage.setItem('wm_proximity_config', JSON.stringify({
    enabled: true,
    radiusKm: 250,
    location: {
      lat: 35.994,
      lon: -78.8986,
      label: 'Durham, NC',
      source: 'manual',
      setAt: 1_700_000_000_000,
    },
  }));

  await withGlobalLocalStorage(storage, () => {
    const savedPlaces = createSavedPlacesStore(storage);
    const places = savedPlaces.getPlaces();

    assert.equal(places.length, 1);
    assert.equal(places[0]?.name, 'Durham, NC');
    assert.equal(places[0]?.primary, true);
    assert.equal(places[0]?.source, 'migrated-proximity');
    assert.deepEqual(places[0]?.tags, ['home']);
    assert.equal(places[0]?.radiusKm, 250);
  });
});

test('does not remigrate when saved places already exist', async () => {
  const storage = createMemoryStorage();
  storage.setItem('wm_proximity_config', JSON.stringify({
    enabled: true,
    radiusKm: 250,
    location: {
      lat: 35.994,
      lon: -78.8986,
      label: 'Legacy Home',
      source: 'manual',
      setAt: 1_700_000_000_000,
    },
  }));
  storage.setItem('wm_saved_places_v1', JSON.stringify([
    {
      id: 'existing-place',
      name: 'Existing Place',
      lat: 40.7128,
      lon: -74.006,
      radiusKm: 50,
      tags: ['work'],
      priority: 1,
      notes: '',
      offlinePinned: false,
      primary: true,
      source: 'manual',
      sortIndex: 1,
      createdAt: 1_700_000_000_001,
      updatedAt: 1_700_000_000_001,
    },
  ]));

  await withGlobalLocalStorage(storage, () => {
    const savedPlaces = createSavedPlacesStore(storage);
    const places = savedPlaces.getPlaces();

    assert.equal(places.length, 1);
    assert.equal(places[0]?.id, 'existing-place');
    assert.equal(places[0]?.name, 'Existing Place');
  });
});

test('first added place becomes primary', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());

  const home = savedPlaces.addPlace({ name: 'Home', lat: 35.9, lon: -78.9 });
  const work = savedPlaces.addPlace({ name: 'Work', lat: 35.8, lon: -78.8 });

  assert.equal(home.primary, true);
  assert.equal(work.primary, false);
  assert.equal(savedPlaces.getPrimaryPlace()?.id, home.id);
});

test('setPrimaryPlace enforces a single primary', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());

  const home = savedPlaces.addPlace({ name: 'Home', lat: 35.9, lon: -78.9 });
  const work = savedPlaces.addPlace({ name: 'Work', lat: 35.8, lon: -78.8 });

  savedPlaces.setPrimaryPlace(work.id);
  const places = savedPlaces.getPlaces();

  assert.equal(savedPlaces.getPrimaryPlace()?.id, work.id);
  assert.equal(places.filter((place) => place.primary).length, 1);
  assert.equal(places.find((place) => place.id === home.id)?.primary, false);
});

test('removeSavedPlace promotes the next best place to primary', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());

  const home = savedPlaces.addPlace({ name: 'Home', lat: 35.9, lon: -78.9, priority: 1 });
  savedPlaces.addPlace({ name: 'Work', lat: 35.8, lon: -78.8, priority: 3 });
  const family = savedPlaces.addPlace({ name: 'Family', lat: 35.7, lon: -78.7, priority: 9 });

  savedPlaces.removePlace(home.id);

  assert.equal(savedPlaces.getPrimaryPlace()?.id, family.id);
  assert.equal(savedPlaces.getPlaces().filter((place) => place.primary).length, 1);
});

test('reorderPlaces preserves ids and keeps a single primary', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());

  const home = savedPlaces.addPlace({ name: 'Home', lat: 35.9, lon: -78.9 });
  const work = savedPlaces.addPlace({ name: 'Work', lat: 35.8, lon: -78.8 });
  const family = savedPlaces.addPlace({ name: 'Family', lat: 35.7, lon: -78.7 });

  savedPlaces.reorderPlaces([family.id, work.id, home.id]);
  const places = savedPlaces.getPlaces();

  assert.deepEqual(
    new Set(places.map((place) => place.id)),
    new Set([home.id, work.id, family.id]),
  );
  assert.equal(places.filter((place) => place.primary).length, 1);
  assert.deepEqual(
    places.filter((place) => !place.primary).map((place) => place.id),
    [family.id, work.id],
  );
});

test('invalid lat/lon throws', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());

  assert.throws(
    () => savedPlaces.addPlace({ name: 'Bad Lat', lat: 91, lon: 0 }),
    /latitude/i,
  );
  assert.throws(
    () => savedPlaces.addPlace({ name: 'Bad Lon', lat: 0, lon: 181 }),
    /longitude/i,
  );
});

test('radius is clamped', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());

  const huge = savedPlaces.addPlace({ name: 'Huge', lat: 35.9, lon: -78.9, radiusKm: 99_999 });
  const tiny = savedPlaces.addPlace({ name: 'Tiny', lat: 35.8, lon: -78.8, radiusKm: 0 });

  assert.equal(huge.radiusKm, 3000);
  assert.equal(tiny.radiusKm, 1);
});

test('subscribeSavedPlaces fires on add update remove', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());
  const snapshots = [];

  const unsubscribe = savedPlaces.subscribe((places) => {
    snapshots.push(places.map((place) => place.name));
  });

  const home = savedPlaces.addPlace({ name: 'Home', lat: 35.9, lon: -78.9 });
  savedPlaces.updatePlace(home.id, { name: 'Primary Home' });
  savedPlaces.removePlace(home.id);
  unsubscribe();

  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots[0], ['Home']);
  assert.deepEqual(snapshots[1], ['Primary Home']);
  assert.deepEqual(snapshots[2], []);
});

test('sort order is primary then priority then recency', () => {
  const savedPlaces = createSavedPlacesStore(createMemoryStorage());

  const alpha = savedPlaces.addPlace({ name: 'Alpha', lat: 35.9, lon: -78.9, priority: 1 });
  const beta = savedPlaces.addPlace({ name: 'Beta', lat: 35.8, lon: -78.8, priority: 5 });
  const gamma = savedPlaces.addPlace({ name: 'Gamma', lat: 35.7, lon: -78.7, priority: 5 });

  assert.deepEqual(
    savedPlaces.getPlaces().map((place) => place.id),
    [alpha.id, gamma.id, beta.id],
  );
});
