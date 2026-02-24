import { createCircuitBreaker } from '@/utils';
import type { CountryPopulation, PopulationExposure } from '@/types';
import { DisplacementServiceClient } from '@/generated/client/worldmonitor/displacement/v1/service_client';
import type { GetPopulationExposureResponse } from '@/generated/client/worldmonitor/displacement/v1/service_client';

const client = new DisplacementServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const countriesBreaker = createCircuitBreaker<GetPopulationExposureResponse>({ name: 'WorldPop Countries' });

export async function fetchCountryPopulations(): Promise<CountryPopulation[]> {
  const result = await countriesBreaker.execute(async () => {
    return client.getPopulationExposure({ mode: 'countries', lat: 0, lon: 0, radius: 0 });
  }, { success: false, countries: [] });

  return result.countries;
}

interface ExposureResponse {
  exposedPopulation: number;
  exposureRadiusKm: number;
  nearestCountry: string;
  densityPerKm2: number;
}

export async function fetchExposure(lat: number, lon: number, radiusKm: number): Promise<ExposureResponse | null> {
  try {
    const result = await client.getPopulationExposure({ mode: 'exposure', lat, lon, radius: radiusKm });
    if (!result.exposure) return null;
    return result.exposure;
  } catch {
    return null;
  }
}

interface EventForExposure {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

function getRadiusForEventType(type: string): number {
  switch (type) {
    case 'conflict':
    case 'battle':
    case 'state-based':
    case 'non-state':
    case 'one-sided':
      return 50;
    case 'earthquake':
      return 100;
    case 'flood':
      return 100;
    case 'fire':
    case 'wildfire':
      return 30;
    default:
      return 50;
  }
}

export async function enrichEventsWithExposure(
  events: EventForExposure[],
): Promise<PopulationExposure[]> {
  const MAX_CONCURRENT = 10;
  const results: PopulationExposure[] = [];

  for (let i = 0; i < events.length; i += MAX_CONCURRENT) {
    const batch = events.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map(async (event) => {
        const radius = getRadiusForEventType(event.type);
        const exposure = await fetchExposure(event.lat, event.lon, radius);
        if (!exposure) return null;
        return {
          eventId: event.id,
          eventName: event.name,
          eventType: event.type,
          lat: event.lat,
          lon: event.lon,
          exposedPopulation: exposure.exposedPopulation,
          exposureRadiusKm: radius,
        } as PopulationExposure;
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }

  return results.sort((a, b) => b.exposedPopulation - a.exposedPopulation);
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
