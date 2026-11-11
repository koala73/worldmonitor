/**
 * ListReservoirLevels RPC: reads the seeded ICESat-2 reservoir level snapshot
 * (scripts/seed-reservoir-levels.mjs, Redis key climate:reservoir-levels:v1).
 *
 * A missing or unreadable snapshot answers an empty list with
 * dataAvailable=false and a no-store marker, so the CDN does not cache the
 * fallback as if the watchlist were empty.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListReservoirLevelsRequest,
  ListReservoirLevelsResponse,
  ReservoirLatestPass,
  ReservoirLevel,
  ReservoirLevelPoint,
  ReservoirLevelsSource,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { CLIMATE_RESERVOIR_LEVELS_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

type LooseRecord = Record<string, unknown>;

const asRecord = (v: unknown): LooseRecord | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as LooseRecord) : null);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function normalizeLatest(v: unknown): ReservoirLatestPass | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  const levelM = asNumber(r.levelM);
  const date = asString(r.date);
  if (levelM == null || !date) return undefined;
  return {
    date,
    levelM,
    madM: asNumber(r.madM) ?? 0,
    segmentCount: Math.round(asNumber(r.segmentCount) ?? 0),
    ageDays: Math.round(asNumber(r.ageDays) ?? 0),
  };
}

function normalizeSeries(v: unknown): ReservoirLevelPoint[] {
  if (!Array.isArray(v)) return [];
  const out: ReservoirLevelPoint[] = [];
  for (const p of v) {
    if (!Array.isArray(p)) continue;
    const date = asString(p[0]);
    const levelM = asNumber(p[1]);
    if (date && levelM != null) out.push({ date, levelM });
  }
  return out;
}

export function normalizeReservoir(v: unknown): ReservoirLevel | null {
  const r = asRecord(v);
  if (!r) return null;
  const id = asString(r.id);
  if (!id) return null;
  const lat = asNumber(r.lat);
  const lon = asNumber(r.lon);
  if (lat == null || lon == null) return null;
  const out: ReservoirLevel = {
    id,
    name: asString(r.name),
    country: asString(r.country),
    riparians: asStrings(r.riparians),
    river: asString(r.river),
    lat,
    lon,
    tags: asStrings(r.tags),
    why: asString(r.why),
    latest: normalizeLatest(r.latest),
    prevDate: asString(r.prevDate),
    recordStart: asString(r.recordStart),
    recordLow: r.recordLow === true,
    recordHigh: r.recordHigh === true,
    status: asString(r.status) || 'insufficient_history',
    series: normalizeSeries(r.series),
    okPassCount: Math.round(asNumber(r.okPassCount) ?? 0),
  };
  const optional = [
    'changePrevM', 'change30dM', 'change90dM', 'change365dM', 'seasonalAnomalyM', 'seasonalZ',
    'recordMinM', 'recordMaxM', 'percentOfRange',
  ] as const;
  for (const k of optional) {
    const n = asNumber(r[k]);
    if (n != null) out[k] = n;
  }
  return out;
}

function normalizeSource(v: unknown): ReservoirLevelsSource | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  return { name: asString(r.name), product: asString(r.product), url: asString(r.url), processing: asString(r.processing) };
}

export function normalizeReservoirLevelsSeed(value: unknown): ListReservoirLevelsResponse {
  const root = asRecord(value);
  const reservoirs = Array.isArray(root?.reservoirs)
    ? (root.reservoirs as unknown[]).map(normalizeReservoir).filter((x): x is ReservoirLevel => x != null)
    : [];
  if (!root || reservoirs.length === 0) {
    return { reservoirs: [], fetchedAt: 0, dataAvailable: false, methodology: '' };
  }
  return {
    reservoirs,
    fetchedAt: Math.round(asNumber(root.fetchedAt) ?? 0),
    dataAvailable: true,
    source: normalizeSource(root.source),
    methodology: asString(root.methodology),
  };
}

export const listReservoirLevels: ClimateServiceHandler['listReservoirLevels'] = async (
  ctx: ServerContext,
  _req: ListReservoirLevelsRequest,
): Promise<ListReservoirLevelsResponse> => {
  try {
    const cached = await getCachedJson(CLIMATE_RESERVOIR_LEVELS_KEY, true);
    const normalized = normalizeReservoirLevelsSeed(cached);
    return normalized.dataAvailable ? normalized : markNoStoreFallbackResponse(ctx.request, normalized);
  } catch {
    return markNoStoreFallbackResponse(ctx.request, normalizeReservoirLevelsSeed(null));
  }
};
