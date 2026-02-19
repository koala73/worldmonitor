/**
 * Cached Risk Scores Service
 * Fetches pre-computed CII and Strategic Risk scores from backend
 * Eliminates 15-minute learning mode for users
 */

import type { CountryScore, ComponentScores } from './country-instability';
import { setHasCachedScores } from './country-instability';
import { getPersistentCache, setPersistentCache } from './persistent-cache';

export interface CachedCIIScore {
  code: string;
  name: string;
  score: number;
  level: 'low' | 'normal' | 'elevated' | 'high' | 'critical';
  trend: 'rising' | 'stable' | 'falling';
  change24h: number;
  components: ComponentScores;
  lastUpdated: string;
}

export interface CachedStrategicRisk {
  score: number;
  level: string;
  trend: string;
  lastUpdated: string;
  contributors: Array<{
    country: string;
    code: string;
    score: number;
    level: string;
  }>;
}

export interface CachedRiskScores {
  cii: CachedCIIScore[];
  strategicRisk: CachedStrategicRisk;
  protestCount: number;
  computedAt: string;
  cached: boolean;
}

const RISK_CACHE_KEY = 'risk-scores:latest';
let cachedScores: CachedRiskScores | null = null;
let fetchPromise: Promise<CachedRiskScores | null> | null = null;
let lastFetchTime = 0;
const REFETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function loadPersistentRiskScores(): Promise<CachedRiskScores | null> {
  const entry = await getPersistentCache<CachedRiskScores>(RISK_CACHE_KEY);
  return entry?.data ?? null;
}

export async function fetchCachedRiskScores(signal?: AbortSignal): Promise<CachedRiskScores | null> {
  const now = Date.now();

  if (cachedScores && now - lastFetchTime < REFETCH_INTERVAL_MS) {
    return cachedScores;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch('/api/risk-scores', { signal });
      if (!response.ok) {
        console.warn('[CachedRiskScores] API error:', response.status);
        return cachedScores ?? await loadPersistentRiskScores();
      }

      const data = await response.json();
      cachedScores = data;
      lastFetchTime = now;
      setHasCachedScores(true);
      void setPersistentCache(RISK_CACHE_KEY, data);
      console.log('[CachedRiskScores] Loaded', data.cached ? '(from Redis)' : '(computed)');
      return cachedScores;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      console.error('[CachedRiskScores] Fetch error:', error);
      return cachedScores ?? await loadPersistentRiskScores();
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

export function getCachedScores(): CachedRiskScores | null {
  return cachedScores;
}

export function hasCachedScores(): boolean {
  return cachedScores !== null;
}

export function toCountryScore(cached: CachedCIIScore): CountryScore {
  return {
    code: cached.code,
    name: cached.name,
    score: cached.score,
    level: cached.level,
    trend: cached.trend,
    change24h: cached.change24h,
    components: cached.components,
    lastUpdated: new Date(cached.lastUpdated),
  };
}
