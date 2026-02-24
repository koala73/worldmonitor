/**
 * RPC: getHumanitarianSummary -- Port from api/hapi.js
 *
 * Queries the HAPI/HDX API for humanitarian conflict event counts,
 * aggregated per country by the most recent reference month.
 * Returns undefined summary on upstream failure (graceful degradation).
 */

import type {
  ServerContext,
  GetHumanitarianSummaryRequest,
  GetHumanitarianSummaryResponse,
  HumanitarianCountrySummary,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'conflict:humanitarian:v1';
const REDIS_CACHE_TTL = 21600; // 6 hr — monthly humanitarian data

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

    // Filter by country — if a specific country was requested but has no ISO3 mapping,
    // return undefined immediately rather than silently returning unrelated data (BLOCKING-1 fix)
    if (countryCode) {
      const iso3 = ISO2_TO_ISO3[countryCode.toUpperCase()];
      if (!iso3) return undefined;
      url += `&location_code=${iso3}`;
    }

    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
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
      // iso3 is guaranteed non-null here (early return above handles missing mapping)
      entry = iso3 ? byCountry[iso3] : undefined;
      if (!entry) return undefined; // Country not in HAPI data
    } else {
      entry = Object.values(byCountry)[0];
    }

    if (!entry) return undefined;

    return {
      countryCode: countryCode ? countryCode.toUpperCase() : '',
      countryName: entry.locationName,
      conflictEventsTotal: entry.eventsTotal,
      conflictPoliticalViolenceEvents: entry.eventsPoliticalViolence + entry.eventsCivilianTargeting,
      conflictFatalities: entry.fatalitiesTotalPoliticalViolence + entry.fatalitiesTotalCivilianTargeting,
      referencePeriod: entry.month,
      conflictDemonstrations: entry.eventsDemonstrations,
      updatedAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

export async function getHumanitarianSummary(
  _ctx: ServerContext,
  req: GetHumanitarianSummaryRequest,
): Promise<GetHumanitarianSummaryResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.countryCode || 'all'}`;
    const cached = (await getCachedJson(cacheKey)) as GetHumanitarianSummaryResponse | null;
    if (cached?.summary) return cached;

    const summary = await fetchHapiSummary(req.countryCode);
    const result: GetHumanitarianSummaryResponse = { summary };
    if (summary) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { summary: undefined };
  }
}
