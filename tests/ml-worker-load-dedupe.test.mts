import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createLoadDeduper } from '../src/workers/load-dedupe.ts';

// Guards the in-flight load de-duplication the ML worker uses for model
// downloads (#5425). The original inline implementation deleted the shared
// promise only on the SUCCESS path, so one transient pipeline() failure
// (offline, HF CDN hiccup) cached a rejected promise for the rest of the
// session — every ML feature stayed dead until a page reload even after the
// network recovered.

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createLoadDeduper', () => {
  it('the ML worker binds one module-scoped deduper around the real pipeline load', async () => {
    const workerSource = await readFile(
      new URL('../src/workers/ml.worker.ts', import.meta.url),
      'utf8',
    );

    assert.match(
      workerSource,
      /const modelLoads = createLoadDeduper<string>\(\);/,
      'the worker must keep one shared deduper for the module lifetime',
    );
    assert.match(
      workerSource,
      /return modelLoads\.run\(modelId, async \(\) => \{/,
      'loadModel must route the real pipeline construction through the shared deduper',
    );
  });

  it('concurrent callers share one loader invocation', async () => {
    const deduper = createLoadDeduper();
    const gate = deferred();
    let invocations = 0;
    const loader = () => {
      invocations++;
      return gate.promise;
    };

    const first = deduper.run('embeddings', loader);
    const second = deduper.run('embeddings', loader);
    assert.equal(invocations, 1, 'second concurrent call must reuse the in-flight load');
    assert.equal(deduper.isLoading('embeddings'), true);

    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(deduper.isLoading('embeddings'), false, 'entry must clear after settle');
  });

  it('#5425 regression: a failed load is retried on the next call instead of replaying the cached rejection', async () => {
    const deduper = createLoadDeduper();
    let invocations = 0;
    const loader = () => {
      invocations++;
      return invocations === 1
        ? Promise.reject(new Error('Failed to fetch'))
        : Promise.resolve();
    };

    // Call 1: offline — the load rejects.
    await assert.rejects(deduper.run('embeddings', loader), /Failed to fetch/);
    assert.equal(deduper.isLoading('embeddings'), false, 'a settled (rejected) load must not stay cached');

    // Call 2: back online — must re-invoke the loader and succeed.
    // (The pre-fix behavior returned the cached rejection with invocations
    // stuck at 1: `call 1 rejected -> call 2 rejected | pipeline() invoked 1x`.)
    await deduper.run('embeddings', loader);
    assert.equal(invocations, 2, 'the next call after a failure must start a fresh load');
  });

  it('a failure is shared by callers that joined DURING the load, not by later ones', async () => {
    const deduper = createLoadDeduper();
    const gate = deferred();
    let invocations = 0;
    const loader = () => {
      invocations++;
      return invocations === 1 ? gate.promise : Promise.resolve();
    };

    const first = deduper.run('m', loader);
    const joined = deduper.run('m', loader);
    gate.reject(new Error('CDN hiccup'));

    // Both in-flight callers see the same failure (one download, one answer)...
    await assert.rejects(first, /CDN hiccup/);
    await assert.rejects(joined, /CDN hiccup/);
    assert.equal(invocations, 1);

    // ...but a caller arriving after the settle gets a fresh attempt.
    await deduper.run('m', loader);
    assert.equal(invocations, 2);
  });

  it('keys are independent — one model failing does not affect another', async () => {
    const deduper = createLoadDeduper();
    await assert.rejects(
      deduper.run('summarization', () => Promise.reject(new Error('boom'))),
      /boom/,
    );
    let loaded = false;
    await deduper.run('embeddings', () => {
      loaded = true;
      return Promise.resolve();
    });
    assert.equal(loaded, true);
  });
});
