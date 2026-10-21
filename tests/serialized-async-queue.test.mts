import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SerializedAsyncQueue } from '../src/utils/serialized-async-queue.ts';

describe('SerializedAsyncQueue', () => {
  it('starts the first task synchronously and runs later tasks in FIFO order', async () => {
    const queue = new SerializedAsyncQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 1;
    });
    const second = queue.run(async () => {
      events.push('second');
      return 2;
    });

    assert.equal(queue.busy, true);
    assert.deepEqual(events, ['first:start']);

    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second']);
    assert.equal(queue.busy, false);
  });

  it('continues draining after a task rejects', async () => {
    const queue = new SerializedAsyncQueue();
    const failure = queue.run(() => {
      throw new Error('expected failure');
    });
    const recovery = queue.run(() => 'recovered');

    await assert.rejects(failure, /expected failure/);
    assert.equal(await recovery, 'recovered');
    assert.equal(queue.busy, false);
  });

  it('continues draining after an asynchronous rejection', async () => {
    const queue = new SerializedAsyncQueue();
    const events: string[] = [];
    const failure = queue.run(async () => {
      events.push('failure:start');
      await Promise.resolve();
      events.push('failure:reject');
      throw new Error('expected async failure');
    });
    const recovery = queue.run(async () => {
      events.push('recovery');
      return 'recovered';
    });

    assert.equal(queue.busy, true);
    await assert.rejects(failure, /expected async failure/);
    assert.equal(await recovery, 'recovered');
    assert.deepEqual(events, ['failure:start', 'failure:reject', 'recovery']);
    assert.equal(queue.busy, false);
  });
});
