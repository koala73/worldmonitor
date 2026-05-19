import { dataFreshness, type SeedHealthUpdate } from '@/services/data-freshness';
import type { DataSourceId } from '@/types';

interface HealthCheck {
  status?: string;
  records?: number | null;
  seedAgeMin?: number | null;
  maxStaleMin?: number | null;
}

interface HealthResponse {
  status?: string;
  checkedAt?: string;
  checks?: Record<string, HealthCheck>;
}

export const HEALTH_CHECK_SOURCE_MAP: Record<string, DataSourceId[]> = {
  unrestEvents: ['acled', 'gdelt_doc'],
  gdeltIntel: ['gdelt'],
  newsInsights: ['rss'],
  outages: ['outages'],
  cyberThreats: ['cyber_threats'],
  naturalEvents: ['usgs'],
  weatherAlerts: ['weather'],
  spending: ['spending'],
  wildfires: ['firms'],
  ucdpEvents: ['ucdp_events'],
  displacement: ['unhcr'],
  climateAnomalies: ['climate'],
  climateDisasters: ['climate'],
  climateAirQuality: ['climate'],
  predictionMarkets: ['polymarket'],
  forecasts: ['predictions'],
  pizzint: ['pizzint'],
  gpsjam: ['gpsjam'],
  securityAdvisories: ['security_advisories'],
  sanctionsPressure: ['sanctions_pressure'],
  radiationWatch: ['radiation'],
  customsRevenue: ['treasury_revenue'],
  bisPolicy: ['bis'],
  bisDsr: ['bis'],
  bisPropertyResidential: ['bis'],
  bisPropertyCommercial: ['bis'],
  blsSeries: ['bls'],
  shippingRates: ['supply_chain'],
  chokepoints: ['supply_chain'],
  shippingStress: ['supply_chain'],
};

export interface RefreshHealthFreshnessOptions {
  fetchFn?: typeof fetch;
  endpoint?: string;
  signal?: AbortSignal;
  urlResolver?: (path: string) => string;
}

function statusRank(status: string): number {
  switch (status) {
    case 'SEED_ERROR':
    case 'REDIS_DOWN':
    case 'REDIS_PARTIAL':
      return 5;
    case 'EMPTY':
    case 'EMPTY_DATA':
      return 4;
    case 'STALE_SEED':
    case 'COVERAGE_PARTIAL':
      return 3;
    case 'EMPTY_ON_DEMAND':
      return 2;
    case 'OK_CASCADE':
      return 1;
    case 'OK':
      return 0;
    default:
      return 0;
  }
}

function stalenessRatio(update: SeedHealthUpdate): number {
  if (update.seedAgeMin == null || update.maxStaleMin == null) return 0;
  if (update.maxStaleMin === 0) {
    return update.seedAgeMin === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return update.seedAgeMin / update.maxStaleMin;
}

function isRedisOutageStatus(status: string | undefined): status is 'REDIS_DOWN' | 'REDIS_PARTIAL' {
  return status === 'REDIS_DOWN' || status === 'REDIS_PARTIAL';
}

function getMappedSourceIds(): DataSourceId[] {
  return [...new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat())];
}

export async function refreshDataFreshnessFromHealth(options: RefreshHealthFreshnessOptions = {}): Promise<number> {
  const fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
  const endpoint = options.endpoint ?? '/api/health';
  const url = options.urlResolver
    ? options.urlResolver(endpoint)
    : (await import('@/services/runtime')).toApiUrl(endpoint);
  const resp = await fetchFn(url, {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  if (!resp.ok) throw new Error(`health freshness fetch failed: ${resp.status}`);

  const payload = await resp.json() as HealthResponse;
  const checkedAtMs = payload.checkedAt ? Date.parse(payload.checkedAt) : Date.now();
  const checkedAt = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  const updatesBySource = new Map<DataSourceId, SeedHealthUpdate>();
  const checks = payload.checks ?? {};

  if (Object.keys(checks).length === 0 && isRedisOutageStatus(payload.status)) {
    const status = payload.status;
    const updates = getMappedSourceIds().map((sourceId) => ({
      sourceId,
      status,
      records: 0,
      checkedAtMs: checkedAt,
    }));
    dataFreshness.recordSeedHealth(updates);
    return updates.length;
  }

  for (const [checkName, check] of Object.entries(checks)) {
    const sourceIds = HEALTH_CHECK_SOURCE_MAP[checkName];
    if (!sourceIds?.length || !check.status) continue;
    for (const sourceId of sourceIds) {
      const next = {
        sourceId,
        status: check.status,
        records: check.records,
        seedAgeMin: check.seedAgeMin,
        maxStaleMin: check.maxStaleMin,
        checkedAtMs: checkedAt,
      };
      const existing = updatesBySource.get(sourceId);
      if (
        !existing ||
        statusRank(next.status) > statusRank(existing.status) ||
        (statusRank(next.status) === statusRank(existing.status) && stalenessRatio(next) > stalenessRatio(existing))
      ) {
        updatesBySource.set(sourceId, next);
      }
    }
  }

  const updates = [...updatesBySource.values()];
  dataFreshness.recordSeedHealth(updates);
  return updates.length;
}
