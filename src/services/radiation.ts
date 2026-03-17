import { createCircuitBreaker } from '@/utils';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';
import {
  RadiationServiceClient,
  type RadiationFreshness as ProtoRadiationFreshness,
  type RadiationObservation as ProtoRadiationObservation,
  type RadiationSeverity as ProtoRadiationSeverity,
  type RadiationSource as ProtoRadiationSource,
  type ListRadiationObservationsResponse,
} from '@/generated/client/worldmonitor/radiation/v1/service_client';

export type RadiationFreshness = 'live' | 'recent' | 'historical';
export type RadiationSeverity = 'normal' | 'elevated' | 'spike';

export interface RadiationObservation {
  id: string;
  source: 'EPA RadNet' | 'Safecast';
  location: string;
  country: string;
  lat: number;
  lon: number;
  value: number;
  unit: string;
  observedAt: Date;
  freshness: RadiationFreshness;
  baselineValue: number;
  delta: number;
  zScore: number;
  severity: RadiationSeverity;
}

export interface RadiationWatchResult {
  fetchedAt: Date;
  observations: RadiationObservation[];
  coverage: { epa: number; safecast: number };
  summary: {
    anomalyCount: number;
    elevatedCount: number;
    spikeCount: number;
  };
}

let latestRadiationWatchResult: RadiationWatchResult | null = null;

const breaker = createCircuitBreaker<RadiationWatchResult>({
  name: 'Radiation Watch',
  cacheTtlMs: 15 * 60 * 1000,
  persistCache: true,
});
const client = new RadiationServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const emptyResult: RadiationWatchResult = {
  fetchedAt: new Date(0),
  observations: [],
  coverage: { epa: 0, safecast: 0 },
  summary: { anomalyCount: 0, elevatedCount: 0, spikeCount: 0 },
};

function toObservation(raw: ProtoRadiationObservation): RadiationObservation {
  return {
    id: raw.id,
    source: mapSource(raw.source),
    location: raw.locationName,
    country: raw.country,
    lat: raw.location?.latitude ?? 0,
    lon: raw.location?.longitude ?? 0,
    value: raw.value,
    unit: raw.unit,
    observedAt: new Date(raw.observedAt),
    freshness: mapFreshness(raw.freshness),
    baselineValue: raw.baselineValue ?? raw.value,
    delta: raw.delta ?? 0,
    zScore: raw.zScore ?? 0,
    severity: mapSeverity(raw.severity),
  };
}

export async function fetchRadiationWatch(): Promise<RadiationWatchResult> {
  const hydrated = getHydratedData('radiationWatch') as ListRadiationObservationsResponse | undefined;
  if (hydrated?.observations?.length) {
    const result = toResult(hydrated);
    latestRadiationWatchResult = result;
    return result;
  }

  return breaker.execute(async () => {
    const response = await client.listRadiationObservations({
      maxItems: 18,
    }, {
      signal: AbortSignal.timeout(20_000),
    });
    const result = toResult(response);
    latestRadiationWatchResult = result;
    return result;
  }, emptyResult);
}

export function getLatestRadiationWatch(): RadiationWatchResult | null {
  return latestRadiationWatchResult;
}

function toResult(response: ListRadiationObservationsResponse): RadiationWatchResult {
  return {
    fetchedAt: new Date(response.fetchedAt),
    observations: (response.observations ?? []).map(toObservation),
    coverage: {
      epa: response.epaCount ?? 0,
      safecast: response.safecastCount ?? 0,
    },
    summary: {
      anomalyCount: response.anomalyCount ?? 0,
      elevatedCount: response.elevatedCount ?? 0,
      spikeCount: response.spikeCount ?? 0,
    },
  };
}

function mapSource(source: ProtoRadiationSource): RadiationObservation['source'] {
  switch (source) {
    case 'RADIATION_SOURCE_EPA_RADNET':
      return 'EPA RadNet';
    case 'RADIATION_SOURCE_SAFECAST':
      return 'Safecast';
    default:
      return 'Safecast';
  }
}

function mapFreshness(freshness: ProtoRadiationFreshness): RadiationFreshness {
  switch (freshness) {
    case 'RADIATION_FRESHNESS_LIVE':
      return 'live';
    case 'RADIATION_FRESHNESS_RECENT':
      return 'recent';
    default:
      return 'historical';
  }
}

function mapSeverity(severity: ProtoRadiationSeverity): RadiationSeverity {
  switch (severity) {
    case 'RADIATION_SEVERITY_SPIKE':
      return 'spike';
    case 'RADIATION_SEVERITY_ELEVATED':
      return 'elevated';
    default:
      return 'normal';
  }
}
