/**
 * Cached Risk Scores Service
 * Fetches pre-computed CII and Strategic Risk scores from backend via sebuf RPC.
 * Eliminates 15-minute learning mode for users.
 */

import type { CountryScore, ComponentScores } from './country-instability';
import { setHasCachedScores } from './country-instability';
import { getPersistentCache, setPersistentCache } from './persistent-cache';
import {
  IntelligenceServiceClient,
  type GetRiskScoresResponse,
  type CiiScore,
  type StrategicRisk,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';

// ---- Sebuf client ----

const client = new IntelligenceServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

// ---- Legacy types (preserved for consumer compatibility) ----

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

// ---- Proto → legacy adapters ----

const TIER1_NAMES: Record<string, string> = {
  US: 'United States', RU: 'Russia', CN: 'China', UA: 'Ukraine', IR: 'Iran',
  IL: 'Israel', TW: 'Taiwan', KP: 'North Korea', SA: 'Saudi Arabia', TR: 'Turkey',
  PL: 'Poland', DE: 'Germany', FR: 'France', GB: 'United Kingdom', IN: 'India',
  PK: 'Pakistan', SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
};

const TREND_REVERSE: Record<string, 'rising' | 'stable' | 'falling'> = {
  TREND_DIRECTION_RISING: 'rising',
  TREND_DIRECTION_STABLE: 'stable',
  TREND_DIRECTION_FALLING: 'falling',
};

const SEVERITY_REVERSE: Record<string, string> = {
  SEVERITY_LEVEL_HIGH: 'high',
  SEVERITY_LEVEL_MEDIUM: 'medium',
  SEVERITY_LEVEL_LOW: 'low',
};

function getScoreLevel(score: number): 'low' | 'normal' | 'elevated' | 'high' | 'critical' {
  if (score >= 70) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 40) return 'elevated';
  if (score >= 25) return 'normal';
  return 'low';
}

function toCachedCII(proto: CiiScore): CachedCIIScore {
  return {
    code: proto.region,
    name: TIER1_NAMES[proto.region] || proto.region,
    score: proto.combinedScore,
    level: getScoreLevel(proto.combinedScore),
    trend: TREND_REVERSE[proto.trend] || 'stable',
    change24h: proto.dynamicScore,
    components: {
      unrest: proto.components?.ciiContribution ?? 0,
      conflict: proto.components?.geoConvergence ?? 0,
      security: proto.components?.militaryActivity ?? 0,
      information: proto.components?.newsActivity ?? 0,
    },
    lastUpdated: proto.computedAt ? new Date(proto.computedAt).toISOString() : new Date().toISOString(),
  };
}

function toCachedStrategicRisk(risks: StrategicRisk[], ciiScores: CiiScore[]): CachedStrategicRisk {
  const global = risks[0];
  const ciiMap = new Map(ciiScores.map((s) => [s.region, s]));
  return {
    score: global?.score ?? 0,
    level: SEVERITY_REVERSE[global?.level ?? ''] || 'low',
    trend: TREND_REVERSE[global?.trend ?? ''] || 'stable',
    lastUpdated: new Date().toISOString(),
    contributors: (global?.factors ?? []).map((code) => {
      const cii = ciiMap.get(code);
      return {
        country: TIER1_NAMES[code] || code,
        code,
        score: cii?.combinedScore ?? 0,
        level: cii ? getScoreLevel(cii.combinedScore) : 'low',
      };
    }),
  };
}

function toRiskScores(resp: GetRiskScoresResponse): CachedRiskScores {
  return {
    cii: resp.ciiScores.map(toCachedCII),
    strategicRisk: toCachedStrategicRisk(resp.strategicRisks, resp.ciiScores),
    protestCount: 0,
    computedAt: new Date().toISOString(),
    cached: true,
  };
}

// ---- Caching / dedup logic (unchanged) ----

const RISK_CACHE_KEY = 'risk-scores:latest';
let cachedScores: CachedRiskScores | null = null;
let fetchPromise: Promise<CachedRiskScores | null> | null = null;
let lastFetchTime = 0;
const REFETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function loadPersistentRiskScores(): Promise<CachedRiskScores | null> {
  const entry = await getPersistentCache<CachedRiskScores>(RISK_CACHE_KEY);
  return entry?.data ?? null;
}

export async function fetchCachedRiskScores(signal?: AbortSignal): Promise<CachedRiskScores | null> {
  if (signal?.aborted) throw createAbortError();
  const now = Date.now();

  if (cachedScores && now - lastFetchTime < REFETCH_INTERVAL_MS) {
    return cachedScores;
  }

  if (fetchPromise) {
    return withCallerAbort(fetchPromise, signal);
  }

  fetchPromise = (async () => {
    try {
      const resp = await client.getRiskScores({ region: '' });
      const data = toRiskScores(resp);
      cachedScores = data;
      lastFetchTime = now;
      setHasCachedScores(true);
      void setPersistentCache(RISK_CACHE_KEY, data);
      console.log('[CachedRiskScores] Loaded via sebuf RPC');
      return cachedScores;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      console.error('[CachedRiskScores] Fetch error:', error);
      return cachedScores ?? await loadPersistentRiskScores();
    } finally {
      fetchPromise = null;
    }
  })();

  return withCallerAbort(fetchPromise, signal);
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
