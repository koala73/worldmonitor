import { createCircuitBreaker, getCSSColor } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

export interface WeatherAlert {
  id: string;
  event: string;
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  headline: string;
  description: string;
  areaDesc: string;
  onset: Date;
  expires: Date;
  coordinates: [number, number][];
  centroid?: [number, number];
}

interface BootstrapAlert {
  id: string;
  event: string;
  severity: string;
  headline: string;
  description: string;
  areaDesc: string;
  onset: string;
  expires: string;
  coordinates: [number, number][];
  centroid?: [number, number];
}

const breaker = createCircuitBreaker<WeatherAlert[]>({ name: 'NWS Weather', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

function mapAlert(a: BootstrapAlert): WeatherAlert {
  return {
    id: a.id,
    event: a.event,
    severity: a.severity as WeatherAlert['severity'],
    headline: a.headline,
    description: a.description,
    areaDesc: a.areaDesc,
    onset: new Date(a.onset),
    expires: new Date(a.expires),
    coordinates: a.coordinates,
    centroid: a.centroid,
  };
}

export async function fetchWeatherAlerts(): Promise<WeatherAlert[]> {
  return breaker.execute(async () => {
    const hydrated = getHydratedData('weatherAlerts') as { alerts?: BootstrapAlert[] } | undefined;
    if (hydrated?.alerts?.length) {
      return hydrated.alerts.map(mapAlert);
    }

    const resp = await fetch(toApiUrl('/api/bootstrap?keys=weatherAlerts'), { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`Bootstrap fetch failed: ${resp.status}`);
    const json = await resp.json() as { data?: { weatherAlerts?: { alerts?: BootstrapAlert[] } } };
    const alerts = json.data?.weatherAlerts?.alerts;
    if (alerts?.length) return alerts.map(mapAlert);

    throw new Error('No weather data in bootstrap');
  }, []);
}

export function getWeatherStatus(): string {
  return breaker.getStatus();
}

export function getSeverityColor(severity: WeatherAlert['severity']): string {
  switch (severity) {
    case 'Extreme': return getCSSColor('--semantic-critical');
    case 'Severe': return getCSSColor('--semantic-high');
    case 'Moderate': return getCSSColor('--semantic-elevated');
    case 'Minor': return getCSSColor('--semantic-elevated');
    default: return getCSSColor('--text-dim');
  }
}
