import type {
  ServerContext,
  GetSectorDependencyRequest,
  GetSectorDependencyResponse,
  DependencyFlag,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { SECTOR_DEPENDENCY_KEY } from '../../../_shared/cache-keys';
import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT } from '../../../_shared/bypass-corridors';
import { ISO2_TO_COMTRADE } from '../../intelligence/v1/_comtrade-reporters';
import COUNTRY_PORT_CLUSTERS from '../../../../scripts/shared/country-port-clusters.json';

const CACHE_TTL = 86400; // 24 hours

const HS2_LABELS: Record<string, string> = {
  '1': 'Live Animals', '2': 'Meat', '3': 'Fish & Seafood', '4': 'Dairy',
  '6': 'Plants & Flowers', '7': 'Vegetables', '8': 'Fruit & Nuts',
  '10': 'Cereals', '11': 'Milling Products', '12': 'Oilseeds', '15': 'Animal & Vegetable Fats',
  '16': 'Meat Preparations', '17': 'Sugar', '18': 'Cocoa', '19': 'Food Preparations',
  '22': 'Beverages & Spirits', '23': 'Residues & Animal Feed', '24': 'Tobacco',
  '25': 'Salt & Cement', '26': 'Ores, Slag & Ash', '27': 'Mineral Fuels & Energy',
  '28': 'Inorganic Chemicals', '29': 'Organic Chemicals', '30': 'Pharmaceuticals',
  '31': 'Fertilizers', '38': 'Chemical Products', '39': 'Plastics',
  '40': 'Rubber', '44': 'Wood', '47': 'Pulp & Paper', '48': 'Paper & Paperboard',
  '52': 'Cotton', '61': 'Clothing (Knitted)', '62': 'Clothing (Woven)',
  '71': 'Precious Metals & Gems', '72': 'Iron & Steel', '73': 'Iron & Steel Articles',
  '74': 'Copper', '76': 'Aluminium', '79': 'Zinc', '80': 'Tin',
  '84': 'Machinery & Mechanical Appliances', '85': 'Electrical & Electronic Equipment',
  '86': 'Railway', '87': 'Vehicles', '88': 'Aircraft', '89': 'Ships & Boats',
  '90': 'Optical & Medical Instruments', '93': 'Arms & Ammunition',
};

interface PortClusterEntry { nearestRouteIds: string[]; coastSide: string; }

interface ComtradeFlowRecord {
  reporterCode: string;
  partnerCode: string;
  cmdCode: string;
  tradeValueUsd: number;
  year: number;
}

interface ComtradeFlowsResult {
  flows?: ComtradeFlowRecord[];
  fetchedAt?: string;
}

