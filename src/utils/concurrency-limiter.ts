/**
 * Concurrency Limiter — runs async tasks with a bounded pool.
 *
 * ```ts
 * const limiter = createConcurrencyLimiter(4);
 * const results = await limiter.mapSettled(urls, url => fetch(url));
 * ```
 */

export interface ConcurrencyLimiter {
  /**
   * Run up to `concurrency` tasks in parallel, returning settled results in
   * the same order as the input array (matching `Promise.allSettled` semantics).
   */
  mapSettled<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<PromiseSettledResult<R>[]>;
}

export function createConcurrencyLimiter(concurrency: number): ConcurrencyLimiter {
  const limit = Math.max(1, Math.floor(concurrency));

  return {
    async mapSettled<T, R>(
      items: T[],
      fn: (item: T, index: number) => Promise<R>,
    ): Promise<PromiseSettledResult<R>[]> {
      const results: PromiseSettledResult<R>[] = Array.from({length: items.length});
      let next = 0;

      async function worker(): Promise<void> {
        while (next < items.length) {
          const idx = next++;
          const item = items[idx];
          try {
            const value = await fn(item as T, idx);
            results[idx] = { status: 'fulfilled', value };
          } catch (error) {
            results[idx] = { status: 'rejected', reason: error };
          }
        }
      }

      const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
      await Promise.all(workers);
      return results;
    },
  };
}
