import { createCircuitBreaker, fetchWithCache } from '@/utils';

export interface GDACSEvent {
  id: string;
  eventType: 'EQ' | 'FL' | 'TC' | 'VO' | 'WF' | 'DR';
  name: string;
  description: string;
  alertLevel: 'Green' | 'Orange' | 'Red';
  country: string;
  coordinates: [number, number];
  fromDate: Date;
  severity: string;
  url: string;
}

interface GDACSFeature {
  geometry: {
    type: string;
    coordinates: [number, number];
  };
  properties: {
    eventtype: string;
    eventid: number;
    name: string;
    description: string;
    alertlevel: string;
    country: string;
    fromdate: string;
    severitydata?: {
      severity: number;
      severitytext: string;
      severityunit: string;
    };
    url: {
      report: string;
    };
  };
}

interface GDACSResponse {
  features: GDACSFeature[];
}

const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP';
const breaker = createCircuitBreaker<GDACSEvent[]>({ name: 'GDACS' });

const EVENT_TYPE_NAMES: Record<string, string> = {
  EQ: 'Earthquake',
  FL: 'Flood',
  TC: 'Tropical Cyclone',
  VO: 'Volcano',
  WF: 'Wildfire',
  DR: 'Drought',
};

export async function fetchGDACSEvents(): Promise<GDACSEvent[]> {
  return breaker.execute(async () => {
    const data = await fetchWithCache<GDACSResponse>(GDACS_API, {
      ttl: 120_000,
      headers: { Accept: 'application/json' },
    });

    const seen = new Set<string>();
    return data.features
      .filter(f => {
        if (!f.geometry || f.geometry.type !== 'Point') return false;
        const key = `${f.properties.eventtype}-${f.properties.eventid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .filter(f => f.properties.alertlevel !== 'Green')
      .slice(0, 100)
      .map(f => ({
        id: `gdacs-${f.properties.eventtype}-${f.properties.eventid}`,
        eventType: f.properties.eventtype as GDACSEvent['eventType'],
        name: f.properties.name,
        description: f.properties.description || EVENT_TYPE_NAMES[f.properties.eventtype] || f.properties.eventtype,
        alertLevel: f.properties.alertlevel as GDACSEvent['alertLevel'],
        country: f.properties.country,
        coordinates: f.geometry.coordinates,
        fromDate: new Date(f.properties.fromdate),
        severity: f.properties.severitydata?.severitytext || '',
        url: f.properties.url?.report || '',
      }));
  }, []);
}

export function getGDACSStatus(): string {
  return breaker.getStatus();
}

export function getEventTypeIcon(type: GDACSEvent['eventType']): string {
  switch (type) {
    case 'EQ': return '🌍';
    case 'FL': return '🌊';
    case 'TC': return '🌀';
    case 'VO': return '🌋';
    case 'WF': return '🔥';
    case 'DR': return '☀️';
    default: return '⚠️';
  }
}

export function getAlertColor(level: GDACSEvent['alertLevel']): [number, number, number, number] {
  switch (level) {
    case 'Red': return [255, 0, 0, 200];
    case 'Orange': return [255, 140, 0, 180];
    default: return [255, 200, 0, 160];
  }
}
