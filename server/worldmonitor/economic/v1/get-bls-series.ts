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
import { SeedUnavailableError, readRequiredSeed } from '../../../_shared/required-seed';

const BLS_CANONICAL_KEY = 'bls:series:v1';

// Only answer for series IDs the seeder publishes; anything else is empty
// without a cache read. National series now fetched via FRED (api.bls.gov is
// blocked from Railway IPs). Metro-area LAUMT* series dropped — no FRED
// equivalent available.
const KNOWN_SERIES_IDS = new Set(filterParamContracts.economicBlsSeriesIds);

function normalizeLimit(limit: number): number {
  return limit > 0 ? Math.min(limit, 500) : 60;
}

/**
 * Kept deliberately identical to `isPublishableSeries` in
 * `scripts/seed-bls-series.mjs`, which gates what the seeder may publish. An
 * entry narrower than this is a broken seed, not servable data — serving it
 * would answer 200 with a body missing fields the proto marks required. Keep
 * the two in lockstep: a reader stricter than its producer 503s a seed the
 * producer was allowed to write.
 */
function isServableSeries(value: unknown): value is BlsSeries {
  const series = value as Partial<BlsSeries> | null;
  return typeof series?.seriesId === 'string'
    && typeof series.title === 'string'
    && typeof series.units === 'string'
    && Array.isArray(series.observations)
    && series.observations.length > 0;
}

export async function getBlsSeries(
  _ctx: ServerContext,
  req: GetBlsSeriesRequest,
): Promise<GetBlsSeriesResponse> {
  if (!req.seriesId) return { series: undefined };
  if (!KNOWN_SERIES_IDS.has(req.seriesId)) return { series: undefined };

  const seeded = await readRequiredSeed(BLS_CANONICAL_KEY, value => {
    const data = value as { series?: unknown } | null;
    return Array.isArray(data?.series) ? (data.series as unknown[]) : undefined;
  });

  // A known series absent from — or malformed within — a valid seed is
  // unavailable, not empty: the seeder refuses a partial cohort, so this only
  // fires on drift between the published ids and the contract, or on a
  // corrupted envelope. Name the series so the 503 log does not blame the
  // healthy canonical key.
  const series = seeded.find(
    (entry): entry is BlsSeries => isServableSeries(entry) && entry.seriesId === req.seriesId,
  );
  if (!series) {
    throw new SeedUnavailableError(`${BLS_CANONICAL_KEY} series ${req.seriesId}`);
  }

  const limit = normalizeLimit(req.limit);
  const obs = series.observations;
  const sliced = obs.length > limit ? obs.slice(-limit) : obs;

  return { series: { ...series, observations: sliced } };
}
