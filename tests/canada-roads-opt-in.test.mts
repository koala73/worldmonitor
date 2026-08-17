import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANADA_ROADS_OPT_IN_KEY,
  applyCanadaRoadsOptInMigration,
} from '../src/services/canada-roads-opt-in';

function memoryStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem(key: string): string | null {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key: string, value: string): void {
      store[key] = value;
    },
    snapshot: store,
  };
}

test('no marker + canadaRoads true flips off, saves, and writes the marker', () => {
  const storage = memoryStorage();
  const saved: Array<{ canadaRoads: boolean }> = [];
  const next = applyCanadaRoadsOptInMigration(
    { canadaRoads: true, weather: true },
    storage,
    (layers) => { saved.push(layers); },
  );

  assert.equal(next.canadaRoads, false);
  assert.equal(next.weather, true);
  assert.deepEqual(saved, [{ canadaRoads: false, weather: true }]);
  assert.equal(storage.getItem(CANADA_ROADS_OPT_IN_KEY), 'done');
});

test('no marker + canadaRoads false writes the marker and does not save', () => {
  const storage = memoryStorage();
  const saved: unknown[] = [];
  const input = { canadaRoads: false };
  const next = applyCanadaRoadsOptInMigration(input, storage, (layers) => { saved.push(layers); });

  assert.equal(next, input);
  assert.deepEqual(saved, []);
  assert.equal(storage.getItem(CANADA_ROADS_OPT_IN_KEY), 'done');
});

test('marker present + canadaRoads true leaves the stored opt-in alone', () => {
  const storage = memoryStorage({ [CANADA_ROADS_OPT_IN_KEY]: 'done' });
  const saved: unknown[] = [];
  const input = { canadaRoads: true };
  const next = applyCanadaRoadsOptInMigration(input, storage, (layers) => { saved.push(layers); });

  assert.equal(next, input);
  assert.equal(next.canadaRoads, true);
  assert.deepEqual(saved, []);
});

test('marker present + canadaRoads false is a no-op', () => {
  const storage = memoryStorage({ [CANADA_ROADS_OPT_IN_KEY]: 'done' });
  const saved: unknown[] = [];
  const input = { canadaRoads: false };
  const next = applyCanadaRoadsOptInMigration(input, storage, (layers) => { saved.push(layers); });

  assert.equal(next, input);
  assert.deepEqual(saved, []);
});

test('a thrown save leaves the marker unset so the next visit retries', () => {
  const storage = memoryStorage();
  assert.throws(
    () => applyCanadaRoadsOptInMigration(
      { canadaRoads: true },
      storage,
      () => { throw new Error('quota'); },
    ),
    /quota/,
  );
  assert.equal(storage.getItem(CANADA_ROADS_OPT_IN_KEY), null);
});
