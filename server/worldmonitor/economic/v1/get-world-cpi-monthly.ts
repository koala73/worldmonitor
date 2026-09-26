import type {
  ServerContext,
  GetWorldCpiMonthlyRequest,
  GetWorldCpiMonthlyResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJsonBatch } from '../../../_shared/redis';
import {
  WORLD_CPI_CANONICAL_KEYS,
  WORLD_CPI_LATEST_KEYS,
  buildWorldCpiCountries,
  selectCountrySeries,
  type WorldCpiSourceId,
  type WorldCpiSourcePayloads,
} from './world-cpi-monthly';

const SOURCE_IDS = Object.keys(WORLD_CPI_CANONICAL_KEYS) as Exclude<WorldCpiSourceId, 'imf-hicp'>[];

function isPayload(value: unknown): value is NonNullable<WorldCpiSourcePayloads[string]> {
  return Boolean(value) && typeof value === 'object';
}

/**
 * Read the four source payloads in one Redis pipeline. `raw` is required: the
 * seeders write unprefixed keys and this reader must not add a prefix.
 *
 * `getCachedJsonBatch` returns an empty Map on HTTP error or timeout instead of
 * throwing, so an all-null result reaches the caller's `unavailable` branch
 * rather than being trusted as an empty dataset.
 */
async function readSources(history: boolean): Promise<WorldCpiSourcePayloads> {
  const keys = SOURCE_IDS.map((sourceId) => (
    history ? WORLD_CPI_CANONICAL_KEYS[sourceId] : WORLD_CPI_LATEST_KEYS[sourceId]
  ));
  const shards = await getCachedJsonBatch(keys, true);
  const sources: WorldCpiSourcePayloads = {};
  for (const sourceId of SOURCE_IDS) {
    const key = history ? WORLD_CPI_CANONICAL_KEYS[sourceId] : WORLD_CPI_LATEST_KEYS[sourceId];
    const value = shards.get(key);
    if (isPayload(value)) sources[sourceId] = value;
  }
  return sources;
}

export async function getWorldCpiMonthly(
  _ctx: ServerContext,
  req: GetWorldCpiMonthlyRequest,
): Promise<GetWorldCpiMonthlyResponse> {
  try {
    const history = req.history === true;
    const sources = await readSources(history);
    const selected = selectCountrySeries(sources);
    const countries = buildWorldCpiCountries(
      selected,
      history,
      typeof req.country === 'string' ? req.country : undefined,
    );
    if (Object.keys(selected).length === 0) return { countries: [], unavailable: true };
    return { countries, unavailable: false };
  } catch {
    return { countries: [], unavailable: true };
  }
}
