import type {
  ListSanctionsPressureRequest,
  ListSanctionsPressureResponse,
  SanctionsServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { isCallerPremium } from '../../../_shared/premium-check';

const REDIS_CACHE_KEY = 'sanctions:pressure:v1';
const DEFAULT_MAX_ITEMS = 25;
const MAX_ITEMS_LIMIT = 60;

// All fetch/parse/scoring logic lives in the Railway seed script
// (scripts/seed-sanctions-pressure.mjs). This handler reads pre-built
// data from Redis only (gold standard: Vercel reads, Railway writes).

function clampMaxItems(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ITEMS_LIMIT);
}

function getTimeRangeWindowMs(range: string): number {
  const ranges: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '48h': 48 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
  };
  return ranges[range] ?? ranges['7d'];
}

function emptyResponse(): ListSanctionsPressureResponse {
  return {
    entries: [],
    countries: [],
    programs: [],
    fetchedAt: '0',
    datasetDate: '0',
    totalCount: 0,
    sdnCount: 0,
    consolidatedCount: 0,
    newEntryCount: 0,
    vesselCount: 0,
    aircraftCount: 0,
  };
}

function filterByTimeRange(
  entries: ListSanctionsPressureResponse['entries'],
  timeRange: string,
): ListSanctionsPressureResponse['entries'] {
  if (!timeRange || timeRange === 'all') return entries;
  const cutoff = Date.now() - getTimeRangeWindowMs(timeRange);
  return entries.filter((entry) => {
    const effectiveAt = Number(entry.effectiveAt) * 1000;
    return Number.isFinite(effectiveAt) ? effectiveAt >= cutoff : true;
  });
}

function rebuildCountryCounts(
  entries: ListSanctionsPressureResponse['entries'],
) {
  const map: Record<string, {
    countryCode: string;
    countryName: string;
    entryCount: number;
    newEntryCount: number;
    vesselCount: number;
    aircraftCount: number;
  }> = {};
  for (const entry of entries) {
    for (let i = 0; i < (entry.countryCodes?.length ?? 0); i++) {
      const code = entry.countryCodes[i] ?? 'XX';
      const name = entry.countryNames?.[i] ?? entry.countryNames?.[0] ?? 'Unknown';
      if (!map[code]) {
        map[code] = { countryCode: code, countryName: name, entryCount: 0, newEntryCount: 0, vesselCount: 0, aircraftCount: 0 };
      }
      map[code].entryCount += 1;
      if (entry.isNew) map[code].newEntryCount += 1;
      if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_VESSEL') map[code].vesselCount += 1;
      if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT') map[code].aircraftCount += 1;
    }
  }
  return Object.values(map)
    .sort((a, b) => b.newEntryCount - a.newEntryCount || b.entryCount - a.entryCount)
    .slice(0, 12);
}

function rebuildProgramCounts(
  entries: ListSanctionsPressureResponse['entries'],
) {
  const map: Record<string, { program: string; entryCount: number; newEntryCount: number }> = {};
  for (const entry of entries) {
    const programs = entry.programs?.length ? entry.programs : ['UNSPECIFIED'];
    for (const program of programs) {
      if (!map[program]) {
        map[program] = { program, entryCount: 0, newEntryCount: 0 };
      }
      map[program].entryCount += 1;
      if (entry.isNew) map[program].newEntryCount += 1;
    }
  }
  return Object.values(map)
    .sort((a, b) => b.newEntryCount - a.newEntryCount || b.entryCount - a.entryCount)
    .slice(0, 12);
}

export const listSanctionsPressure: SanctionsServiceHandler['listSanctionsPressure'] = async (
  ctx: ServerContext,
  req: ListSanctionsPressureRequest,
): Promise<ListSanctionsPressureResponse> => {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) return emptyResponse();

  const maxItems = clampMaxItems(req.maxItems);
  const timeRange = req.timeRange ?? 'all';

  try {
    const data = await getCachedJson(REDIS_CACHE_KEY, true) as ListSanctionsPressureResponse & { _state?: unknown } | null;
    if (!data?.totalCount) return emptyResponse();
    const { _state: _discarded, ...rest } = data;

    const filteredEntries = filterByTimeRange(data.entries ?? [], timeRange);
    const limitedEntries = filteredEntries.slice(0, maxItems);

    return {
      ...rest,
      entries: limitedEntries,
      countries: rebuildCountryCounts(filteredEntries),
      programs: rebuildProgramCounts(filteredEntries),
      totalCount: filteredEntries.length,
      newEntryCount: filteredEntries.filter((e) => e.isNew).length,
    };
  } catch {
    return emptyResponse();
  }
};
