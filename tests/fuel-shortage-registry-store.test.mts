import { strict as assert } from 'node:assert';
import { test, describe, beforeEach } from 'node:test';
import {
  getCachedFuelShortageRegistry,
  setCachedFuelShortageRegistry,
  __resetFuelShortageRegistryStoreForTests,
  __setBootstrapReaderForTests,
} from '../src/shared/fuel-shortage-registry-store';

const FIXTURE = {
  shortages: { 'xx-petrol-2026': { id: 'xx-petrol-2026' } },
  classifierVersion: 'v1',
  updatedAt: '2026-04-22T12:00:00Z',
};

describe('fuel-shortage-registry-store', () => {
  beforeEach(() => {
    __resetFuelShortageRegistryStoreForTests();
  });

  test('drains bootstrap key once; subsequent calls do NOT re-drain', () => {
    let calls = 0;
    __setBootstrapReaderForTests((key: string): unknown => {
      calls++;
      return key === 'fuelShortages' ? FIXTURE : undefined;
    });

    const first = getCachedFuelShortageRegistry();
    assert.equal(first.registry, FIXTURE);
    assert.equal(first.source, 'bootstrap');
    assert.equal(calls, 1);

    getCachedFuelShortageRegistry();
    getCachedFuelShortageRegistry();
    assert.equal(calls, 1, 'drained only once across three consumers');
  });

  test('drain with no bootstrap data returns empty cache', () => {
    __setBootstrapReaderForTests(() => undefined);
    const result = getCachedFuelShortageRegistry();
    assert.equal(result.registry, undefined);
    assert.equal(result.source, 'none');
  });

  test('setCachedFuelShortageRegistry updates cache and marks source=rpc', () => {
    __setBootstrapReaderForTests(() => undefined);
    getCachedFuelShortageRegistry();

    const fresh = { shortages: { new: { id: 'new' } }, classifierVersion: 'v2', updatedAt: '2026-04-23T00:00:00Z' };
    setCachedFuelShortageRegistry(fresh);

    const after = getCachedFuelShortageRegistry();
    assert.equal(after.registry, fresh);
    assert.equal(after.source, 'rpc');
  });

  test('setCachedFuelShortageRegistry works even if drain never ran', () => {
    let calls = 0;
    __setBootstrapReaderForTests(() => { calls++; return undefined; });

    const fresh = { shortages: { a: { id: 'a' } }, classifierVersion: 'v1', updatedAt: '2026-04-22T00:00:00Z' };
    setCachedFuelShortageRegistry(fresh);

    const after = getCachedFuelShortageRegistry();
    assert.equal(calls, 0, 'reader not invoked on pure RPC-first path');
    assert.equal(after.registry, fresh);
  });
});
