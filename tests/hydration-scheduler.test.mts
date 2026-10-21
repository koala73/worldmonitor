import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHydrationTier, type HydrationTask } from '@/app/hydration-scheduler';

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