function computeExposures(nearestRouteIds: string[], hs2: string) {
  // Landlocked or unmapped countries have no routes; return empty so callers
  // receive primaryChokepointId = '' and primaryChokepointExposure = 0 rather than
  // an arbitrary registry-first entry with score 0.
  if (nearestRouteIds.length === 0) return [];
  const isEnergy = hs2 === '27';
  const routeSet = new Set(nearestRouteIds);
  return CHOKEPOINT_REGISTRY.map(cp => {
    const overlap = cp.routeIds.filter(r => routeSet.has(r)).length;
    const maxRoutes = Math.max(cp.routeIds.length, 1);
    let score = (overlap / maxRoutes) * 100;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    return { chokepointId: cp.id, exposureScore: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.exposureScore - a.exposureScore);
}

async function getTopExporterShare(iso2: string, hs2: string): Promise<{ exporterIso2: string; share: number }> {
  const numericCode = ISO2_TO_COMTRADE[iso2];
  if (!numericCode) return { exporterIso2: '', share: 0 };

  const key = `comtrade:flows:${numericCode}:${hs2.padStart(4, '0').slice(0, 4)}`;
  const result = await getCachedJson(key, true).catch(() => null);
  if (!result) return { exporterIso2: '', share: 0 };

  const raw = result as ComtradeFlowsResult;
  const flows: ComtradeFlowRecord[] = Array.isArray(result)
    ? (result as ComtradeFlowRecord[])
    : (raw.flows ?? []);

  if (flows.length === 0) return { exporterIso2: '', share: 0 };

  const totals = new Map<string, number>();
  let grandTotal = 0;
  for (const f of flows) {
    if (!f.partnerCode || f.partnerCode === '0' || f.partnerCode === '899') continue;
    const prev = totals.get(f.partnerCode) ?? 0;
    totals.set(f.partnerCode, prev + (f.tradeValueUsd ?? 0));
    grandTotal += f.tradeValueUsd ?? 0;
  }
  if (grandTotal === 0) return { exporterIso2: '', share: 0 };

  let topCode = '';
  let topValue = 0;
  for (const [code, val] of totals) {
    if (val > topValue) { topValue = val; topCode = code; }
  }

  const share = topValue / grandTotal;
  // Reverse-lookup numeric code to ISO2
  const exporterIso2 = Object.entries(ISO2_TO_COMTRADE).find(([, v]) => v === topCode)?.[0] ?? '';
  return { exporterIso2, share };
}

export async function getSectorDependency(
  ctx: ServerContext,
  req: GetSectorDependencyRequest,
): Promise<GetSectorDependencyResponse> {
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetSectorDependencyResponse = {
    iso2: req.iso2,
    hs2: req.hs2 || '27',
    hs2Label: HS2_LABELS[req.hs2 || '27'] ?? `HS ${req.hs2}`,
    flags: [],
    primaryExporterIso2: '',
    primaryExporterShare: 0,
    primaryChokepointId: '',
    primaryChokepointExposure: 0,
    hasViableBypass: false,
    fetchedAt: new Date().toISOString(),
  };
  if (!isPro) return empty;

  const iso2 = req.iso2?.trim().toUpperCase();
  const hs2 = req.hs2?.trim().replace(/\D/g, '') || '27';

  if (!/^[A-Z]{2}$/.test(iso2 ?? '') || !/^\d{1,2}$/.test(hs2)) {
    return { ...empty, iso2: iso2 ?? '', hs2 };
  }

  const cacheKey = SECTOR_DEPENDENCY_KEY(iso2, hs2);

  try {
    const result = await cachedFetchJson<GetSectorDependencyResponse>(
      cacheKey,
      CACHE_TTL,
      async () => {
        const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
        const cluster = clusters[iso2];
        const nearestRouteIds = cluster?.nearestRouteIds ?? [];

        const exposures = computeExposures(nearestRouteIds, hs2);
        const primary = exposures[0];

        const primaryChokepointId = primary?.chokepointId ?? '';
        const primaryChokepointExposure = primary?.exposureScore ?? 0;

        const bypassCorridors = BYPASS_CORRIDORS_BY_CHOKEPOINT[primaryChokepointId] ?? [];
        const hasViableBypass = bypassCorridors.some(c => c.suitableCargoTypes.length > 0);

        const { exporterIso2, share: primaryExporterShare } = await getTopExporterShare(iso2, hs2);

        const isSingleSource = primaryExporterShare > 0.8;
        const isSingleCorridor = primaryChokepointExposure > 80 && !hasViableBypass;
        const isDiversifiable = hasViableBypass && !isSingleSource;

        const flags: DependencyFlag[] = [];
        if (isSingleSource && isSingleCorridor) {
          flags.push('DEPENDENCY_FLAG_COMPOUND_RISK');
        } else if (isSingleSource) {
          flags.push('DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL');
        } else if (isSingleCorridor) {
          flags.push('DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL');
        } else if (isDiversifiable) {
          flags.push('DEPENDENCY_FLAG_DIVERSIFIABLE');
        }

        return {
          iso2,
          hs2,
          hs2Label: HS2_LABELS[hs2] ?? `HS ${hs2}`,
          flags,
          primaryExporterIso2: exporterIso2,
          primaryExporterShare: Math.round(primaryExporterShare * 1000) / 1000,
          primaryChokepointId,
          primaryChokepointExposure,
          hasViableBypass,
          fetchedAt: new Date().toISOString(),
        };
      },
    );

    return result ?? { ...empty, iso2, hs2 };
  } catch {
    return { ...empty, iso2, hs2 };
  }
}
