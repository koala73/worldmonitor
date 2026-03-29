/**
 * USGS Volcano Hazards Program alert levels
 * Public API — no authentication required
 */
import { getApiBaseUrl } from '@/services/runtime';

export interface VolcanoAlert {
  id: string;
  name: string;
  location: string;
  alertLevel: 'Normal' | 'Advisory' | 'Watch' | 'Warning';
  color: 'Green' | 'Yellow' | 'Orange' | 'Red';
  lat: number;
  lon: number;
  updatedAt: string;
  observatory: string;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { data: VolcanoAlert[]; ts: number } | null = null;

export async function fetchVolcanoAlerts(): Promise<VolcanoAlert[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/volcano-alerts`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return cache?.data ?? [];
    const data = (await res.json()) as VolcanoAlert[];
    cache = { data, ts: Date.now() };
    return data;
  } catch {
    return cache?.data ?? [];
  }
}

export function alertLevelClass(level: VolcanoAlert['alertLevel']): string {
  return { Normal: '', Advisory: 'eq-row eq-moderate', Watch: 'eq-row eq-strong', Warning: 'eq-row eq-major' }[level] ?? 'eq-row';
}
