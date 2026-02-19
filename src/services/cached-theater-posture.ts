/**
 * Cached Theater Posture Service
 * Fetches pre-computed theater posture summaries from backend
 * Shares calculation across all users via Redis cache
 * Persists to localStorage so data shows instantly on reload
 */

import type { TheaterPostureSummary } from './military-surge';
import { fetchWithCache } from '@/utils';

export interface CachedTheaterPosture {
  postures: TheaterPostureSummary[];
  totalFlights: number;
  timestamp: string;
  cached: boolean;
  stale?: boolean;
  error?: string;
}

const LS_KEY = 'wm:theater-posture';
const LS_MAX_AGE_MS = 30 * 60 * 1000; // 30 min max staleness for localStorage

let cachedPosture: CachedTheaterPosture | null = null;
let fetchPromise: Promise<CachedTheaterPosture | null> | null = null;
let lastFetchTime = 0;
const REFETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (matches server TTL)

function loadFromStorage(): CachedTheaterPosture | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { data, savedAt } = JSON.parse(raw);
    if (Date.now() - savedAt > LS_MAX_AGE_MS) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    return { ...data, stale: true };
  } catch {
    return null;
  }
}

function saveToStorage(data: CachedTheaterPosture): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ data, savedAt: Date.now() }));
  } catch { /* quota exceeded - ignore */ }
}

// Hydrate in-memory cache from localStorage on module load
const stored = loadFromStorage();
if (stored) {
  cachedPosture = stored;
  console.log('[CachedTheaterPosture] Restored from localStorage (stale)');
}

export async function fetchCachedTheaterPosture(): Promise<CachedTheaterPosture | null> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedPosture && !cachedPosture.stale && now - lastFetchTime < REFETCH_INTERVAL_MS) {
    return cachedPosture;
  }

  // Deduplicate concurrent fetches
  if (fetchPromise) {
    return fetchPromise;
  }

  // If we have stale localStorage data, return it immediately but fetch in background
  const hasStaleData = cachedPosture?.stale;

  fetchPromise = (async () => {
    try {
      const data = await fetchWithCache<CachedTheaterPosture>('/api/theater-posture', { ttl: 300_000 });
      cachedPosture = data;
      lastFetchTime = Date.now();
      saveToStorage(data);
      console.log(
        '[CachedTheaterPosture] Loaded',
        data.cached ? '(from Redis)' : '(computed)',
        `${data.postures?.length || 0} theaters, ${data.totalFlights || 0} flights`
      );
      return cachedPosture;
    } catch (error) {
      console.error('[CachedTheaterPosture] Fetch error:', error);
      return cachedPosture; // Return stale cache on error
    } finally {
      fetchPromise = null;
    }
  })();

  // If we have stale data, return it now — the fetch updates in background
  if (hasStaleData) {
    return cachedPosture;
  }

  return fetchPromise;
}

export function getCachedPosture(): CachedTheaterPosture | null {
  return cachedPosture;
}

export function hasCachedPosture(): boolean {
  return cachedPosture !== null;
}
