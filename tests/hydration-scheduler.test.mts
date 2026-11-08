import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHydrationTier, slotReleasingTask, type HydrationTask } from '@/app/hydration-scheduler';

function createInstrumentedTasks(count: number, state: { active: number; maxActive: number }): HydrationTask[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `task-${index}`,
    task: async () => {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      await Promise.resolve();
      state.active -= 1;
    },
  }));
}

test('runs mobile tier work one task at a time and yields between tasks (#5165)', async () => {
  const state = { active: 0, maxActive: 0 };
  let yields = 0;

  await runHydrationTier({
    tasks: createInstrumentedTasks(3, state),
    maxConcurrency: 1,
    yieldToMain: async () => { yields += 1; },
    onFailure: () => assert.fail('all instrumented tasks should succeed'),
  });

  assert.equal(state.maxActive, 1);
  assert.equal(yields, 2, 'each remaining task starts after a cooperative yield');
});

test('preserves desktop normal and force-all tier concurrency', async () => {
  for (const [maxConcurrency, expectedYields] of [[3, 1], [6, 0]] as const) {
    const state = { active: 0, maxActive: 0 };
    let yields = 0;
    await runHydrationTier({
      tasks: createInstrumentedTasks(6, state),
      maxConcurrency,
      yieldToMain: async () => { yields += 1; },
      onFailure: () => assert.fail('all instrumented tasks should succeed'),
    });
    assert.equal(state.maxActive, maxConcurrency);
    assert.equal(yields, expectedYields);
  }
});

test('reports individual rejected panel loaders and continues the tier', async () => {
  const failures: Array<{ name: string; reason: unknown }> = [];
  await runHydrationTier({
    tasks: [
      { name: 'fails', task: async () => { throw new Error('nope'); } },
      { name: 'succeeds', task: async () => {} },
    ],
    maxConcurrency: 1,
    yieldToMain: async () => {},
    onFailure: (name, reason) => failures.push({ name, reason }),
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.name, 'fails');
  assert.equal((failures[0]?.reason as Error).message, 'nope');
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a slot-releasing task lets the next task start before it finishes', async () => {
  const finishSlow = deferred();
  const events: string[] = [];
  const pending: Promise<void>[] = [];
  const slow = slotReleasingTask('news', async (releaseSlot) => {
    events.push('news:start');
    releaseSlot();
    await finishSlow.promise;
    events.push('news:end');
  }, pending);
  const next: HydrationTask = {
    name: 'markets',
    task: async () => { events.push('markets:start'); },
  };

  await runHydrationTier({
    tasks: [slow, next],
    maxConcurrency: 1,
    yieldToMain: async () => {},
    onFailure: () => assert.fail('no task should fail'),
  });

  assert.deepEqual(events, ['news:start', 'markets:start']);
  assert.equal(pending.length, 1);

  finishSlow.resolve();
  await Promise.all(pending);
  assert.deepEqual(events, ['news:start', 'markets:start', 'news:end']);
});

test('a slot-releasing task that never releases holds its slot until it settles', async () => {
  const events: string[] = [];
  const pending: Promise<void>[] = [];
  const slow = slotReleasingTask('news', async () => {
    events.push('news:start');
    await Promise.resolve();
    events.push('news:end');
  }, pending);

  await runHydrationTier({
    tasks: [slow, { name: 'markets', task: async () => { events.push('markets:start'); } }],
    maxConcurrency: 1,
    yieldToMain: async () => {},
    onFailure: () => assert.fail('no task should fail'),
  });

  assert.deepEqual(events, ['news:start', 'news:end', 'markets:start']);
});

test('a failure after the slot is released settles pending without rejecting', async () => {
  const fail = deferred();
  const pending: Promise<void>[] = [];
  const task = slotReleasingTask('news', async (releaseSlot) => {
    releaseSlot();
    await fail.promise;
  }, pending);

  await task.task();
  fail.reject(new Error('late digest failure'));
  await assert.doesNotReject(Promise.all(pending));
});

test('a failure before the slot is released reaches the scheduler', async () => {
  const failures: string[] = [];
  const pending: Promise<void>[] = [];
  await runHydrationTier({
    tasks: [slotReleasingTask('news', async () => { throw new Error('boom'); }, pending)],
    maxConcurrency: 1,
    yieldToMain: async () => {},
    onFailure: (name) => failures.push(name),
  });
  assert.deepEqual(failures, ['news']);
  await assert.doesNotReject(Promise.all(pending));
});
