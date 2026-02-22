/**
 * OFAC Sanctions data client service.
 *
 * Fetches entity data from the /api/sanctions Vercel edge function.
 * Uses a circuit breaker for resilience and a 5-minute local cache.
 */

import { createCircuitBreaker } from '@/utils';
import { SANCTIONS_COUNTRY_CENTROIDS } from '@/config/geo';

// ---- Types ----

export interface SanctionsEntity {
  id: string;
  name: string;
  type: 'individual' | 'entity' | 'vessel' | 'aircraft';
  program: string;
  country: string;
  severity: 'severe' | 'high' | 'moderate';
  dateAdded: string;
  remarks: string;
}

export interface SanctionsCountryData {
  count: number;
  programs: string[];
  severity: 'severe' | 'high' | 'moderate';
  types: { individual: number; entity: number; vessel: number; aircraft: number };
}

export interface SanctionsResponse {
  generatedAt: string;
  totalEntities: number;
  countries: Record<string, SanctionsCountryData>;
  entities: SanctionsEntity[];
}

// ---- Circuit breaker + cache ----

const breaker = createCircuitBreaker<SanctionsResponse>({ name: 'OFAC Sanctions' });

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cache: { data: SanctionsResponse; ts: number } | null = null;

const emptyFallback: SanctionsResponse = {
  generatedAt: '',
  totalEntities: 0,
  countries: {},
  entities: [],
};

// ---- Exported functions ----

export async function fetchSanctionsData(): Promise<SanctionsResponse> {
  // Return from local cache if fresh
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  const result = await breaker.execute(async () => {
    const resp = await fetch('/api/sanctions', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Sanctions API: ${resp.status}`);
    return resp.json() as Promise<SanctionsResponse>;
  }, emptyFallback);

  if (result.generatedAt) {
    cache = { data: result, ts: Date.now() };
  }

  return result;
}

// ---- Map point generation ----

export interface SanctionsEntityMapPoint {
  name: string;
  type: 'individual' | 'entity' | 'vessel' | 'aircraft';
  program: string;
  country: string;
  severity: 'severe' | 'high' | 'moderate';
  lat: number;
  lon: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.399 radians

export function getSanctionsMapPoints(data: SanctionsResponse): SanctionsEntityMapPoint[] {
  const points: SanctionsEntityMapPoint[] = [];
  const countByCountry = new Map<string, number>();

  for (const entity of data.entities) {
    const key = entity.country.toLowerCase();
    const centroid = SANCTIONS_COUNTRY_CENTROIDS[key];
    if (!centroid) continue;

    const idx = countByCountry.get(key) ?? 0;
    countByCountry.set(key, idx + 1);

    // Golden-angle spiral jitter (1.5° max radius)
    const r = 1.5 * Math.sqrt(idx + 1) / Math.sqrt(data.entities.length / Object.keys(SANCTIONS_COUNTRY_CENTROIDS).length + 1);
    const theta = idx * GOLDEN_ANGLE;
    const lon = centroid[0] + r * Math.cos(theta);
    const lat = centroid[1] + r * Math.sin(theta);

    points.push({
      name: entity.name,
      type: entity.type,
      program: entity.program,
      country: entity.country,
      severity: entity.severity,
      lat,
      lon,
    });
  }

  return points;
}

// ---- Entity filter ----

export function getSanctionsEntities(data: SanctionsResponse, options?: {
  country?: string;
  program?: string;
  type?: string;
  search?: string;
  limit?: number;
}): SanctionsEntity[] {
  let entities = data.entities;

  if (options?.country) {
    const c = options.country.toLowerCase();
    entities = entities.filter(e => e.country.toLowerCase() === c);
  }
  if (options?.program) {
    const p = options.program.toLowerCase();
    entities = entities.filter(e => e.program.toLowerCase().includes(p));
  }
  if (options?.type) {
    entities = entities.filter(e => e.type === options.type);
  }
  if (options?.search) {
    const s = options.search.toLowerCase();
    entities = entities.filter(e => e.name.toLowerCase().includes(s));
  }
  if (options?.limit) {
    entities = entities.slice(0, options.limit);
  }

  return entities;
}
