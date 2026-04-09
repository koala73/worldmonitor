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
  dealerLong: number;
  dealerShort: number;
  netPct: number;
}

export async function getCotPositioning(
  _ctx: ServerContext,
  _req: GetCotPositioningRequest,
): Promise<GetCotPositioningResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as { instruments?: RawInstrument[]; reportDate?: string } | null;
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
      dealerLong: String(item.dealerLong ?? 0),
      dealerShort: String(item.dealerShort ?? 0),
      netPct: Number(item.netPct ?? 0),
    }));

    return {
      instruments,
      reportDate: String(raw.reportDate ?? ''),
      unavailable: false,
    };
  } catch {
    return { instruments: [], reportDate: '', unavailable: true };
  }
}
