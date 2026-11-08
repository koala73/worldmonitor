import { describe, expect, it } from 'vitest';

import type { AppContext } from '@/app/app-context';
import { slotReleasingTask, type HydrationTask } from '@/app/hydration-scheduler';

interface HydrationInternals {
  runHydrationTasks(
    tasks: HydrationTask[],
    forceAll: boolean,
    releasedTasks?: readonly Promise<void>[],
  ): Promise<void>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function makeLoader(isMobile: boolean) {
  const ctx = { isMobile, isDestroyed: false } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, {
    renderCriticalBanner: () => undefined,
    refreshOpenCountryBrief: () => undefined,
  });
  return loader as unknown as HydrationInternals;
}

describe('a news load waiting on a late digest', () => {
  it.each([true, false])('frees tiers 1-3 but holds tier 4 until news finishes (mobile=%s)', async (isMobile) => {
    const internal = await makeLoader(isMobile);
    const lateDigest = deferred();
    const events: string[] = [];
    const releasedTasks: Promise<void>[] = [];
    const record = (name: string): HydrationTask => ({
      name,
      task: async () => { events.push(name); },
    });

    const run = internal.runHydrationTasks([
      slotReleasingTask('news', async (releaseSlot) => {
        events.push('news:first-paint');
        releaseSlot();
        await lateDigest.promise;
        events.push('news:done');
      }, releasedTasks),
      record('markets'),
      record('natural'),
      record('predictions'),
    ], false, releasedTasks);

    await expect.poll(() => events).toContain('natural');
    expect(events).toEqual(['news:first-paint', 'markets', 'natural']);

    lateDigest.resolve();
    await run;
    expect(events).toEqual(['news:first-paint', 'markets', 'natural', 'news:done', 'predictions']);
  });
});
