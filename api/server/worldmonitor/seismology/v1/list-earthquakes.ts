/**
 * ListEarthquakes RPC -- proxies the USGS earthquake GeoJSON API.
 *
 * Fetches M4.5+ earthquakes from the last 24 hours and transforms the USGS
 * GeoJSON features into proto-shaped Earthquake objects.
 */

import type {
  SeismologyServiceHandler,
  ServerContext,
  ListEarthquakesRequest,
  ListEarthquakesResponse,
} from '../../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

const USGS_FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';

export const listEarthquakes: SeismologyServiceHandler['listEarthquakes'] = async (
  _ctx: ServerContext,
  _req: ListEarthquakesRequest,
): Promise<ListEarthquakesResponse> => {
  const response = await fetch(USGS_FEED_URL, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`USGS API error: ${response.status}`);
  }

  const geojson: any = await response.json();
  const features: any[] = geojson.features || [];

  const earthquakes = features.map((f: any) => ({
    id: f.id as string,
    place: (f.properties.place as string) || '',
    magnitude: (f.properties.mag as number) ?? 0,
    depthKm: (f.geometry.coordinates[2] as number) ?? 0,
    location: {
      latitude: f.geometry.coordinates[1] as number,
      longitude: f.geometry.coordinates[0] as number,
    },
    occurredAt: f.properties.time,
    sourceUrl: (f.properties.url as string) || '',
  }));

  return { earthquakes, pagination: undefined };
};
