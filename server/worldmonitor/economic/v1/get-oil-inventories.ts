import type {
  ServerContext,
  GetOilInventoriesRequest,
  GetOilInventoriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { logCacheReadError, readCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
// @ts-expect-error -- JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';

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
  ctx: ServerContext,
  _req: GetOilInventoriesRequest,
): Promise<GetOilInventoriesResponse> {
  try {
    // Status-aware reads: a transient Redis error on one key must not look
    // like "that section does not exist". Any error marks the whole response
    // no-store, even when the other keys hit — otherwise the gateway's
    // slow-tier cache (browser 300s, CDN 3600s) would persist the partial body.
    const reads = await Promise.all([
      readCachedJson(CRUDE_KEY, true),
      readCachedJson(SPR_KEY, true),
      readCachedJson(NAT_GAS_KEY, true),
      readCachedJson(EU_GAS_KEY, true),
      readCachedJson(IEA_KEY, true),
      readCachedJson(REFINERY_KEY, true),
    ]);
    const keys = [CRUDE_KEY, SPR_KEY, NAT_GAS_KEY, EU_GAS_KEY, IEA_KEY, REFINERY_KEY];
    let readErrored = false;
    for (let i = 0; i < reads.length; i++) {
      const read = reads[i]!;
      if (read.status === 'error') {
        readErrored = true;
        logCacheReadError(keys[i]!, read.error);
      }
    }
    const value = (index: number) => {
      const read = reads[index]!;
      return read.status === 'hit' ? read.value : null;
    };
    const crudeRaw = value(0) as CrudeRaw | null;
    const sprRaw = value(1) as SprRaw | null;
    const natGasRaw = value(2) as NatGasRaw | null;
    const euGasRaw = value(3) as EuGasRaw | null;
    const ieaRaw = value(4) as IeaRaw | null;
    const refineryRaw = value(5) as RefineryRaw | null;

    if (!crudeRaw && !sprRaw && !natGasRaw && !euGasRaw && !ieaRaw && !refineryRaw) {
      return markNoStoreFallbackResponse(ctx.request, { crudeWeeks: [], natGasWeeks: [], updatedAt: '' });
    }

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

    const response = {
      crudeWeeks,
      spr,
      natGasWeeks,
      euGas,
      ieaStocks,
      refinery,
      updatedAt,
    } as GetOilInventoriesResponse;
    // A partial snapshot built over a failed read is not cacheable: the
    // absent section is unknown, not empty. Only a fully-confirmed read
    // (every absent key a genuine miss) may carry a fresh timestamp — so blank
    // `updatedAt` alongside the no-store marking, matching the two sibling
    // failure branches in this function. The header alone is not enough: it
    // stops HTTP caches but never reaches the caller's rendered body, so a
    // client (or an agent) reading `spr: undefined` beside an as-of-now stamp
    // cannot tell "no SPR data this week" from "the SPR read just failed".
    if (readErrored) {
      return markNoStoreFallbackResponse(ctx.request, { ...response, updatedAt: '' });
    }
    return response;
  } catch (err) {
    console.error('[getOilInventories] Redis read failed:', err);
    captureSilentError(err, { tags: { handler: 'getOilInventories' } });
    return markNoStoreFallbackResponse(ctx.request, { crudeWeeks: [], natGasWeeks: [], updatedAt: '' });
  }
}
