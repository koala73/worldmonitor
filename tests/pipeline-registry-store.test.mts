import { strict as assert } from 'node:assert';
import { test, describe, beforeEach } from 'node:test';
import {
  ensurePipelineRegistriesHydrated,
  getCachedPipelineRegistries,
  setCachedPipelineRegistries,
  __resetPipelineRegistryStoreForTests,
  __setBootstrapReaderForTests,
  __setOnDemandLoaderForTests,
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

  test('ensureHydrated path coalesces one in-flight fetch and stores the result', async () => {
    const { reader, calls } = countingReader({});
    __setBootstrapReaderForTests(reader);
    let loaderCalls = 0;
    __setOnDemandLoaderForTests(async (key) => {
      loaderCalls += 1;
      await Promise.resolve();
      return key === 'pipelinesGas' ? GAS_FIXTURE : OIL_FIXTURE;
    });

    const [first, second] = await Promise.all([
      ensurePipelineRegistriesHydrated(),
      ensurePipelineRegistriesHydrated(),
    ]);
    assert.equal(first.gas, GAS_FIXTURE);
    assert.equal(first.oil, OIL_FIXTURE);
    assert.equal(second.gas, GAS_FIXTURE);
    assert.equal(loaderCalls, 2, 'one fetch per key, shared across concurrent callers');
    assert.equal(calls.count, 2, 'rolling-deploy drain still runs once');

    const third = await ensurePipelineRegistriesHydrated();
    assert.equal(third.gas, GAS_FIXTURE);
    assert.equal(loaderCalls, 2, 'resolved value is reused; no second fetch');
  });

  test('failed on-demand hydration clears the in-flight guard so a retry can succeed', async () => {
    const { reader } = countingReader({});
    __setBootstrapReaderForTests(reader);
    const requestedKeys: string[] = [];
    let failing = true;
    __setOnDemandLoaderForTests(async (key) => {
      requestedKeys.push(key);
      if (failing) throw new Error(`temporary ${key} failure`);
      return key === 'pipelinesGas' ? GAS_FIXTURE : OIL_FIXTURE;
    });

    await assert.rejects(ensurePipelineRegistriesHydrated(), /temporary pipelines/);
    failing = false;

    const retried = await ensurePipelineRegistriesHydrated();
    assert.equal(retried.gas, GAS_FIXTURE);
    assert.equal(retried.oil, OIL_FIXTURE);
    assert.deepEqual(requestedKeys, [
      'pipelinesGas',
      'pipelinesOil',
      'pipelinesGas',
      'pipelinesOil',
    ], 'the retry must issue one new request for each still-missing key');
  });

  test('refresh re-fetches even when the store already has data', async () => {
    const { reader } = countingReader({
      pipelinesGas: GAS_FIXTURE,
      pipelinesOil: OIL_FIXTURE,
    });
    __setBootstrapReaderForTests(reader);
    const refreshedGas = { pipelines: { refreshed: { id: 'refreshed' } } };
    let loaderCalls = 0;
    __setOnDemandLoaderForTests(async (key) => {
      loaderCalls += 1;
      return key === 'pipelinesGas' ? refreshedGas : OIL_FIXTURE;
    });

    await ensurePipelineRegistriesHydrated();
    assert.equal(loaderCalls, 0);
    const refreshed = await ensurePipelineRegistriesHydrated({ refresh: true });
    assert.equal(refreshed.gas, refreshedGas);
    assert.equal(loaderCalls, 2);
  });

  test('partial leftover still fetches the missing commodity', async () => {
    const { reader } = countingReader({ pipelinesGas: GAS_FIXTURE });
    __setBootstrapReaderForTests(reader);
    const requestedKeys: string[] = [];
    __setOnDemandLoaderForTests(async (key) => {
      requestedKeys.push(key);
      return key === 'pipelinesOil' ? OIL_FIXTURE : undefined;
    });

    const result = await ensurePipelineRegistriesHydrated();
    assert.equal(result.gas, GAS_FIXTURE);
    assert.equal(result.oil, OIL_FIXTURE);
    assert.deepEqual(requestedKeys, ['pipelinesOil'], 'only the missing new-tier key is requested');
  });

  test('rolling-deploy leftover wins and skips the on-demand fetch', async () => {
    const { reader } = countingReader({
      pipelinesGas: GAS_FIXTURE,
      pipelinesOil: OIL_FIXTURE,
    });
    __setBootstrapReaderForTests(reader);
    let loaderCalls = 0;
    __setOnDemandLoaderForTests(async () => {
      loaderCalls += 1;
      return undefined;
    });

    const result = await ensurePipelineRegistriesHydrated();
    assert.equal(result.gas, GAS_FIXTURE);
    assert.equal(result.source, 'bootstrap');
    assert.equal(loaderCalls, 0);
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
