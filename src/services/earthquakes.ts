import {
  SeismologyServiceClient,
  type Earthquake,
} from '@/generated/client/worldmonitor/seismology/v1/service_client';

// Re-export the proto Earthquake type as the domain's public type
export type { Earthquake };

const client = new SeismologyServiceClient('');

export async function fetchEarthquakes(): Promise<Earthquake[]> {
  const response = await client.listEarthquakes({ minMagnitude: 0 });
  return response.earthquakes;
}
