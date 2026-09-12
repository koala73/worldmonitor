import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import commodityRegistry from '../../scripts/shared/supply-vulnerability-commodities.json';
import { premiumFetch } from '@/services/premium-fetch';
import type { DecisionBriefCapture, DecisionBriefSelection } from '@/types/decision-brief';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

export async function captureDecisionBrief(selection: DecisionBriefSelection, signal: AbortSignal): Promise<[DecisionBriefCapture, DecisionBriefCapture]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const capture = async (disruptionPct: number): Promise<DecisionBriefCapture> => ({
    response: await client.computeEnergyShockScenario({ countryCode: selection.countryCode, chokepointId: selection.chokepointId, fuelMode: selection.fuelMode, disruptionPct }, { signal: requestSignal }),
    retrievedAt: new Date().toISOString(),
  });
  return Promise.all([capture(selection.baselinePct), capture(selection.comparisonPct)]);
}

export async function captureCommodityBrief(
  selection: import('@/types/decision-brief').CommodityBriefSelection,
  signal: AbortSignal,
): Promise<import('@/types/decision-brief').CommodityBriefCapture> {
  const { SupplyChainServiceClient } = await import('@/services/generated-rpc-clients');
  const supply = new SupplyChainServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const commodity = commodityRegistry.commodities.find(c => c.id === selection.commodityId);
  const [products, vulnerabilities, production] = await Promise.all([
    supply.getCountryProducts({ iso2: selection.countryCode, hs4: commodity?.hs4[0] }, { signal: requestSignal }),
    supply.getCountryVulnerabilities({ iso2: selection.countryCode }, { signal: requestSignal }),
    // World output for the commodity, not for the reporting country: the brief
    // joins it per origin, so an `iso2` filter would return only the importer's
    // own holdings. Empty `iso2`/`stage` are dropped from the query string.
    // Production is supporting evidence — a failure degrades the brief to
    // "production share unavailable" rather than failing the whole capture.
    commodity?.mineralProductionId
      ? supply.getMineralProduction({ commodity: commodity.mineralProductionId, iso2: '', stage: '' }, { signal: requestSignal }).catch(() => null)
      : null,
  ]);
  return { products, vulnerabilities, production, retrievedAt: new Date().toISOString() };
}
