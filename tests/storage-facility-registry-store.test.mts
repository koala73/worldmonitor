import { strict as assert } from 'node:assert';
import { test, describe, beforeEach } from 'node:test';
import {
  getCachedStorageFacilityRegistry,
  setCachedStorageFacilityRegistry,
  __resetStorageFacilityRegistryStoreForTests,
  __setBootstrapReaderForTests,
} from '../src/shared/storage-facility-registry-store';

const FIXTURE = {
  facilities: { rehden: { id: 'rehden' } },
  classifierVersion: 'v1',
  updatedAt: '2026-04-22T12:00:00Z',
};

function countingReader(map: Record<string, unknown>): { reader: (k: string) => unknown; calls: { count: number } } {
  const calls = { count: 0 };
  const reader = (key: string): unknown => {
    calls.count++;
    return map[key];
  };
  return { reader, calls };
}

describe('storage-facility-registry-store', () => {
  beforeEach(() => {
    __resetStorageFacilityRegistryStoreForTests();
  });

  test('drains bootstrap key once; subsequent calls do NOT re-drain', () => {
    const { reader, calls } = countingReader({ storageFacilities: FIXTURE });
    __setBootstrapReaderForTests(reader);

    const first = getCachedStorageFacilityRegistry();
    assert.equal(first.registry, FIXTURE);
    assert.equal(first.source, 'bootstrap');
    assert.equal(calls.count, 1);

    // Two more consumers call — store MUST NOT re-invoke reader.
    const second = getCachedStorageFacilityRegistry();
    const third = getCachedStorageFacilityRegistry();
    assert.equal(second.registry, FIXTURE);
    assert.equal(third.registry, FIXTURE);
    assert.equal(calls.count, 1, 'drained only once across three consumers');
  });

  test('drain with no bootstrap data returns empty cache but marks drained', () => {
    const { reader, calls } = countingReader({});
    __setBootstrapReaderForTests(reader);

    const result = getCachedStorageFacilityRegistry();
    assert.equal(result.registry, undefined);
    assert.equal(result.source, 'none');
    assert.equal(calls.count, 1);

    // Second call MUST NOT re-drain.
    getCachedStorageFacilityRegistry();
    assert.equal(calls.count, 1);
  });

  test('setCachedStorageFacilityRegistry updates cache and marks source=rpc', () => {
    const { reader } = countingReader({});
    __setBootstrapReaderForTests(reader);
    getCachedStorageFacilityRegistry();

    const fresh = { facilities: { new: { id: 'new' } }, classifierVersion: 'v2', updatedAt: '2026-04-23T00:00:00Z' };
    setCachedStorageFacilityRegistry(fresh);

    const after = getCachedStorageFacilityRegistry();
    assert.equal(after.registry, fresh);
    assert.equal(after.source, 'rpc');
  });

  test('setCachedStorageFacilityRegistry works even if drain never ran (RPC-first path)', () => {
    const { reader, calls } = countingReader({});
    __setBootstrapReaderForTests(reader);

    const fresh = { facilities: { a: { id: 'a' } }, classifierVersion: 'v1', updatedAt: '2026-04-22T00:00:00Z' };
    setCachedStorageFacilityRegistry(fresh);

    const after = getCachedStorageFacilityRegistry();
    // Drain never happened — reader must not be invoked.
    assert.equal(calls.count, 0, 'reader not invoked on pure RPC-first path');
    assert.equal(after.registry, fresh);
  });
});
