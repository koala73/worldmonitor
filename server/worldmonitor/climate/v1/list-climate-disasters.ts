/**
 * ListClimateDisasters RPC -- reads seeded climate disaster data from Railway seed cache.
 * ReliefWeb and natural-event transforms happen in seed-climate-disasters.mjs on Railway.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateDisastersRequest,
  ListClimateDisastersResponse,
  ClimateDisaster,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'climate:disasters:v1';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

function clampInt(value: number, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function parseCursor(cursor: string | undefined): number {
  const num = parseInt(String(cursor || ''), 10);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function asNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeCachedDisaster(row: unknown): ClimateDisaster | null {
  if (!row || typeof row !== 'object') return null;

  const record = row as Record<string, unknown>;
  const id = String(record.id || '').trim();
  if (!id) return null;

  return {
    id,
    type: String(record.type || ''),
    name: String(record.name || ''),
    country: String(record.country || ''),
    countryCode: String(record.countryCode || record.country_code || ''),
    lat: asNumber(record.lat, 0),
    lng: asNumber(record.lng, 0),
    severity: String(record.severity || ''),
    startedAt: asNumber(record.startedAt ?? record.started_at, 0),
    status: String(record.status || ''),
    affectedPopulation: asNumber(record.affectedPopulation ?? record.affected_population, 0),
    source: String(record.source || ''),
    sourceUrl: String(record.sourceUrl || record.source_url || ''),
  };
}

export const listClimateDisasters: ClimateServiceHandler['listClimateDisasters'] = async (
  _ctx: ServerContext,
  req: ListClimateDisastersRequest,
): Promise<ListClimateDisastersResponse> => {
  try {
    const limit = clampInt(req.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = parseCursor(req.cursor);
    const result = await getCachedJson(SEED_CACHE_KEY, true) as { disasters?: unknown[] } | null;
    const allDisasters = Array.isArray(result?.disasters)
      ? result.disasters.map(normalizeCachedDisaster).filter((row): row is ClimateDisaster => row != null)
      : [];
    if (offset >= allDisasters.length) {
      return {
        disasters: [],
        pagination: { nextCursor: '', totalCount: allDisasters.length },
      };
    }

    const disasters = allDisasters.slice(offset, offset + limit);
    const hasMore = offset + limit < allDisasters.length;
    return {
      disasters,
      pagination: {
        nextCursor: hasMore ? String(offset + limit) : '',
        totalCount: allDisasters.length,
      },
    };
  } catch {
    return {
      disasters: [],
      pagination: { nextCursor: '', totalCount: 0 },
    };
  }
};
