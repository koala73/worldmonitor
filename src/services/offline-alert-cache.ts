/**
 * Offline Alert Cache — Emergency-resilient data persistence
 *
 * The PWA's Workbox config marks /api/* as NetworkOnly, meaning alerts
 * disappear when the network drops. During emergencies, cell towers saturate
 * and connectivity is unreliable — exactly when you need the data most.
 *
 * This layer:
 *  1. Persists the last-known alert snapshot to localStorage after each fetch
 *  2. Returns stale data with staleness metadata when network fails
 *  3. Expires stale data after configurable TTL (default: 4 hours)
 *  4. Tracks when each service last had a live fetch vs. serving from cache
 *
 * Usage — wrap any fetch call:
 *   const alerts = await withOfflineCache('nws-alerts', fetchNwsAlerts, 4 * 3600_000);
 */

export interface CachedSnapshot<T> {
  data: T;
  cachedAt: number;       // unix ms
  expiresAt: number;      // unix ms
  isStale: boolean;       // true when served from offline cache
  staleDurationMs: number; // how long since last live fetch
  source: 'network' | 'offline-cache';
}

export interface OfflineCacheEntry<T> {
  data: T;
  cachedAt: number;
  version: number;
}

const CACHE_VERSION = 1;
const PREFIX = 'wm_offline_';

function storageKey(serviceId: string): string {
  return `${PREFIX}${serviceId}`;
}

function readEntry<T>(serviceId: string): OfflineCacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(storageKey(serviceId));
    if (!raw) return null;
    const entry = JSON.parse(raw) as OfflineCacheEntry<T>;
    if (entry.version !== CACHE_VERSION) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeEntry<T>(serviceId: string, data: T): void {
  try {
    const entry: OfflineCacheEntry<T> = {
      data,
      cachedAt: Date.now(),
      version: CACHE_VERSION,
    };
    localStorage.setItem(storageKey(serviceId), JSON.stringify(entry));
  } catch {
    // localStorage might be full — fail silently
  }
}

export function readOfflineCacheEntry<T>(serviceId: string): OfflineCacheEntry<T> | null {
  return readEntry<T>(serviceId);
}

export function writeOfflineCacheEntry<T>(serviceId: string, data: T): void {
  writeEntry(serviceId, data);
}

function clearEntry(serviceId: string): void {
  try { localStorage.removeItem(storageKey(serviceId)); } catch { /* noop */ }
}

/**
 * Wraps a fetch function with offline fallback cache.
 *
 * @param serviceId  Unique key for this service (e.g. 'nws-alerts')
 * @param fetchFn    The actual network fetch function
 * @param staleMs    How long to trust cached data (default: 4 hours)
 */
export async function withOfflineCache<T>(
  serviceId: string,
  fetchFn: () => Promise<T>,
  staleMs = 4 * 3_600_000
): Promise<CachedSnapshot<T>> {
  try {
    const data = await fetchFn();
    // Network succeeded — update cache
    writeEntry(serviceId, data);
    return {
      data,
      cachedAt: Date.now(),
      expiresAt: Date.now() + staleMs,
      isStale: false,
      staleDurationMs: 0,
      source: 'network',
    };
  } catch (error) {
    // Network failed — try offline cache
    const entry = readEntry<T>(serviceId);
    if (entry) {
      const staleDurationMs = Date.now() - entry.cachedAt;
      if (staleDurationMs < staleMs) {
        return {
          data: entry.data,
          cachedAt: entry.cachedAt,
          expiresAt: entry.cachedAt + staleMs,
          isStale: true,
          staleDurationMs,
          source: 'offline-cache',
        };
      }
      // Cache expired — still return it but mark expired
      return {
        data: entry.data,
        cachedAt: entry.cachedAt,
        expiresAt: entry.cachedAt + staleMs,
        isStale: true,
        staleDurationMs,
        source: 'offline-cache',
      };
    }
    throw error; // No cache, re-throw
  }
}

/**
 * Pre-warm the offline cache by fetching all registered services.
 * Call this when the app is online and idle.
 */
interface CachableService { id: string; fetch: () => Promise<unknown>; staleMs?: number }
const registeredServices: CachableService[] = [];

export function registerForOfflineCache(
  serviceId: string,
  fetchFn: () => Promise<unknown>,
  staleMs = 4 * 3_600_000
): void {
  if (!registeredServices.find(s => s.id === serviceId)) {
    registeredServices.push({ id: serviceId, fetch: fetchFn, staleMs });
  }
}

export async function prewarmOfflineCache(): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  await Promise.allSettled(
    registeredServices.map(async svc => {
      try {
        const data = await svc.fetch();
        writeEntry(svc.id, data);
        succeeded.push(svc.id);
      } catch {
        failed.push(svc.id);
      }
    })
  );

  return { succeeded, failed };
}

/**
 * Get the offline cache status — useful for a status indicator.
 */
export interface OfflineCacheStatus {
  serviceId: string;
  hasCache: boolean;
  cachedAt: Date | null;
  ageMs: number | null;
}

export function getOfflineCacheStatus(serviceIds: string[]): OfflineCacheStatus[] {
  return serviceIds.map(id => {
    const entry = readEntry<unknown>(id);
    return {
      serviceId: id,
      hasCache: entry !== null,
      cachedAt: entry ? new Date(entry.cachedAt) : null,
      ageMs: entry ? Date.now() - entry.cachedAt : null,
    };
  });
}

export function clearOfflineCache(serviceId?: string): void {
  if (serviceId) {
    clearEntry(serviceId);
    return;
  }
  // Clear all
  const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX));
  keys.forEach(k => localStorage.removeItem(k));
}

/**
 * Check if the browser is currently offline.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine;
}

/**
 * Subscribe to online/offline status changes.
 * Returns cleanup function.
 */
export function onConnectivityChange(
  callback: (online: boolean) => void
): () => void {
  const onOnline = () => callback(true);
  const onOffline = () => callback(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
