import {
  SeismologyServiceClient,
  type Earthquake,
  type ListEarthquakesResponse,
} from '@/generated/client/worldmonitor/seismology/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

// Re-export the proto Earthquake type as the domain's public type
export type { Earthquake };

const client = new SeismologyServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListEarthquakesResponse>({ name: 'Seismology', cacheTtlMs: 5 * 60 * 1000, persistCache: true });

const emptyFallback: ListEarthquakesResponse = { earthquakes: [] };

export async function fetchEarthquakes(): Promise<Earthquake[]> {
  const hydrated = getHydratedData('earthquakes') as ListEarthquakesResponse | undefined;
  if (hydrated) return hydrated.earthquakes ?? [];

  const response = await breaker.execute(async () => {
    return client.listEarthquakes({ minMagnitude: 0, start: 0, end: 0, pageSize: 0, cursor: '' });
  }, emptyFallback);
  return response.earthquakes;
}
