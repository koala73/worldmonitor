/**
 * Conflict service handler -- implements the generated ConflictServiceHandler
 * interface with 3 RPCs proxying three distinct upstream APIs:
 *   - listAcledEvents: ACLED API for battles, explosions, violence against civilians
 *   - listUcdpEvents: UCDP GED API with version discovery + paginated backward fetch
 *   - getHumanitarianSummary: HAPI/HDX API for humanitarian conflict event counts
 *
 * Consolidates four legacy data flows:
 *   - api/acled-conflict.js (ACLED conflict proxy)
 *   - api/ucdp-events.js (UCDP GED events proxy)
 *   - api/ucdp.js (UCDP classifications proxy)
 *   - api/hapi.js (HAPI humanitarian proxy)
 *
 * All RPCs have graceful degradation: return empty/default on upstream failure.
 * No error logging on upstream failures (following established 2F-01 pattern).
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ConflictServiceHandler,
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
  AcledConflictEvent,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
  UcdpViolenceType,
  GetHumanitarianSummaryRequest,
  GetHumanitarianSummaryResponse,
  HumanitarianCountrySummary,
} from '../../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

// ========================================================================
// RPC 1: listAcledEvents -- Port from api/acled-conflict.js
// ========================================================================

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';

async function fetchAcledConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  try {
    const token = process.env.ACLED_ACCESS_TOKEN;
    if (!token) return []; // Graceful degradation when unconfigured

    const now = Date.now();
    const startMs = req.timeRange?.start ?? (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.timeRange?.end ?? now;
    const startDate = new Date(startMs).toISOString().split('T')[0];
    const endDate = new Date(endMs).toISOString().split('T')[0];

    const params = new URLSearchParams({
      event_type: 'Battles|Explosions/Remote violence|Violence against civilians',
      event_date: `${startDate}|${endDate}`,
      event_date_where: 'BETWEEN',
      limit: '500',
      _format: 'json',
    });

    if (req.country) {
      params.set('country', req.country);
    }

    const response = await fetch(`${ACLED_API_URL}?${params}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const rawData = await response.json();
    const events: unknown[] = Array.isArray(rawData?.data) ? rawData.data : [];

    return events
      .filter((e: any) => {
        const lat = parseFloat(e.latitude);
        const lon = parseFloat(e.longitude);
        return (
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          lat >= -90 &&
          lat <= 90 &&
          lon >= -180 &&
          lon <= 180
        );
      })
      .map((e: any): AcledConflictEvent => ({
        id: `acled-${e.event_id_cnty}`,
        eventType: e.event_type || '',
        country: e.country || '',
        location: {
          latitude: parseFloat(e.latitude),
          longitude: parseFloat(e.longitude),
        },
        occurredAt: new Date(e.event_date).getTime(),
        fatalities: parseInt(e.fatalities, 10) || 0,
        actors: [e.actor1, e.actor2].filter(Boolean),
        source: e.source || '',
        admin1: e.admin1 || '',
      }));
  } catch {
    return [];
  }
}

// ========================================================================
// RPC 2: listUcdpEvents -- Port from api/ucdp-events.js
// ========================================================================

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

// ========================================================================
// RPC 3: getHumanitarianSummary -- Port from api/hapi.js
// ========================================================================

const ISO2_TO_ISO3: Record<string, string> = {
  US: 'USA', RU: 'RUS', CN: 'CHN', UA: 'UKR', IR: 'IRN',
  IL: 'ISR', TW: 'TWN', KP: 'PRK', SA: 'SAU', TR: 'TUR',
  PL: 'POL', DE: 'DEU', FR: 'FRA', GB: 'GBR', IN: 'IND',
  PK: 'PAK', SY: 'SYR', YE: 'YEM', MM: 'MMR', VE: 'VEN',
  AF: 'AFG', SD: 'SDN', SS: 'SSD', SO: 'SOM', CD: 'COD',
  ET: 'ETH', IQ: 'IRQ', CO: 'COL', NG: 'NGA', PS: 'PSE',
  BR: 'BRA', AE: 'ARE',
};

interface HapiCountryAgg {
  iso3: string;
  locationName: string;
  month: string;
  eventsTotal: number;
  eventsPoliticalViolence: number;
  eventsCivilianTargeting: number;
  eventsDemonstrations: number;
  fatalitiesTotalPoliticalViolence: number;
  fatalitiesTotalCivilianTargeting: number;
}

async function fetchHapiSummary(countryCode: string): Promise<HumanitarianCountrySummary | undefined> {
  try {
    const appId = btoa('worldmonitor:monitor@worldmonitor.app');
    let url = `https://hapi.humdata.org/api/v2/coordination-context/conflict-events?output_format=json&limit=1000&offset=0&app_identifier=${appId}`;

    // Optionally filter by country
    if (countryCode) {
      const iso3 = ISO2_TO_ISO3[countryCode.toUpperCase()];
      if (iso3) {
        url += `&location_code=${iso3}`;
      }
      // If no mapping exists, proceed without country filter
    }

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return undefined;

    const rawData = await response.json();
    const records: any[] = rawData.data || [];

    // Aggregate per country -- port exactly from api/hapi.js lines 82-108
    const byCountry: Record<string, HapiCountryAgg> = {};
    for (const r of records) {
      const iso3 = r.location_code || '';
      if (!iso3) continue;

      const month = r.reference_period_start || '';
      const eventType = (r.event_type || '').toLowerCase();
      const events = r.events || 0;
      const fatalities = r.fatalities || 0;

      if (!byCountry[iso3]) {
        byCountry[iso3] = {
          iso3,
          locationName: r.location_name || '',
          month,
          eventsTotal: 0,
          eventsPoliticalViolence: 0,
          eventsCivilianTargeting: 0,
          eventsDemonstrations: 0,
          fatalitiesTotalPoliticalViolence: 0,
          fatalitiesTotalCivilianTargeting: 0,
        };
      }

      const c = byCountry[iso3];
      if (month > c.month) {
        // Newer month -- reset
        c.month = month;
        c.eventsTotal = 0;
        c.eventsPoliticalViolence = 0;
        c.eventsCivilianTargeting = 0;
        c.eventsDemonstrations = 0;
        c.fatalitiesTotalPoliticalViolence = 0;
        c.fatalitiesTotalCivilianTargeting = 0;
      }
      if (month === c.month) {
        c.eventsTotal += events;
        if (eventType.includes('political_violence')) {
          c.eventsPoliticalViolence += events;
          c.fatalitiesTotalPoliticalViolence += fatalities;
        }
        if (eventType.includes('civilian_targeting')) {
          c.eventsCivilianTargeting += events;
          c.fatalitiesTotalCivilianTargeting += fatalities;
        }
        if (eventType.includes('demonstration')) {
          c.eventsDemonstrations += events;
        }
      }
    }

    // Pick the right country entry
    let entry: HapiCountryAgg | undefined;
    if (countryCode) {
      const iso3 = ISO2_TO_ISO3[countryCode.toUpperCase()];
      if (iso3) {
        entry = byCountry[iso3];
      }
      // If no direct match, try finding by any key
      if (!entry) {
        entry = Object.values(byCountry)[0];
      }
    } else {
      entry = Object.values(byCountry)[0];
    }

    if (!entry) return undefined;

    return {
      countryCode: countryCode || '',
      countryName: entry.locationName,
      populationAffected: String(entry.eventsTotal),
      peopleInNeed: String(entry.eventsPoliticalViolence + entry.eventsCivilianTargeting),
      internallyDisplaced: String(0), // HAPI conflict events endpoint does not provide displacement data
      foodInsecurityLevel: '', // Not available from this endpoint
      waterAccessPct: 0, // Not available from this endpoint
      updatedAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

// ========================================================================
// Handler export
// ========================================================================

export const conflictHandler: ConflictServiceHandler = {
  async listAcledEvents(
    _ctx: ServerContext,
    req: ListAcledEventsRequest,
  ): Promise<ListAcledEventsResponse> {
    try {
      const events = await fetchAcledConflicts(req);
      return { events, pagination: undefined };
    } catch {
      return { events: [], pagination: undefined };
    }
  },

  async listUcdpEvents(
    _ctx: ServerContext,
    req: ListUcdpEventsRequest,
  ): Promise<ListUcdpEventsResponse> {
    try {
      const events = await fetchUcdpGedEvents(req);
      return { events, pagination: undefined };
    } catch {
      return { events: [], pagination: undefined };
    }
  },

  async getHumanitarianSummary(
    _ctx: ServerContext,
    req: GetHumanitarianSummaryRequest,
  ): Promise<GetHumanitarianSummaryResponse> {
    try {
      const summary = await fetchHapiSummary(req.countryCode);
      return { summary };
    } catch {
      return { summary: undefined };
    }
  },
};
