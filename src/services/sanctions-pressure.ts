import { createCircuitBreaker } from '@/utils';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import { getHydratedData } from '@/services/bootstrap';
import { hasPremiumAccess } from '@/services/panel-gating';
import { toApiUrl } from '@/services/runtime';
import {
  SanctionsServiceClient,
  type SanctionsEntry as ProtoSanctionsEntry,
  type SanctionsEntityType as ProtoSanctionsEntityType,
  type CountrySanctionsPressure as ProtoCountryPressure,
  type ProgramSanctionsPressure as ProtoProgramPressure,
  type ListSanctionsPressureResponse,
} from '@/generated/client/worldmonitor/sanctions/v1/service_client';

export type SanctionsEntityType = 'entity' | 'individual' | 'vessel' | 'aircraft';

export interface SanctionsEntry {
  id: string;
  name: string;
  entityType: SanctionsEntityType;
  countryCodes: string[];
  countryNames: string[];
  programs: string[];
  sourceLists: string[];
  effectiveAt: Date | null;
  isNew: boolean;
  note: string;
}

export interface CountrySanctionsPressure {
  countryCode: string;
  countryName: string;
  entryCount: number;
  newEntryCount: number;
  vesselCount: number;
  aircraftCount: number;
}

export interface ProgramSanctionsPressure {
  program: string;
  entryCount: number;
  newEntryCount: number;
}

export interface SanctionsPressureResult {
  fetchedAt: Date;
  datasetDate: Date | null;
  totalCount: number;
  sdnCount: number;
  consolidatedCount: number;
  newEntryCount: number;
  vesselCount: number;
  aircraftCount: number;
  countries: CountrySanctionsPressure[];
  programs: ProgramSanctionsPressure[];
  entries: SanctionsEntry[];
}

// premiumFetch — listSanctionsPressure (the only method called here) is in
// PREMIUM_RPC_PATHS. See src/services/supply-chain/index.ts for the pattern
// and #3242 review HIGH(new) #1 for the bug class this prevents.
const client = new SanctionsServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
const breaker = createCircuitBreaker<SanctionsPressureResult>({
  name: 'Sanctions Pressure',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

let latestSanctionsPressureResult: SanctionsPressureResult | null = null;

const emptyResult: SanctionsPressureResult = {
  fetchedAt: new Date(0),
  datasetDate: null,
  totalCount: 0,
  sdnCount: 0,
  consolidatedCount: 0,
  newEntryCount: 0,
  vesselCount: 0,
  aircraftCount: 0,
  countries: [],
  programs: [],
  entries: [],
};

function mapEntityType(value: ProtoSanctionsEntityType): SanctionsEntityType {
  switch (value) {
    case 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL':
      return 'individual';
    case 'SANCTIONS_ENTITY_TYPE_VESSEL':
      return 'vessel';
    case 'SANCTIONS_ENTITY_TYPE_AIRCRAFT':
      return 'aircraft';
    default:
      return 'entity';
  }
}

function parseEpoch(value: string | number | null | undefined): Date | null {
  if (value == null) return null;
  const asNumber = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return new Date(asNumber);
}

function toEntry(raw: ProtoSanctionsEntry): SanctionsEntry {
  return {
    id: raw.id,
    name: raw.name,
    entityType: mapEntityType(raw.entityType),
    countryCodes: raw.countryCodes ?? [],
    countryNames: raw.countryNames ?? [],
    programs: raw.programs ?? [],
    sourceLists: raw.sourceLists ?? [],
    effectiveAt: parseEpoch(raw.effectiveAt as string | number | undefined),
    isNew: raw.isNew ?? false,
    note: raw.note ?? '',
  };
}

function toCountry(raw: ProtoCountryPressure): CountrySanctionsPressure {
  return {
    countryCode: raw.countryCode,
    countryName: raw.countryName,
    entryCount: raw.entryCount ?? 0,
    newEntryCount: raw.newEntryCount ?? 0,
    vesselCount: raw.vesselCount ?? 0,
    aircraftCount: raw.aircraftCount ?? 0,
  };
}

function toProgram(raw: ProtoProgramPressure): ProgramSanctionsPressure {
  return {
    program: raw.program,
    entryCount: raw.entryCount ?? 0,
    newEntryCount: raw.newEntryCount ?? 0,
  };
}

function toResult(response: ListSanctionsPressureResponse): SanctionsPressureResult {
  return {
    fetchedAt: parseEpoch(response.fetchedAt as string | number | undefined) || new Date(),
    datasetDate: parseEpoch(response.datasetDate as string | number | undefined),
    totalCount: response.totalCount ?? 0,
    sdnCount: response.sdnCount ?? 0,
    consolidatedCount: response.consolidatedCount ?? 0,
    newEntryCount: response.newEntryCount ?? 0,
    vesselCount: response.vesselCount ?? 0,
    aircraftCount: response.aircraftCount ?? 0,
    countries: (response.countries ?? []).map(toCountry),
    programs: (response.programs ?? []).map(toProgram),
    entries: (response.entries ?? []).map(toEntry),
  };
}

export async function fetchSanctionsPressure(): Promise<SanctionsPressureResult> {
  const hydrated = getHydratedData('sanctionsPressure') as ListSanctionsPressureResponse | undefined;
  if (hydrated?.entries?.length || hydrated?.countries?.length || hydrated?.programs?.length) {
    const result = toResult(hydrated);
    latestSanctionsPressureResult = result;
    return result;
  }

  // Anonymous (non-premium) users: do NOT call the Pro-gated RPC. The
  // RPC at /api/sanctions/v1/list-sanctions-pressure is in
  // PREMIUM_RPC_PATHS, so an anonymous client gets a deterministic 401
  // and the breaker fallback returns emptyResult anyway — same outcome
  // as us, minus the Sentry/console noise. Try the public bootstrap
  // endpoint as a second-best read path and surface whatever it serves
  // (or emptyResult on any failure).
  if (!hasPremiumAccess()) {
    try {
      const resp = await fetch(toApiUrl('/api/bootstrap?keys=sanctionsPressure'), {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const { data } = (await resp.json()) as { data?: { sanctionsPressure?: ListSanctionsPressureResponse } };
        const payload = data?.sanctionsPressure;
        if (payload?.entries?.length || payload?.countries?.length || payload?.programs?.length) {
          const result = toResult(payload);
          latestSanctionsPressureResult = result;
          return result;
        }
      }
    } catch { /* fall through to emptyResult */ }
    return emptyResult;
  }

  return breaker.execute(async () => {
    const response = await client.listSanctionsPressure({
      maxItems: 30,
    }, {
      signal: AbortSignal.timeout(25_000),
    });
    const result = toResult(response);
    latestSanctionsPressureResult = result;
    if (result.totalCount === 0) {
      // Seed is missing or the feed is down. Evict any stale cache so the
      // panel surfaces "unavailable" instead of serving old designations
      // indefinitely via stale-while-revalidate.
      breaker.clearCache();
    }
    return result;
  }, emptyResult, {
    shouldCache: (result) => result.totalCount > 0,
  });
}

export function getLatestSanctionsPressure(): SanctionsPressureResult | null {
  return latestSanctionsPressureResult;
}
