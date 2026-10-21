import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yieldToMain, scheduleYield } from '@/utils/after-paint';

type SchedulerHost = { scheduler?: { yield?: () => Promise<void> } };

function withScheduler<T>(value: SchedulerHost['scheduler'] | undefined, run: () => T): T {
  const host = globalThis as unknown as SchedulerHost;
  const had = 'scheduler' in host;
  const prev = host.scheduler;
  if (value === undefined) {
    delete host.scheduler;
  } else {
    host.scheduler = value;
  }
  try {
    return run();
  } finally {
    if (had) host.scheduler = prev;
    else delete host.scheduler;
  }
}

test('yieldToMain uses native scheduler.yield when available (R7)', async () => {
  let called = 0;
  await withScheduler({ yield: () => { called += 1; return Promise.resolve(); } }, async () => {
    await yieldToMain();
  });
  assert.equal(called, 1, 'scheduler.yield should be awaited exactly once');
});

test('yieldToMain falls back to setTimeout(0) when scheduler.yield is absent (R7)', async () => {
  await withScheduler(undefined, async () => {
    // Must resolve without a Scheduler API present.
    await yieldToMain();
  });
  assert.ok(true, 'fallback path resolved');
});

test('yieldToMain falls back when scheduler exists but lacks yield (R7)', async () => {
  await withScheduler({}, async () => {
    await yieldToMain();
  });
  assert.ok(true, 'partial-scheduler fallback resolved');
});

test('yieldToMain returns a Promise in both paths (signature preserved)', () => {
  const withYield = withScheduler({ yield: () => Promise.resolve() }, () => yieldToMain());
  const withoutYield = withScheduler(undefined, () => yieldToMain());
  assert.ok(withYield instanceof Promise);
  assert.ok(withoutYield instanceof Promise);
  return Promise.all([withYield, withoutYield]);
});

test('scheduleYield runs the callback after the yield resolves (#5042 U4)', async () => {
  let ran = 0;
  await withScheduler({ yield: () => Promise.resolve() }, async () => {
    scheduleYield(() => { ran += 1; });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(ran, 1, 'callback fires once after the yield');
});

test('scheduleYield cancel before resolution prevents the callback (coalesce/teardown, U4)', async () => {
  let ran = 0;
  await withScheduler({ yield: () => Promise.resolve() }, async () => {
    const cancel = scheduleYield(() => { ran += 1; });
    cancel();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(ran, 0, 'a pre-resolution cancel drops the flush');
});

test('scheduleYield rethrows deferred callback errors on the timer channel (#5042 U4)', async () => {
  const sentinel = new Error('deferred flush failed');
  let timerHandler: (() => void) | null = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: Parameters<typeof globalThis.setTimeout>[0]) => {
    assert.equal(typeof handler, 'function', 'scheduleYield should surface errors with a function timer');
    timerHandler = handler as () => void;
    return 0 as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;

  try {
    await withScheduler({ yield: () => Promise.resolve() }, async () => {
      scheduleYield(() => { throw sentinel; });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.ok(timerHandler, 'failed deferred flush should be rethrown via setTimeout');
    assert.throws(
      () => { timerHandler?.(); },
      (err) => err === sentinel,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
