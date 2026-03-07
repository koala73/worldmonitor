import { createCircuitBreaker, getCSSColor } from '@/utils';
import { fetchBootstrapKey, getHydratedData } from '@/services/bootstrap';

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
    if (hydrated?.alerts) {
      return hydrated.alerts.map(mapAlert);
    }

    const current = await fetchBootstrapKey<{ alerts?: BootstrapAlert[] }>('weatherAlerts');
    if (current?.alerts) {
      return current.alerts.map(mapAlert);
    }

    throw new Error('No weather data available');
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
