/**
 * Serialize work that must remain synchronous internally while yielding before
 * each item starts. A rejected item never blocks later work.
 */
export function createYieldingWorkQueue(yieldToMain: () => Promise<void>) {
  let tail = Promise.resolve();

  return function enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const current = tail.then(async () => {
      await yieldToMain();
      return work();
    });
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
}
