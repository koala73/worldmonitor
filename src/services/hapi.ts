import { createCircuitBreaker, fetchWithCache } from '@/utils';

export interface HapiConflictSummary {
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

// ISO3 → ISO2 mapping for tier-1 countries
const ISO3_TO_ISO2: Record<string, string> = {
  USA: 'US', RUS: 'RU', CHN: 'CN', UKR: 'UA', IRN: 'IR',
  ISR: 'IL', TWN: 'TW', PRK: 'KP', SAU: 'SA', TUR: 'TR',
  POL: 'PL', DEU: 'DE', FRA: 'FR', GBR: 'GB', IND: 'IN',
  PAK: 'PK', SYR: 'SY', YEM: 'YE', MMR: 'MM', VEN: 'VE',
};

const hapiBreaker = createCircuitBreaker<Map<string, HapiConflictSummary>>({ name: 'HDX HAPI' });

export async function fetchHapiSummary(): Promise<Map<string, HapiConflictSummary>> {
  return hapiBreaker.execute(async () => {
    const result = await fetchWithCache<{ countries?: HapiConflictSummary[] }>('/api/hapi', {
      ttl: 300_000,
      headers: { Accept: 'application/json' },
    });
    const countries: HapiConflictSummary[] = result.countries || [];

    const byCode = new Map<string, HapiConflictSummary>();

    for (const c of countries) {
      const iso2 = ISO3_TO_ISO2[c.iso3];
      if (!iso2) continue;
      byCode.set(iso2, c);
    }

    console.log(`[HAPI] ${byCode.size} country summaries loaded`);
    return byCode;
  }, new Map());
}
