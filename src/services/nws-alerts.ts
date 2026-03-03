/**
 * NOAA National Weather Service All-Hazards Alerts
 * Public API — no authentication required
 * Docs: https://www.weather.gov/documentation/services-web-api
 */
import { getApiBaseUrl } from '@/services/runtime';

export interface NWSAlert {
  id: string;
  event: string;
  headline: string;
  description: string;
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  urgency: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
  areaDesc: string;
  onset: string;
  expires: string;
  status: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: NWSAlert[]; ts: number } | null = null;

export async function fetchNWSAlerts(): Promise<NWSAlert[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/nws-alerts`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return cache?.data ?? [];
    const data = (await res.json()) as NWSAlert[];
    cache = { data, ts: Date.now() };
    return data;
  } catch {
    return cache?.data ?? [];
  }
}

export function nwsSeverityClass(severity: NWSAlert['severity']): string {
  return {
    Extreme: 'eq-row eq-major',
    Severe: 'eq-row eq-strong',
    Moderate: 'eq-row eq-moderate',
    Minor: 'eq-row',
    Unknown: 'eq-row',
  }[severity] ?? 'eq-row';
}
