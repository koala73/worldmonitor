/**
 * ReliefWeb (UN OCHA) crisis reports client service.
 *
 * Fetches humanitarian reports from the /api/reliefweb Vercel edge function.
 * Uses a circuit breaker for resilience and a 15-minute local cache.
 */

import { createCircuitBreaker } from '@/utils';

// ---- Types ----

export interface ReliefWebReport {
  id: string;
  title: string;
  date: string;
  country: string;
  lat: number;
  lon: number;
  disasterType: string;
  source: string;
  url: string;
}

export interface ReliefWebResponse {
  generatedAt: string;
  reports: ReliefWebReport[];
}

// ---- Circuit breaker + cache ----

const breaker = createCircuitBreaker<ReliefWebResponse>({ name: 'ReliefWeb' });

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let cache: { data: ReliefWebResponse; ts: number } | null = null;

const emptyFallback: ReliefWebResponse = {
  generatedAt: '',
  reports: [],
};

// ---- Exported functions ----

export async function fetchReliefWebReports(): Promise<ReliefWebResponse> {
  // Return from local cache if fresh
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  const result = await breaker.execute(async () => {
    const resp = await fetch('/api/reliefweb', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`ReliefWeb API: ${resp.status}`);
    return resp.json() as Promise<ReliefWebResponse>;
  }, emptyFallback);

  if (result.generatedAt) {
    cache = { data: result, ts: Date.now() };
  }

  return result;
}
