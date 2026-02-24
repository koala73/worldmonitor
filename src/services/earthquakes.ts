import {
  SeismologyServiceClient,
  type Earthquake,
  type ListEarthquakesResponse,
} from '@/generated/client/worldmonitor/seismology/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// Re-export the proto Earthquake type as the domain's public type
export type { Earthquake };

const client = new SeismologyServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListEarthquakesResponse>({ name: 'Seismology' });

const emptyFallback: ListEarthquakesResponse = { earthquakes: [] };

export async function fetchEarthquakes(): Promise<Earthquake[]> {
  const response = await breaker.execute(async () => {
    return client.listEarthquakes({ minMagnitude: 0 });
  }, emptyFallback);
  return response.earthquakes;
}
