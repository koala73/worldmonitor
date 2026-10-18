/**
 * ListEarthquakes RPC -- reads seeded earthquake data from Railway seed cache.
 * Upstream USGS and NRCan fetches happen in seed-earthquakes.mjs on Railway.
 */

import type {
  SeismologyServiceHandler,
  ServerContext,
  ListEarthquakesRequest,
  ListEarthquakesResponse,
} from '../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

import { readRequiredSeed } from '../../../_shared/required-seed';

const SEED_CACHE_KEY = 'seismology:earthquakes:v1';

type EarthquakeCache = { earthquakes: ListEarthquakesResponse['earthquakes'] };

export const listEarthquakes: SeismologyServiceHandler['listEarthquakes'] = async (
  _ctx: ServerContext,
  req: ListEarthquakesRequest,
): Promise<ListEarthquakesResponse> => {
  const pageSize = req.pageSize || 500;
  const seedData = await readRequiredSeed(SEED_CACHE_KEY, value => {
    const data = value as EarthquakeCache | null;
    return data && Array.isArray(data.earthquakes) ? data : undefined;
  });
  const earthquakes = seedData.earthquakes;
  return { earthquakes: earthquakes.slice(0, pageSize), pagination: undefined };
};
