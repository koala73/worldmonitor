import type { DataSourceId } from '@/types';

export const HEALTH_CHECK_SOURCE_MAP: Record<string, readonly DataSourceId[]> = {
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

const HEALTH_MAPPED_SOURCE_IDS = new Set<DataSourceId>(
  Object.values(HEALTH_CHECK_SOURCE_MAP).flat(),
);

export function isHealthMappedSource(sourceId: DataSourceId): boolean {
  return HEALTH_MAPPED_SOURCE_IDS.has(sourceId);
}

export function getHealthMappedSourceIds(): DataSourceId[] {
  return [...HEALTH_MAPPED_SOURCE_IDS];
}
