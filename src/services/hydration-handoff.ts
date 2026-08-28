import { getHydratedData } from '@/services/bootstrap';

/**
 * Service-owned bounded cache for one consume-once bootstrap hydration
 * (#7045 U2 / #7048).
 *
 * `getHydratedData()` deletes a value when it is read, so a recurring loader
 * that returned the hydrated payload directly refetched from its RPC on every
 * later viewport / refresh call. Services that have no circuit breaker or TTL
 * cache of their own use this handoff instead: the accepted bootstrap value
 * keeps answering recurring reads for a bounded window, then expires so the
 * normal fetch path resumes.
 *
 * The default TTL matches the 30-minute `cacheTtlMs` used by the recurring
 * service breakers. One entry per instance — bounded by construction.
 */
export function createHydrationHandoff<T>(
  key: string,
  validate: (value: unknown) => T | null,
  options: { ttlMs?: number } = {},
) {
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  let entry: { data: T; acceptedAt: number } | null = null;
  let inFlight: Promise<T> | null = null;

  const accept = (value: unknown): T | null => {
    const data = validate(value);
    if (data === null) return null;
    entry = { data, acceptedAt: Date.now() };
    return data;
  };

  const read = (): T | null => {
    const raw = getHydratedData(key);
    if (raw !== undefined) {
      const data = accept(raw);
      if (data !== null) return data;
    }

    if (entry === null) return null;
    if (Date.now() - entry.acceptedAt > ttlMs) {
      entry = null;
      return null;
    }
    return entry.data;
  };

  return {
    /** Consume and retain valid hydration, then reuse it until the TTL expires. */
    get: read,

    /** Reuse a valid entry or coalesce and retain one successful live refresh. */
    getOrLoad(load: () => Promise<T>, fallback: T): Promise<T> {
      const accepted = read();
      if (accepted !== null) return Promise.resolve(accepted);
      if (inFlight !== null) return inFlight;

      inFlight = load()
        .then((result) => accept(result) ?? result)
        .catch(() => fallback)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
