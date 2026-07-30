import { strict as assert } from 'node:assert';
import { test, describe, beforeEach } from 'node:test';
import {
  getCachedPipelineRegistries,
  setCachedPipelineRegistries,
  __resetPipelineRegistryStoreForTests,
  __setBootstrapReaderForTests,
} from '../src/shared/pipeline-registry-store';

const GAS_FIXTURE = {
  pipelines: { 'nord-stream-1': { id: 'nord-stream-1' } },
  classifierVersion: 'v1',
  updatedAt: '2026-04-22T12:00:00Z',
};
const OIL_FIXTURE = {
  pipelines: { druzhba: { id: 'druzhba' } },
  classifierVersion: 'v1',
  updatedAt: '2026-04-22T10:00:00Z',
};

function countingReader(map: Record<string, unknown>): { reader: (k: string) => unknown; calls: { count: number } } {
  const calls = { count: 0 };
  const reader = (key: string): unknown => {
    calls.count++;
    return map[key];
  };
  return { reader, calls };
}

describe('pipeline-registry-store', () => {
  beforeEach(() => {
    __resetPipelineRegistryStoreForTests();
  });

  test('drains bootstrap keys once; subsequent calls do NOT re-drain', () => {
    const { reader, calls } = countingReader({
      pipelinesGas: GAS_FIXTURE,
      pipelinesOil: OIL_FIXTURE,
    });
    __setBootstrapReaderForTests(reader);

    const firstCall = getCachedPipelineRegistries();
    assert.equal(firstCall.gas, GAS_FIXTURE);
    assert.equal(firstCall.oil, OIL_FIXTURE);
    assert.equal(firstCall.source, 'bootstrap');
    assert.equal(calls.count, 2);

    // Two more consumers call — store MUST NOT re-invoke reader.
    const secondCall = getCachedPipelineRegistries();
    const thirdCall = getCachedPipelineRegistries();
    assert.equal(secondCall.gas, GAS_FIXTURE);
    assert.equal(secondCall.oil, OIL_FIXTURE);
    assert.equal(thirdCall.gas, GAS_FIXTURE);
    assert.equal(thirdCall.oil, OIL_FIXTURE);
    assert.equal(calls.count, 2, 'drained only once across three consumers');
  });

  test('drain with no bootstrap data returns empty cache but marks drained', () => {
    const { reader, calls } = countingReader({});
    __setBootstrapReaderForTests(reader);

    const result = getCachedPipelineRegistries();
    assert.equal(result.gas, undefined);
    assert.equal(result.oil, undefined);
    assert.equal(result.source, 'none');
    assert.equal(calls.count, 2);

    // Second call MUST NOT re-drain (protects against races between consumers).
    getCachedPipelineRegistries();
    assert.equal(calls.count, 2);
  });

  test('setCachedPipelineRegistries updates cache and marks source=rpc', () => {
    const { reader } = countingReader({});
    __setBootstrapReaderForTests(reader);
    getCachedPipelineRegistries();

    const freshGas = { pipelines: { new: { id: 'new' } }, classifierVersion: 'v2', updatedAt: '2026-04-23T00:00:00Z' };
    setCachedPipelineRegistries({ gas: freshGas });

    const after = getCachedPipelineRegistries();
    assert.equal(after.gas, freshGas);
    assert.equal(after.oil, undefined);
    assert.equal(after.source, 'rpc');
  });

  test('partial update preserves the other commodity', () => {
    const { reader } = countingReader({
      pipelinesGas: GAS_FIXTURE,
      pipelinesOil: OIL_FIXTURE,
    });
    __setBootstrapReaderForTests(reader);
    getCachedPipelineRegistries();

    const freshOil = { pipelines: { druzhba2: { id: 'druzhba2' } }, classifierVersion: 'v2', updatedAt: '2026-04-23T00:00:00Z' };
    setCachedPipelineRegistries({ oil: freshOil });

    const after = getCachedPipelineRegistries();
    assert.equal(after.gas, GAS_FIXTURE, 'gas stays from bootstrap');
    assert.equal(after.oil, freshOil, 'oil updated from RPC');
    assert.equal(after.source, 'rpc');
  });

  test('setCachedPipelineRegistries works even if drain never ran (RPC-first path)', () => {
    const { reader, calls } = countingReader({});
    __setBootstrapReaderForTests(reader);

    const freshGas = { pipelines: { a: { id: 'a' } }, classifierVersion: 'v1', updatedAt: '2026-04-22T00:00:00Z' };
    const freshOil = { pipelines: { b: { id: 'b' } }, classifierVersion: 'v1', updatedAt: '2026-04-22T00:00:00Z' };
    setCachedPipelineRegistries({ gas: freshGas, oil: freshOil });

    const after = getCachedPipelineRegistries();
    // Drain never happened — reader must not be invoked.
    assert.equal(calls.count, 0, 'reader not invoked on pure RPC-first path');
    assert.equal(after.gas, freshGas);
    assert.equal(after.oil, freshOil);
  });
});
