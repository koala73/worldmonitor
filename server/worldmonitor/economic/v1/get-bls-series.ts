/**
 * RPC: getBlsSeries -- reads seeded BLS time series from Railway seed cache.
 * All external BLS API calls happen in scripts/seed-bls-series.mjs on Railway.
 *
 * Reads the canonical `bls:series:v1` envelope — the key api/health.js vouches
 * for — and selects the requested series from it. The per-series
 * `bls:series:<id>` keys this used to read were overwritten by their own
 * seed-meta record on every run from 2026-03-23, and health never looked at
 * them, so the RPC served an empty body for six months (#8424).
 */
import type {
  ServerContext,
  GetBlsSeriesRequest,
  GetBlsSeriesResponse,
  BlsSeries,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';
import { readRequiredSeed } from '../../../_shared/required-seed';

const BLS_CANONICAL_KEY = 'bls:series:v1';

// Only answer for series IDs the seeder publishes; anything else is empty
// without a cache read. National series now fetched via FRED (api.bls.gov is
// blocked from Railway IPs). Metro-area LAUMT* series dropped — no FRED
// equivalent available.
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

  // A known series absent from a valid seed is unavailable, not empty: the
  // seeder only omits a series when its upstream fetch failed.
  const series = await readRequiredSeed(BLS_CANONICAL_KEY, value => {
    const data = value as { series?: unknown } | null;
    if (!Array.isArray(data?.series)) return undefined;
    const match = (data.series as Array<Partial<BlsSeries> | null>).find(s => s?.seriesId === req.seriesId);
    return match && Array.isArray(match.observations) ? (match as BlsSeries) : undefined;
  });

  const limit = normalizeLimit(req.limit);
  const obs = series.observations;
  const sliced = obs.length > limit ? obs.slice(-limit) : obs;

  return { series: { ...series, observations: sliced } };
}
