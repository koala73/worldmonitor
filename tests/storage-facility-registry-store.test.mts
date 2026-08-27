import { strict as assert } from 'node:assert';
import { test, describe, beforeEach } from 'node:test';
import {
  ensureStorageFacilityRegistryHydrated,
  getCachedStorageFacilityRegistry,
  setCachedStorageFacilityRegistry,
  __resetStorageFacilityRegistryStoreForTests,
  __setBootstrapReaderForTests,
  __setOnDemandLoaderForTests,
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

  test('ensureHydrated path coalesces one in-flight fetch and stores the result', async () => {
    const { reader, calls } = countingReader({});
    __setBootstrapReaderForTests(reader);
    let loaderCalls = 0;
    __setOnDemandLoaderForTests(async () => {
      loaderCalls += 1;
      await Promise.resolve();
      return FIXTURE;
    });

    const [first, second] = await Promise.all([
      ensureStorageFacilityRegistryHydrated(),
      ensureStorageFacilityRegistryHydrated(),
    ]);
    assert.equal(first.registry, FIXTURE);
    assert.equal(second.registry, FIXTURE);
    assert.equal(loaderCalls, 1);
    assert.equal(calls.count, 1);

    const third = await ensureStorageFacilityRegistryHydrated();
    assert.equal(third.registry, FIXTURE);
    assert.equal(loaderCalls, 1);
  });

  test('failed on-demand hydration clears the in-flight guard so a retry can succeed', async () => {
    const { reader } = countingReader({});
    __setBootstrapReaderForTests(reader);
    const requestedKeys: string[] = [];
    let failing = true;
    __setOnDemandLoaderForTests(async (key) => {
      requestedKeys.push(key);
      if (failing) throw new Error('temporary storage failure');
      return FIXTURE;
    });

    await assert.rejects(ensureStorageFacilityRegistryHydrated(), /temporary storage failure/);
    failing = false;

    const retried = await ensureStorageFacilityRegistryHydrated();
    assert.equal(retried.registry, FIXTURE);
    assert.deepEqual(
      requestedKeys,
      ['storageFacilities', 'storageFacilities'],
      'retry must issue exactly one new request after the failed attempt',
    );
  });

  test('refresh re-fetches even when the store already has data', async () => {
    const { reader } = countingReader({ storageFacilities: FIXTURE });
    __setBootstrapReaderForTests(reader);
    const refreshed = { facilities: { refreshed: { id: 'refreshed' } } };
    let loaderCalls = 0;
    __setOnDemandLoaderForTests(async () => {
      loaderCalls += 1;
      return refreshed;
    });

    await ensureStorageFacilityRegistryHydrated();
    assert.equal(loaderCalls, 0);
    const next = await ensureStorageFacilityRegistryHydrated({ refresh: true });
    assert.equal(next.registry, refreshed);
    assert.equal(loaderCalls, 1);
  });

  test('rolling-deploy leftover wins and skips the on-demand fetch', async () => {
    const { reader } = countingReader({ storageFacilities: FIXTURE });
    __setBootstrapReaderForTests(reader);
    let loaderCalls = 0;
    __setOnDemandLoaderForTests(async () => {
      loaderCalls += 1;
      return undefined;
    });

    const result = await ensureStorageFacilityRegistryHydrated();
    assert.equal(result.registry, FIXTURE);
    assert.equal(loaderCalls, 0);
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
