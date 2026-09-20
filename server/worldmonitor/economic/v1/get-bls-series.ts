/**
 * RPC: getBlsSeries -- reads seeded BLS time series from Railway seed cache.
 * All external BLS API calls happen in scripts/seed-bls-series.mjs on Railway.
 */
import type {
  ServerContext,
  GetBlsSeriesRequest,
  GetBlsSeriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';
import { readRequiredSeed } from '../../../_shared/required-seed';

const BLS_KEY_PREFIX = 'bls:series';

// Only allow series IDs that were seeded. Prevents unbounded Redis key enumeration.
// National series now fetched via FRED (api.bls.gov is blocked from Railway IPs).
// Metro-area LAUMT* series dropped — no FRED equivalent available.
const KNOWN_SERIES_IDS = new Set(filterParamContracts.economicBlsSeriesIds);

function normalizeLimit(limit: number): number {
  return limit > 0 ? Math.min(limit, 500) : 60;
}

export async function getBlsSeries(
  _ctx: ServerContext,
  req: GetBlsSeriesRequest,
): Promise<GetBlsSeriesResponse> {
  if (!req.seriesId) return { series: undefined };
  if (!KNOWN_SERIES_IDS.has(req.seriesId)) return { series: undefined };

  const seedKey = `${BLS_KEY_PREFIX}:${req.seriesId}`;
  const series = await readRequiredSeed(seedKey, value => {
    const data = value as GetBlsSeriesResponse | null;
    return data?.series && Array.isArray(data.series.observations) ? data.series : undefined;
  });

  const limit = normalizeLimit(req.limit);
  const obs = series.observations;
  const sliced = obs.length > limit ? obs.slice(-limit) : obs;

  return { series: { ...series, observations: sliced } };
}
