/**
 * De-duplicates concurrent async loads by key: while a load is in flight,
 * every caller shares the same promise; once it SETTLES — success or failure —
 * the entry is dropped so the next call starts a fresh attempt.
 *
 * The settle-time cleanup is the load-bearing part (#5425): deleting the
 * entry only on the success path caches a REJECTED promise forever, so one
 * transient failure (offline, CDN hiccup) replays the same rejection to every
 * later caller without ever re-attempting the load. Callers that want a
 * success cache (e.g. the ML worker's loadedPipelines) keep it separately —
 * this map only tracks in-flight work.
 */
export function createLoadDeduper<K = string>() {
  const inFlight = new Map<K, Promise<void>>();
  return {
    run(key: K, loader: () => Promise<void>): Promise<void> {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const load = loader().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, load);
      return load;
    },
    isLoading(key: K): boolean {
      return inFlight.has(key);
    },
  };
}
