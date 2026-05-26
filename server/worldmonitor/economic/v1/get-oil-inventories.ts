import type {
  ServerContext,
  GetOilInventoriesRequest,
  GetOilInventoriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const CRUDE_KEY = 'economic:crude-inventories:v1';
const SPR_KEY = 'economic:spr:v1';
const NAT_GAS_KEY = 'economic:nat-gas-storage:v1';
const EU_GAS_KEY = 'economic:eu-gas-storage:v1';
const IEA_KEY = 'energy:oil-stocks-analysis:v1';
const REFINERY_KEY = 'economic:refinery-inputs:v1';

interface CrudeRaw {
  weeks?: Array<{ period: string; stocksMb: number; weeklyChangeMb?: number }>;
}

interface SprRaw {
  latestPeriod?: string;
  barrels?: number;
  changeWoW?: number;
  weeks?: Array<{ period: string; barrels: number }>;
}

interface NatGasRaw {
  weeks?: Array<{ period: string; storBcf: number; weeklyChangeBcf?: number }>;
}

interface EuGasRaw {
  fillPct?: number;
  fillPctChange1d?: number;
  trend?: string;
  history?: Array<{ date: string; fillPct: number }>;
}

interface IeaMemberRaw {
  iso2: string;
  daysOfCover?: number;
  netExporter?: boolean;
  belowObligation?: boolean;
}

interface RegionStatsRaw {
  avgDays?: number;
  minDays?: number;
  countBelowObligation?: number;
}

interface IeaRaw {
  dataMonth?: string;
  ieaMembers?: IeaMemberRaw[];
  regionalSummary?: {
    europe?: RegionStatsRaw;
    asiaPacific?: RegionStatsRaw;
    northAmerica?: RegionStatsRaw;
  };
}

interface RefineryRaw {
  latestPeriod?: string;
  inputsMbblpd?: number;
}

export async function getOilInventories(
  _ctx: ServerContext,
  _req: GetOilInventoriesRequest,
): Promise<GetOilInventoriesResponse> {
  try {
    const [crudeRaw, sprRaw, natGasRaw, euGasRaw, ieaRaw, refineryRaw] = await Promise.all([
      getCachedJson(CRUDE_KEY, true) as Promise<CrudeRaw | null>,
      getCachedJson(SPR_KEY, true) as Promise<SprRaw | null>,
      getCachedJson(NAT_GAS_KEY, true) as Promise<NatGasRaw | null>,
      getCachedJson(EU_GAS_KEY, true) as Promise<EuGasRaw | null>,
      getCachedJson(IEA_KEY, true) as Promise<IeaRaw | null>,
      getCachedJson(REFINERY_KEY, true) as Promise<RefineryRaw | null>,
    ]);

    const crudeWeeks = crudeRaw?.weeks?.map((w) => ({
      period: w.period,
      stocksMb: w.stocksMb,
      weeklyChangeMb: w.weeklyChangeMb,
    })) ?? [];

    const spr = sprRaw
      ? {
          latestStocksMb: sprRaw.barrels ?? 0,
          changeWow: sprRaw.changeWoW ?? 0,
          weeks: sprRaw.weeks?.map((w) => ({
            period: w.period,
            stocksMb: w.barrels,
          })) ?? [],
        }
      : undefined;

    const natGasWeeks = natGasRaw?.weeks?.map((w) => ({
      period: w.period,
      storBcf: w.storBcf,
      weeklyChangeBcf: w.weeklyChangeBcf,
    })) ?? [];

    const euGas = euGasRaw
      ? {
          fillPct: euGasRaw.fillPct ?? 0,
          fillPctChange1d: euGasRaw.fillPctChange1d ?? 0,
          trend: euGasRaw.trend ?? '',
          history: euGasRaw.history?.map((d) => ({
            date: d.date,
            fillPct: d.fillPct,
          })) ?? [],
        }
      : undefined;

    const mapRegion = (r?: RegionStatsRaw) =>
      r ? { avgDays: r.avgDays, minDays: r.minDays, countBelowObligation: r.countBelowObligation } : undefined;

    const ieaStocks = ieaRaw
      ? {
          dataMonth: ieaRaw.dataMonth ?? '',
          members: ieaRaw.ieaMembers?.map((m) => ({
            iso2: m.iso2,
            daysOfCover: m.daysOfCover,
            netExporter: m.netExporter ?? false,
            belowObligation: m.belowObligation ?? false,
          })) ?? [],
          europe: mapRegion(ieaRaw.regionalSummary?.europe),
          asiaPacific: mapRegion(ieaRaw.regionalSummary?.asiaPacific),
          northAmerica: mapRegion(ieaRaw.regionalSummary?.northAmerica),
        }
      : undefined;

    const refinery = refineryRaw?.inputsMbblpd != null
      ? { inputsMbpd: refineryRaw.inputsMbblpd, period: refineryRaw.latestPeriod ?? '' }
      : undefined;

    const updatedAt = new Date().toISOString();

    return {
      crudeWeeks,
      spr,
      natGasWeeks,
      euGas,
      ieaStocks,
      refinery,
      updatedAt,
    } as GetOilInventoriesResponse;
  } catch (err) {
    console.error('[getOilInventories] Redis read failed:', err);
    return { crudeWeeks: [], natGasWeeks: [], updatedAt: '' } as GetOilInventoriesResponse;
  }
}
