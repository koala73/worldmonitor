import type {
  ServerContext,
  GetHyperliquidFlowRequest,
  GetHyperliquidFlowResponse,
  HyperliquidAssetFlow,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:hyperliquid:flow:v1';

interface SeededAsset {
  symbol?: string;
  display?: string;
  class?: string;
  group?: string;
  funding?: number | null;
  openInterest?: number | null;
  markPx?: number | null;
  oraclePx?: number | null;
  dayNotional?: number | null;
  fundingScore?: number;
  volumeScore?: number;
  oiScore?: number;
  basisScore?: number;
  composite?: number;
  sparkFunding?: number[];
  sparkOi?: number[];
  sparkScore?: number[];
  warmup?: boolean;
  stale?: boolean;
  staleSince?: number | null;
  missingPolls?: number;
  alerts?: string[];
}

interface SeededSnapshot {
  ts?: number;
  fetchedAt?: string;
  warmup?: boolean;
  assetCount?: number;
  assets?: SeededAsset[];
}

function numToStr(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '' : String(v);
}

function arr(a: number[] | undefined): number[] {
  return Array.isArray(a) ? a.filter((v) => Number.isFinite(v)) : [];
}

export async function getHyperliquidFlow(
  _ctx: ServerContext,
  _req: GetHyperliquidFlowRequest,
): Promise<GetHyperliquidFlowResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as SeededSnapshot | null;
    if (!raw?.assets || raw.assets.length === 0) {
      // No error — seeder hasn't run yet, or empty snapshot. Distinguish from
      // parse/Redis failures below (those hit the catch and log).
      return {
        ts: '0',
        fetchedAt: '',
        warmup: true,
        assetCount: 0,
        assets: [],
        unavailable: true,
      };
    }
    const assets: HyperliquidAssetFlow[] = raw.assets.map((a) => ({
      symbol: String(a.symbol ?? ''),
      display: String(a.display ?? ''),
      assetClass: String(a.class ?? ''),
      group: String(a.group ?? ''),
      funding: numToStr(a.funding ?? null),
      openInterest: numToStr(a.openInterest ?? null),
      markPx: numToStr(a.markPx ?? null),
      oraclePx: numToStr(a.oraclePx ?? null),
      dayNotional: numToStr(a.dayNotional ?? null),
      fundingScore: Number(a.fundingScore ?? 0),
      volumeScore: Number(a.volumeScore ?? 0),
      oiScore: Number(a.oiScore ?? 0),
      basisScore: Number(a.basisScore ?? 0),
      composite: Number(a.composite ?? 0),
      sparkFunding: arr(a.sparkFunding),
      sparkOi: arr(a.sparkOi),
      sparkScore: arr(a.sparkScore),
      warmup: Boolean(a.warmup),
      stale: Boolean(a.stale),
      staleSince: String(a.staleSince ?? 0),
      missingPolls: Number(a.missingPolls ?? 0),
      alerts: Array.isArray(a.alerts) ? a.alerts.map((x) => String(x)) : [],
    }));
    return {
      ts: String(raw.ts ?? 0),
      fetchedAt: String(raw.fetchedAt ?? ''),
      warmup: Boolean(raw.warmup),
      assetCount: assets.length,
      assets,
      unavailable: false,
    };
  } catch (err) {
    console.error('[getHyperliquidFlow] Redis read or parse failed:', err instanceof Error ? err.message : err);
    return {
      ts: '0',
      fetchedAt: '',
      warmup: true,
      assetCount: 0,
      assets: [],
      unavailable: true,
    };
  }
}
