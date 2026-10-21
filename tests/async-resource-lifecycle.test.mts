import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AsyncResourceLifecycle } from '../src/workers/async-resource-lifecycle.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AsyncResourceLifecycle', () => {
  it('deduplicates concurrent loads and retries after a failed load', async () => {
    const loadGate = deferred<{ id: number }>();
    const lifecycle = new AsyncResourceLifecycle<string, { id: number }>(() => {});
    let invocations = 0;
    const loader = () => {
      invocations++;
      return loadGate.promise;
    };

    const first = lifecycle.load('model', loader);
    const joined = lifecycle.load('model', loader);
    assert.equal(invocations, 1);
    loadGate.resolve({ id: 1 });
    assert.equal((await first).id, 1);
    assert.equal((await joined).id, 1);

    const retrying = new AsyncResourceLifecycle<string, { id: number }>(() => {});
    let retries = 0;
    await assert.rejects(
      retrying.load('model', async () => {
        retries++;
        throw new Error('CDN hiccup');
      }),
      /CDN hiccup/,
    );
    assert.equal(
      (await retrying.load('model', async () => ({ id: ++retries }))).id,
      2,
    );
  });

  it('waits for active use before disposal and blocks a replacement load', async () => {
    const useGate = deferred<void>();
    const useStarted = deferred<void>();
    const disposed: number[] = [];
    let nextId = 0;
    const lifecycle = new AsyncResourceLifecycle<string, { id: number }>(async ({ id }) => {
      disposed.push(id);
    });
    const loader = async () => ({ id: ++nextId });

    const firstUse = lifecycle.use('model', loader, async ({ id }) => {
      useStarted.resolve();
      await useGate.promise;
      return id;
    });
    await useStarted.promise;

    const unload = lifecycle.unload('model');
    const replacement = lifecycle.use('model', loader, async ({ id }) => id);
    await Promise.resolve();
    assert.deepEqual(disposed, [], 'active inference keeps its pipeline alive');
    assert.equal(nextId, 1, 'replacement load waits for disposal');

    useGate.resolve();
    assert.equal(await firstUse, 1);
    assert.equal(await unload, true);
    assert.deepEqual(disposed, [1]);
    assert.equal(await replacement, 2);
  });

  it('waits for an in-flight load before unloading it', async () => {
    const loadGate = deferred<{ id: number }>();
    const disposed: number[] = [];
    const lifecycle = new AsyncResourceLifecycle<string, { id: number }>(({ id }) => {
      disposed.push(id);
    });

    const loading = lifecycle.load('model', () => loadGate.promise);
    const unloading = lifecycle.unload('model');
    loadGate.resolve({ id: 7 });

    assert.equal((await loading).id, 7);
    assert.equal(await unloading, true);
    assert.deepEqual(disposed, [7]);
  });

  it('keeps the resource registered when disposal fails so cleanup can be retried', async () => {
    let shouldFail = true;
    const lifecycle = new AsyncResourceLifecycle<string, { id: number }>(() => {
      if (shouldFail) throw new Error('dispose failed');
    });
    await lifecycle.load('model', async () => ({ id: 1 }));

    await assert.rejects(lifecycle.unload('model'), /dispose failed/);
    assert.deepEqual(lifecycle.keys(), ['model']);

    shouldFail = false;
    assert.equal(await lifecycle.unload('model'), true);
    assert.deepEqual(lifecycle.keys(), []);
  });

  it('reset waits for every loaded resource to dispose', async () => {
    const disposeGate = deferred<void>();
    const disposed: string[] = [];
    const lifecycle = new AsyncResourceLifecycle<string, string>(async (value) => {
      disposed.push(value);
      await disposeGate.promise;
    });
    await Promise.all([
      lifecycle.load('a', async () => 'a'),
      lifecycle.load('b', async () => 'b'),
    ]);

    let completed = false;
    const reset = lifecycle.reset().then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.deepEqual(disposed.sort(), ['a', 'b']);

    disposeGate.resolve();
    await reset;
    assert.equal(completed, true);
    assert.deepEqual(lifecycle.keys(), []);
  });
});
