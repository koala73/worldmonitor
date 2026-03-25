/**
 * ListEarthquakes RPC -- reads seeded earthquake data from Railway seed cache.
 * All external USGS API calls happen in seed-earthquakes.mjs on Railway.
 */

import type {
  SeismologyServiceHandler,
  ServerContext,
  ListEarthquakesRequest,
  ListEarthquakesResponse,
} from '../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'seismology:earthquakes:v1';

type EarthquakeCache = { earthquakes: ListEarthquakesResponse['earthquakes'] };

export const listEarthquakes: SeismologyServiceHandler['listEarthquakes'] = async (
  _ctx: ServerContext,
  req: ListEarthquakesRequest,
): Promise<ListEarthquakesResponse> => {
  const pageSize = req.pageSize || 500;
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as EarthquakeCache | null;
    const earthquakes = seedData?.earthquakes || [];
    return { earthquakes: earthquakes.slice(0, pageSize), pagination: undefined };
  } catch {
    return { earthquakes: [], pagination: undefined };
  }
};
