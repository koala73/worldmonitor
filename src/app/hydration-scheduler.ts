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
