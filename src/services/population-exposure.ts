import { createCircuitBreaker, fetchWithCache } from '@/utils';
import type { CountryPopulation, PopulationExposure } from '@/types';

interface CountriesResponse {
  success: boolean;
  countries: CountryPopulation[];
}

interface ExposureResponse {
  success: boolean;
  exposedPopulation: number;
  exposureRadiusKm: number;
  nearestCountry: string;
  densityPerKm2: number;
}

const countriesBreaker = createCircuitBreaker<CountriesResponse>({ name: 'WorldPop Countries' });

export async function fetchCountryPopulations(): Promise<CountryPopulation[]> {
  const result = await countriesBreaker.execute(async () => {
    return fetchWithCache<CountriesResponse>('/api/worldpop-exposure?mode=countries', {
      ttl: 300_000,
      headers: { Accept: 'application/json' },
    });
  }, { success: false, countries: [] });

  return result.countries;
}

export async function fetchExposure(lat: number, lon: number, radiusKm: number): Promise<ExposureResponse | null> {
  try {
    return fetchWithCache<ExposureResponse>(
      `/api/worldpop-exposure?mode=exposure&lat=${lat}&lon=${lon}&radius=${radiusKm}`,
      { ttl: 300_000, headers: { Accept: 'application/json' } },
    );
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
