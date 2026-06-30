import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yieldToMain } from '@/utils/after-paint';

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
