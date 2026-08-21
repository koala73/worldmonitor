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

  return {
    /** Consume the bootstrap slot once. A valid value is retained for read(). */
    accept(): T | null {
      const raw = getHydratedData(key);
      if (raw === undefined) return null;
      const data = validate(raw);
      if (data !== null) entry = { data, acceptedAt: Date.now() };
      return data;
    },
    /** Latest accepted value, or null once the TTL has expired. */
    read(): T | null {
      if (entry === null) return null;
      if (Date.now() - entry.acceptedAt > ttlMs) {
        entry = null;
        return null;
      }
      return entry.data;
    },
  };
}
