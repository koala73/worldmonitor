import type {
  ServerContext,
  GetHumanitarianSummaryBatchRequest,
  GetHumanitarianSummaryBatchResponse,
  HumanitarianCountrySummary,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getCachedJsonBatch, cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { ISO2_TO_ISO3 } from './_shared';
import { toUniqueSortedLimited } from '../../../_shared/normalize-list';

const REDIS_CACHE_KEY = 'conflict:humanitarian:v1';
const REDIS_CACHE_TTL = 21600;
const ISO2_PATTERN = /^[A-Z]{2}$/;

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

async function fetchSingleHapiSummary(countryCode: string): Promise<HumanitarianCountrySummary | undefined> {
  try {
    const iso3 = ISO2_TO_ISO3[countryCode.toUpperCase()];
    if (!iso3) return undefined;

    const appId = btoa('worldmonitor:monitor@worldmonitor.app');
    const url = `https://hapi.humdata.org/api/v2/coordination-context/conflict-events?output_format=json&limit=1000&offset=0&app_identifier=${appId}&location_code=${iso3}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return undefined;

    const rawData = await response.json();
    const records: any[] = rawData.data || [];

    const byCountry: Record<string, HapiCountryAgg> = {};
    for (const r of records) {
      const rIso3 = r.location_code || '';
      if (!rIso3) continue;
      const month = r.reference_period_start || '';
      const eventType = (r.event_type || '').toLowerCase();
      const events = r.events || 0;
      const fatalities = r.fatalities || 0;

      if (!byCountry[rIso3]) {
        byCountry[rIso3] = {
          iso3: rIso3, locationName: r.location_name || '', month,
          eventsTotal: 0, eventsPoliticalViolence: 0, eventsCivilianTargeting: 0,
          eventsDemonstrations: 0, fatalitiesTotalPoliticalViolence: 0, fatalitiesTotalCivilianTargeting: 0,
        };
      }

      const c = byCountry[rIso3];
      if (month > c.month) {
        c.month = month;
        c.eventsTotal = 0; c.eventsPoliticalViolence = 0; c.eventsCivilianTargeting = 0;
        c.eventsDemonstrations = 0; c.fatalitiesTotalPoliticalViolence = 0; c.fatalitiesTotalCivilianTargeting = 0;
      }
      if (month === c.month) {
        c.eventsTotal += events;
        if (eventType.includes('political_violence')) { c.eventsPoliticalViolence += events; c.fatalitiesTotalPoliticalViolence += fatalities; }
        if (eventType.includes('civilian_targeting')) { c.eventsCivilianTargeting += events; c.fatalitiesTotalCivilianTargeting += fatalities; }
        if (eventType.includes('demonstration')) { c.eventsDemonstrations += events; }
      }
    }

    const entry = byCountry[iso3];
    if (!entry) return undefined;

    return {
      countryCode: countryCode.toUpperCase(),
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

export async function getHumanitarianSummaryBatch(
  _ctx: ServerContext,
  req: GetHumanitarianSummaryBatchRequest,
): Promise<GetHumanitarianSummaryBatchResponse> {
  try {
    const normalized = req.countryCodes
      .map((c) => c.trim().toUpperCase())
      .filter((c) => ISO2_PATTERN.test(c));
    const limitedList = toUniqueSortedLimited(normalized, 25);

    const results: Record<string, HumanitarianCountrySummary> = {};
    const toFetch: string[] = [];

    const cacheKeys = limitedList.map((cc) => `${REDIS_CACHE_KEY}:${cc}`);
    const cachedMap = await getCachedJsonBatch(cacheKeys);

    for (let i = 0; i < limitedList.length; i++) {
      const cc = limitedList[i]!;
      const cached = cachedMap.get(cacheKeys[i]!) as { summary?: HumanitarianCountrySummary } | undefined;
      if (cached?.summary) {
        results[cc] = cached.summary;
      } else if (cached === undefined) {
        toFetch.push(cc);
      }
    }

    // Fetch uncached countries in concurrent groups of 5 for partial-success resilience
    const CONCURRENCY = 5;
    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (cc) => {
          const cacheResult = await cachedFetchJson<{ summary?: HumanitarianCountrySummary }>(
            `${REDIS_CACHE_KEY}:${cc}`,
            REDIS_CACHE_TTL,
            async () => {
              const summary = await fetchSingleHapiSummary(cc);
              return summary ? { summary } : null;
            },
          );
          if (cacheResult?.summary) results[cc] = cacheResult.summary;
        }),
      );
      // Log failures for visibility but don't abort
      for (const r of settled) {
        if (r.status === 'rejected') console.warn('[HAPI batch] fetch failed:', r.reason);
      }
    }

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
    };
  } catch {
    return { results: {}, fetched: 0, requested: 0 };
  }
}
