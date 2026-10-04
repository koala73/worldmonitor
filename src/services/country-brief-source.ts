import { IS_EMBEDDED_PREVIEW } from '@/utils/embedded-preview';
import type { createHostCountryFetch } from './country-brief-host-transport';
import { IntelligenceServiceClient, MarketServiceClient, MilitaryServiceClient, MaritimeServiceClient, EconomicServiceClient, TradeServiceClient, SupplyChainServiceClient, ResilienceServiceClient, ScorecardServiceClient, PredictionServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import { hasPremiumAccess } from '@/services/panel-gating';
import { fetchMultiSectorCostShock, fetchMultiSectorExposure, fetchBypassOptions, fetchChokepointStatus, HS2_SHORT_LABELS, SEEDED_HS2_CODES } from '@/services/supply-chain';

function createCountryBriefSource(fetcher: typeof fetch & { clear?: () => void }, mode: 'website' | 'host') {
  const base = mode === 'host' ? 'https://www.worldmonitor.app' : getRpcBaseUrl();
  const options = { fetch: fetcher };
  const intelligence = new IntelligenceServiceClient(base, options);
  const supply = new SupplyChainServiceClient(base, options);
  const resilience = new ResilienceServiceClient(base, options);
  const scorecard = new ScorecardServiceClient(base, options);
  return {
    mode,
    canRequestPremium: () => mode === 'host' || (!IS_EMBEDDED_PREVIEW && hasPremiumAccess()),
    fetch: fetcher,
    clearLoadedData: fetcher.clear ?? (() => {}),
    intelligence,
    market: new MarketServiceClient(base, options),
    economic: new EconomicServiceClient(base, options),
    trade: new TradeServiceClient(base, options),
    military: new MilitaryServiceClient(base, options),
    vessels: new MaritimeServiceClient(base, options),
    prediction: new PredictionServiceClient(base, options),
    supply,
    atlas: (code: string, signal: AbortSignal) => {
      const detailClient = new SupplyChainServiceClient(base, { fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), base);
        if (mode === 'host') url.searchParams.set('country_code', code);
        return fetcher(url, { ...init, signal });
      } });
      return {
        getPipelineDetail: (args: Parameters<typeof supply.getPipelineDetail>[0]) => detailClient.getPipelineDetail(args, { signal }),
        getStorageFacilityDetail: (args: Parameters<typeof supply.getStorageFacilityDetail>[0]) => detailClient.getStorageFacilityDetail(args, { signal }),
        getFuelShortageDetail: (args: Parameters<typeof supply.getFuelShortageDetail>[0]) => detailClient.getFuelShortageDetail(args, { signal }),
        listEnergyDisruptions: async (args: Parameters<typeof supply.listEnergyDisruptions>[0]) => {
          const result = await supply.listEnergyDisruptions({ assetId: '', assetType: '', ongoingOnly: false }, { signal });
          if (result.upstreamUnavailable) throw new Error('Disruption timeline is unavailable.');
          return { ...result, events: result.events.filter(event => event.assetId === args.assetId && event.assetType === args.assetType && event.countries.includes(code)) };
        },
      };
    },
    food: async (code: string, signal: AbortSignal) => mode === 'website' ? (await import('@/services/resilience')).getFoodStocks({ countryCode: code, signal }) : resilience.getFoodStocks({ countryCode: code, commodity: '' }, { signal }),
    demographics: async (code: string, signal: AbortSignal) => mode === 'website' ? (await import('@/services/resilience')).getDemographicsCapability({ countryCode: code, signal }) : resilience.getDemographicsCapability({ countryCode: code }, { signal }),
    factors: async (code: string, signal: AbortSignal) => mode === 'website' ? (await import('@/services/scorecard')).getFiveFactorScorecard(code, signal) : (await import('@/services/scorecard')).withScorecardDeadline(requestSignal => scorecard.getFiveFactorScorecard({ countryCode: code }, { signal: requestSignal }), signal),
    resilience: async (code: string, signal: AbortSignal) => mode === 'website' ? (await import('@/services/resilience')).getResilienceScore(code) : resilience.getResilienceScore({ countryCode: code }, { signal }),
    cost: (code: string, chokepoint: string, days: number, signal: AbortSignal) => mode === 'website' ? fetchMultiSectorCostShock(code, chokepoint, days, { signal }) : supply.getMultiSectorCostShock({ iso2: code, chokepointId: chokepoint, closureDays: days }, { signal }),
    bypass: (chokepointId: string, signal: AbortSignal) => mode === 'website' ? fetchBypassOptions(chokepointId, 'container', 100) : supply.getBypassOptions({ chokepointId, cargoType: 'container', closurePct: 100 }, { signal }),
    chokepoints: (signal: AbortSignal) => mode === 'website' ? fetchChokepointStatus() : supply.getChokepointStatus({}, { signal }),
    exposure: async (code: string, signal: AbortSignal) => {
      if (mode === 'website') return fetchMultiSectorExposure(code);
      const results = await Promise.all(SEEDED_HS2_CODES.map(async hs2 => {
        const exposure = await supply.getCountryChokepointIndex({ iso2: code, hs2 }, { signal });
        if (!exposure.exposures.length) return null;
        const dep = await supply.getSectorDependency({ iso2: code, hs2 }, { signal });
        return { hs2, label: HS2_SHORT_LABELS[hs2] ?? hs2, primaryChokepointId: exposure.primaryChokepointId, primaryChokepointName: exposure.exposures[0]?.chokepointName ?? exposure.primaryChokepointId, exposureScore: exposure.exposures[0]?.exposureScore ?? 0, vulnerabilityIndex: exposure.vulnerabilityIndex, dependencyFlag: dep.flags[0] ?? '', primaryExporterIso2: dep.primaryExporterIso2, primaryExporterShare: dep.primaryExporterShare, fetchedAt: exposure.fetchedAt };
      }));
      return results.filter(result => result !== null).sort((a, b) => b.vulnerabilityIndex - a.vulnerabilityIndex);
    },
  };
}
export type CountryBriefSource = ReturnType<typeof createCountryBriefSource>;
export const createWebsiteCountryBriefSource = () => createCountryBriefSource(premiumFetch, 'website');

export async function createHostCountryBriefSource(call: Parameters<typeof createHostCountryFetch>[0]) {
  const { createHostCountryFetch } = await import('./country-brief-host-transport');
  return createCountryBriefSource(createHostCountryFetch(call), 'host');
}
