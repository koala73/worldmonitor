import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

export interface CanadaAlert {
  id: string;
  province: string;
  event: string;
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor';
  headline: string;
  description: string;
  areaDesc: string;
  onset: Date;
  expires: Date | null;
  lat: number;
  lon: number;
  centroid?: [number, number];
  source?: 'alberta-aea' | string;
  updatedAt?: number | null;
}

interface BootstrapAlert {
  id: string;
  province?: string;
  event?: string;
  severity: string;
  headline?: string;
  description?: string;
  areaDesc?: string;
  onset?: string;
  expires?: string;
  lat?: number;
  lon?: number;
  centroid?: [number, number];
  source?: string;
  updatedAt?: number | null;
}

const breaker = createCircuitBreaker<CanadaAlert[]>({
  name: 'Canada alerts',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

function asLonLat(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return [lon, lat];
}

function mapAlert(a: BootstrapAlert): CanadaAlert {
  const centroid = asLonLat(a.centroid) ?? asLonLat([a.lon, a.lat]);
  return {
    id: a.id,
    province: a.province || 'CA',
    event: a.event || '',
    severity: a.severity as CanadaAlert['severity'],
    headline: a.headline || '',
    description: a.description || '',
    areaDesc: a.areaDesc || '',
    onset: a.onset ? new Date(a.onset) : new Date(a.updatedAt || 0),
    expires: a.expires ? new Date(a.expires) : null,
    lat: a.lat ?? (centroid ? centroid[1] : 56.13),
    lon: a.lon ?? (centroid ? centroid[0] : -106.35),
    centroid,
    source: a.source || 'canada-alerts',
    updatedAt: a.updatedAt ?? null,
  };
}

function alertsFromPayload(payload: unknown): CanadaAlert[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const alerts = (payload as { alerts?: BootstrapAlert[] }).alerts;
  if (!Array.isArray(alerts)) return null;
  return alerts.map(mapAlert);
}

/** Province-owned public-safety feeds materialized onto canadaAlerts. */
export async function fetchCanadaAlerts(): Promise<CanadaAlert[]> {
  return breaker.execute(async () => {
    const hydrated = alertsFromPayload(getHydratedData('canadaAlerts'));
    if (hydrated) return hydrated;

    const resp = await fetch(
      toApiUrl('/api/bootstrap?keys=canadaAlerts'),
      { credentials: 'include', signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) throw new Error(`Bootstrap fetch failed: ${resp.status}`);
    const json = await resp.json() as { data?: { canadaAlerts?: unknown } };
    const alerts = alertsFromPayload(json.data?.canadaAlerts);
    if (alerts) return alerts;

    throw new Error('No Canada alerts data in bootstrap');
  }, []);
}

export function getCanadaAlertsStatus(): string {
  return breaker.getStatus();
}
