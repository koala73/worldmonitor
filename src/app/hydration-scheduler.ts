export interface HydrationTask {
  name: string;
  task: () => Promise<void>;
}

interface RunHydrationTierOptions {
  tasks: HydrationTask[];
  maxConcurrency: number;
  yieldToMain: () => Promise<void>;
  onFailure: (name: string, reason: unknown) => void;
}

/**
 * Run one priority tier without letting mobile panel loaders merge into the
 * same main-thread task. The caller controls the concurrency policy so desktop
 * force-all hydration retains its existing parallelism. (#5165)
 */
export async function runHydrationTier({
  tasks,
  maxConcurrency,
  yieldToMain,
  onFailure,
}: RunHydrationTierOptions): Promise<void> {
  let cursor = 0;

  while (cursor < tasks.length) {
    const batch = tasks.slice(cursor, cursor + maxConcurrency);
    const results = await Promise.allSettled(batch.map(item => item.task()));
    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        onFailure(batch[idx]?.name ?? 'unknown', result.reason);
      }
    });

    cursor += batch.length;
    if (cursor < tasks.length) await yieldToMain();
  }
}

/**
 * Wrap a loader that can free its concurrency slot before it finishes.
 *
 * The scheduler treats the task as done once the loader calls `releaseSlot`
 * (or settles), so the next task in the tier, and the next tier, can start.
 * The loader's full completion goes into `pending`, which settles without
 * rejecting so a late failure cannot break a caller's `Promise.all`. Callers
 * whose work reads the loader's results wait on `pending`.
 */
export function slotReleasingTask(
  name: string,
  run: (releaseSlot: () => void) => Promise<void>,
  pending: Promise<void>[],
): HydrationTask {
  return {
    name,
    task: () => {
      let releaseSlot!: () => void;
      const released = new Promise<void>((resolve) => { releaseSlot = resolve; });
      const done = run(releaseSlot);
      pending.push(done.then(() => undefined, () => undefined));
      return Promise.race([done, released]);
    },
  };
}
