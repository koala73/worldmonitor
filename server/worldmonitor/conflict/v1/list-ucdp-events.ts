/**
 * RPC: listUcdpEvents -- Port from api/ucdp-events.js
 *
 * Queries the UCDP GED API with automatic version discovery and paginated
 * backward fetch over a trailing 1-year window.  Supports optional country
 * filtering.  Returns empty array on upstream failure (graceful degradation).
 */

import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
  UcdpViolenceType,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 12;
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const VIOLENCE_TYPE_MAP: Record<number, UcdpViolenceType> = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

function parseDateMs(value: unknown): number {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function getMaxDateMs(events: any[]): number {
  let maxMs = NaN;
  for (const event of events) {
    const ms = parseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) {
      maxMs = ms;
    }
  }
  return maxMs;
}

function buildVersionCandidates(): string[] {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1']));
}

async function fetchGedPage(version: string, page: number): Promise<any> {
  const response = await fetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) {
    throw new Error(`UCDP GED API error (${version}, page ${page}): ${response.status}`);
  }
  return response.json();
}

async function discoverGedVersion(): Promise<{ version: string; page0: any }> {
  const candidates = buildVersionCandidates();
  for (const version of candidates) {
    try {
      const page0 = await fetchGedPage(version, 0);
      if (Array.isArray(page0?.Result)) {
        return { version, page0 };
      }
    } catch {
      // Try the next version candidate.
    }
  }
  throw new Error('Unable to discover UCDP GED API version');
}

async function fetchUcdpGedEvents(req: ListUcdpEventsRequest): Promise<UcdpViolenceEvent[]> {
  try {
    const { version, page0 } = await discoverGedVersion();
    const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
    const newestPage = totalPages - 1;

    const allEvents: any[] = [];
    let latestDatasetMs = NaN;

    for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++) {
      const page = newestPage - offset;
      const rawData = page === 0 ? page0 : await fetchGedPage(version, page);
      const events: any[] = Array.isArray(rawData?.Result) ? rawData.Result : [];
      allEvents.push(...events);

      const pageMaxMs = getMaxDateMs(events);
      if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
        latestDatasetMs = pageMaxMs;
      }

      // Pages are ordered oldest->newest; once fully outside trailing window, stop.
      if (Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
        const cutoffMs = latestDatasetMs - TRAILING_WINDOW_MS;
        if (pageMaxMs < cutoffMs) {
          break;
        }
      }
    }

    // Filter events within trailing window
    const filtered = allEvents.filter((event) => {
      if (!Number.isFinite(latestDatasetMs)) return true;
      const eventMs = parseDateMs(event?.date_start);
      if (!Number.isFinite(eventMs)) return false;
      return eventMs >= (latestDatasetMs - TRAILING_WINDOW_MS);
    });

    // Map to proto UcdpViolenceEvent
    let mapped = filtered.map((e: any): UcdpViolenceEvent => ({
      id: String(e.id || ''),
      dateStart: Date.parse(e.date_start) || 0,
      dateEnd: Date.parse(e.date_end) || 0,
      location: {
        latitude: Number(e.latitude) || 0,
        longitude: Number(e.longitude) || 0,
      },
      country: e.country || '',
      sideA: (e.side_a || '').substring(0, 200),
      sideB: (e.side_b || '').substring(0, 200),
      deathsBest: Number(e.best) || 0,
      deathsLow: Number(e.low) || 0,
      deathsHigh: Number(e.high) || 0,
      violenceType: VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
      sourceOriginal: (e.source_original || '').substring(0, 300),
    }));

    // Filter by country if requested
    if (req.country) {
      mapped = mapped.filter((e) => e.country === req.country);
    }

    // Sort by dateStart descending (newest first)
    mapped.sort((a, b) => b.dateStart - a.dateStart);

    return mapped;
  } catch {
    return [];
  }
}

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  try {
    const events = await fetchUcdpGedEvents(req);
    return { events, pagination: undefined };
  } catch {
    return { events: [], pagination: undefined };
  }
}
