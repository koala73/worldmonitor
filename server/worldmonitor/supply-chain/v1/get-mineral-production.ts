import type {
  ServerContext,
  GetMineralProductionRequest,
  GetMineralProductionResponse,
  MineralProductionRecord,
  MineralStageSnapshot,
  MineralCountryShare,
  MineralCountryPortfolio,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const CANONICAL_KEY = 'supply-chain:mineral-production:v1';

interface SeedCountry {
  iso2?: string;
  country?: string;
  output?: number | null;
  share?: number | null;
  withheld?: boolean;
  estimated?: boolean;
  residual?: boolean;
}

interface SeedStage {
  year?: number;
  unit?: string;
  countries?: SeedCountry[];
  hhi?: number;
  worldTotal?: number | null;
  withheldCount?: number;
}

interface SeedCommodity {
  id?: string;
  label?: string;
  year?: number;
  unit?: string;
  stages?: { mine?: SeedStage | null; refinery?: SeedStage | null };
  sources?: string[];
}

interface SeedPayload {
  fetchedAt?: string;
  dataYear?: number | null;
  commodities?: Record<string, SeedCommodity>;
}

function emptyResponse(fetchedAt = ''): GetMineralProductionResponse {
  return {
    commodities: [],
    countries: [],
    fetchedAt,
    upstreamUnavailable: true,
    dataYear: 0,
  };
}

function mapStage(stage: SeedStage | null | undefined): MineralStageSnapshot | undefined {
  if (!stage) return undefined;
  const countries: MineralCountryShare[] = (stage.countries || []).map((c) => ({
    iso2: c.iso2 || '',
    country: c.country || '',
    withheld: Boolean(c.withheld),
    estimated: Boolean(c.estimated),
    residual: Boolean(c.residual),
    ...(c.output != null ? { output: c.output } : {}),
    ...(c.share != null ? { share: c.share } : {}),
  }));
  return {
    year: stage.year || 0,
    unit: stage.unit || '',
    countries,
    hhi: stage.hhi || 0,
    withheldCount: stage.withheldCount || 0,
    ...(stage.worldTotal != null ? { worldTotal: stage.worldTotal } : {}),
  };
}

function filterStage(
  stage: MineralStageSnapshot | undefined,
  iso2: string,
): MineralStageSnapshot | undefined {
  if (!stage) return undefined;
  if (!iso2) return stage;
  const countries = stage.countries.filter((c) => c.iso2 === iso2);
  if (!countries.length) return undefined;
  return { ...stage, countries };
}

export function projectMineralProduction(
  payload: SeedPayload | null | undefined,
  req: GetMineralProductionRequest,
): GetMineralProductionResponse {
  if (!payload?.commodities) return emptyResponse();

  const commodityFilter = (req.commodity || '').trim().toLowerCase();
  const iso2 = (req.iso2 || '').trim().toUpperCase();
  const rawStage = (req.stage || '').trim().toLowerCase();
  const stageFilter = rawStage === 'smelter' || rawStage === 'smelting' ? 'refinery' : rawStage;

  const records: MineralProductionRecord[] = [];
  for (const item of Object.values(payload.commodities)) {
    const id = item.id || '';
    const label = item.label || id;
    if (commodityFilter && id !== commodityFilter && label.toLowerCase() !== commodityFilter) {
      continue;
    }
    let mine = stageFilter && stageFilter !== 'mine' ? undefined : mapStage(item.stages?.mine);
    let refinery = stageFilter && stageFilter !== 'refinery' ? undefined : mapStage(item.stages?.refinery);
    mine = filterStage(mine, iso2);
    refinery = filterStage(refinery, iso2);
    if (iso2 && !(mine?.countries.length) && !(refinery?.countries.length)) continue;
    if (!mine && !refinery) continue;
    records.push({
      commodityId: id,
      commodity: label,
      year: item.year || mine?.year || refinery?.year || 0,
      unit: item.unit || mine?.unit || refinery?.unit || '',
      sources: Array.isArray(item.sources) ? item.sources : [],
      ...(mine ? { mine } : {}),
      ...(refinery ? { refinery } : {}),
    });
  }

  const countries: MineralCountryPortfolio[] = [];
  if (iso2) {
    const holdings = [];
    for (const rec of records) {
      for (const stageName of ['mine', 'refinery'] as const) {
        const snap = rec[stageName];
        const hit = snap?.countries.find((c) => c.iso2 === iso2);
        if (!hit) continue;
        holdings.push({
          commodityId: rec.commodityId,
          commodity: rec.commodity,
          stage: stageName,
          withheld: hit.withheld,
          ...(hit.output != null ? { output: hit.output } : {}),
          ...(hit.share != null ? { share: hit.share } : {}),
        });
      }
    }
    if (holdings.length) countries.push({ iso2, holdings });
  }

  return {
    commodities: records,
    countries,
    fetchedAt: payload.fetchedAt || '',
    upstreamUnavailable: false,
    dataYear: payload.dataYear || 0,
  };
}

export async function getMineralProduction(
  _ctx: ServerContext,
  req: GetMineralProductionRequest,
): Promise<GetMineralProductionResponse> {
  try {
    const payload = await getCachedJson(CANONICAL_KEY, true) as SeedPayload | null;
    return projectMineralProduction(payload, req);
  } catch {
    return emptyResponse(new Date().toISOString());
  }
}
