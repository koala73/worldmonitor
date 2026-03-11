import { getApiBaseUrl } from './runtime';

export interface HealthCheck {
  status: 'OK' | 'EMPTY' | 'EMPTY_DATA' | 'STALE_SEED' | 'OK_CASCADE' | 'EMPTY_ON_DEMAND';
  redisKey: string;
  records: number;
  seedAgeMin?: number;
  maxStaleMin?: number;
}

export interface HealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'REDIS_DOWN';
  summary: {
    total: number;
    ok: number;
    warn: number;
    crit: number;
  };
  checkedAt: string;
  checks?: Record<string, HealthCheck>;
  problems?: Record<string, HealthCheck>;
  error?: string;
}

let cachedStatus: HealthStatus | null = null;
let lastFetch = 0;
const CACHE_TTL = 30000; // 30 seconds

export async function fetchSystemHealth(compact: boolean = false): Promise<HealthStatus | null> {
  const now = Date.now();
  if (cachedStatus && now - lastFetch < CACHE_TTL) return cachedStatus;

  try {
    const base = getApiBaseUrl();
    const url = `${base}/api/health${compact ? '?compact=1' : ''}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      if (resp.status === 503) {
        return await resp.json() as HealthStatus;
      }
      throw new Error(`Health API ${resp.status}`);
    }

    const data = await resp.json() as HealthStatus;
    cachedStatus = data;
    lastFetch = now;
    return data;
  } catch (err) {
    console.error('[Health Service] Failed to fetch system health:', err);
    return null;
  }
}
