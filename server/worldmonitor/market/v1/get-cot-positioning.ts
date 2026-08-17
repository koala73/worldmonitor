import type {
  ServerContext,
  GetCotPositioningRequest,
  GetCotPositioningResponse,
  CotInstrument,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:cot:v1';

interface RawInstrument {
  name: string;
  code: string;
  reportDate: string;
  assetManagerLong: number;
  assetManagerShort: number;
  leveragedFundsLong: number;
  leveragedFundsShort: number;
  smallTraderLong: number;
  smallTraderShort: number;
  smallTraderAvailable?: boolean;
  dealerLong: number;
  dealerShort: number;
  netPct: number;
}

interface CotCachePayload {
  instruments?: RawInstrument[];
  reportDate?: string;
}

export function mapCotPositioning(raw: CotCachePayload | null): GetCotPositioningResponse {
  if (!raw?.instruments || raw.instruments.length === 0) {
    return { instruments: [], reportDate: '', unavailable: true };
  }

  const instruments: CotInstrument[] = raw.instruments.map(item => ({
    name: String(item.name ?? ''),
    code: String(item.code ?? ''),
    reportDate: String(item.reportDate ?? ''),
    assetManagerLong: String(item.assetManagerLong ?? 0),
    assetManagerShort: String(item.assetManagerShort ?? 0),
    leveragedFundsLong: String(item.leveragedFundsLong ?? 0),
    leveragedFundsShort: String(item.leveragedFundsShort ?? 0),
    smallTraderLong: String(item.smallTraderLong ?? 0),
    smallTraderShort: String(item.smallTraderShort ?? 0),
    smallTraderAvailable: item.smallTraderAvailable === true,
    dealerLong: String(item.dealerLong ?? 0),
    dealerShort: String(item.dealerShort ?? 0),
    netPct: Number(item.netPct ?? 0),
  }));

  return {
    instruments,
    reportDate: String(raw.reportDate ?? ''),
    unavailable: false,
  };
}

export async function getCotPositioning(
  _ctx: ServerContext,
  _req: GetCotPositioningRequest,
): Promise<GetCotPositioningResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as CotCachePayload | null;
    return mapCotPositioning(raw);
  } catch {
    return { instruments: [], reportDate: '', unavailable: true };
  }
}
