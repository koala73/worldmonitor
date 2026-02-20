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
      countryCode: ISO2_TO_ISO3[countryCode.toUpperCase()] || countryCode || '',
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

export async function getHumanitarianSummary(
  _ctx: ServerContext,
  req: GetHumanitarianSummaryRequest,
): Promise<GetHumanitarianSummaryResponse> {
  try {
    const summary = await fetchHapiSummary(req.countryCode);
    return { summary };
  } catch {
    return { summary: undefined };
  }
}
