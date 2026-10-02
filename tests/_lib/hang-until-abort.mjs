/**
 * Simulate a request that rejects only on abort. A referenced timer keeps Node
 * alive while waiting for an unreferenced AbortSignal.timeout timer.
 * @param {AbortSignal} signal
 * @returns {Promise<never>}
 */
export function hangUntilAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(signal.reason);
    }, { once: true });
  });
}
