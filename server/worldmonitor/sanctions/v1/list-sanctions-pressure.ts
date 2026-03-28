import type {
  ListSanctionsPressureRequest,
  ListSanctionsPressureResponse,
  SanctionsServiceHandler,
  SanctionsEntry,
  CountrySanctionsPressure,
  ProgramSanctionsPressure,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'sanctions:pressure:v1';
const DEFAULT_MAX_ITEMS = 25;
const MAX_ITEMS_LIMIT = 60;

const TIME_RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '48h': 48 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// All fetch/parse/scoring logic lives in the Railway seed script
// (scripts/seed-sanctions-pressure.mjs). This handler reads pre-built
// data from Redis only (gold standard: Vercel reads, Railway writes).

function clampMaxItems(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ITEMS_LIMIT);
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

/**
 * When a time_range is supplied (e.g. "7d"), recompute newEntryCount and
 * per-country / per-program counts so they reflect only entries whose
 * effectiveAt falls within the requested window.
 */
function applyTimeRangeFilter(
  data: ListSanctionsPressureResponse,
  timeRange: string,
  maxItems: number,
): ListSanctionsPressureResponse {
  const windowMs = TIME_RANGE_MS[timeRange];
  if (!windowMs) {
    // Unknown or 'all' — return unfiltered (existing behaviour)
    return { ...data, entries: (data.entries ?? []).slice(0, maxItems) };
  }

  const cutoff = Date.now() - windowMs;
  const allEntries = data.entries ?? [];

  // Mark entries whose effectiveAt falls within the window as "new"
  // and recompute the global / per-country / per-program counts.
  const retagged: SanctionsEntry[] = allEntries.map((e) => {
    const ts = typeof e.effectiveAt === 'string' ? Number(e.effectiveAt) : (e.effectiveAt as unknown as number);
    const withinWindow = Number.isFinite(ts) && ts > 0 && ts >= cutoff;
    return { ...e, isNew: withinWindow };
  });

  const newEntryCount = retagged.filter((e) => e.isNew).length;

  // Rebuild country pressure with recomputed newEntryCount
  const countryMap = new Map<string, CountrySanctionsPressure>();
  for (const entry of retagged) {
    for (const code of (entry.countryCodes ?? [])) {
      const existing = countryMap.get(code);
      if (existing) {
        if (entry.isNew) existing.newEntryCount += 1;
      } else {
        // Find matching country from original data
        const orig = (data.countries ?? []).find((c) => c.countryCode === code);
        if (orig) {
          countryMap.set(code, { ...orig, newEntryCount: entry.isNew ? 1 : 0 });
        }
      }
    }
  }
  const countries = countryMap.size > 0
    ? Array.from(countryMap.values())
    : (data.countries ?? []).map((c) => ({ ...c, newEntryCount: 0 }));

  // Rebuild program pressure with recomputed newEntryCount
  const programMap = new Map<string, ProgramSanctionsPressure>();
  for (const entry of retagged) {
    for (const prog of (entry.programs ?? [])) {
      const existing = programMap.get(prog);
      if (existing) {
        if (entry.isNew) existing.newEntryCount += 1;
      } else {
        const orig = (data.programs ?? []).find((p) => p.program === prog);
        if (orig) {
          programMap.set(prog, { ...orig, newEntryCount: entry.isNew ? 1 : 0 });
        }
      }
    }
  }
  const programs = programMap.size > 0
    ? Array.from(programMap.values())
    : (data.programs ?? []).map((p) => ({ ...p, newEntryCount: 0 }));

  return {
    ...data,
    entries: retagged.slice(0, maxItems),
    countries,
    programs,
    newEntryCount,
    vesselCount: data.vesselCount,
    aircraftCount: data.aircraftCount,
  };
}

export const listSanctionsPressure: SanctionsServiceHandler['listSanctionsPressure'] = async (
  _ctx: ServerContext,
  req: ListSanctionsPressureRequest,
): Promise<ListSanctionsPressureResponse> => {
  const maxItems = clampMaxItems(req.maxItems);
  try {
    const data = await getCachedJson(REDIS_CACHE_KEY, true) as ListSanctionsPressureResponse & { _state?: unknown } | null;
    if (!data?.totalCount) return emptyResponse();
    const { _state: _discarded, ...rest } = data;

    if (req.timeRange) {
      return applyTimeRangeFilter(rest, req.timeRange, maxItems);
    }

    return {
      ...rest,
      entries: (data.entries ?? []).slice(0, maxItems),
    };
  } catch {
    return emptyResponse();
  }
};
