/**
 * Cached Theater Posture Service
 * Fetches pre-computed theater posture summaries from backend
 * Shares calculation across all users via Redis cache
 */

import type { TheaterPostureSummary } from './military-surge';

export interface CachedTheaterPosture {
  postures: TheaterPostureSummary[];
  totalFlights: number;
  timestamp: string;
  cached: boolean;
  stale?: boolean;
  error?: string;
}

let cachedPosture: CachedTheaterPosture | null = null;
let fetchPromise: Promise<CachedTheaterPosture | null> | null = null;
let lastFetchTime = 0;
const REFETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (matches server TTL)

export async function fetchCachedTheaterPosture(): Promise<CachedTheaterPosture | null> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedPosture && now - lastFetchTime < REFETCH_INTERVAL_MS) {
    return cachedPosture;
  }

  // Deduplicate concurrent fetches
  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch('/api/theater-posture');
      if (!response.ok) {
        console.warn('[CachedTheaterPosture] API error:', response.status);
        return cachedPosture; // Return stale cache on error
      }

      const data = await response.json();
      cachedPosture = data;
      lastFetchTime = now;
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

  return fetchPromise;
}

export function getCachedPosture(): CachedTheaterPosture | null {
  return cachedPosture;
}

export function hasCachedPosture(): boolean {
  return cachedPosture !== null;
}
