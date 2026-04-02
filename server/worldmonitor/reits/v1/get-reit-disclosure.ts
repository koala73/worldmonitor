/**
 * RPC: GetReitDisclosure -- reads C-REIT disclosure data from Redis.
 * Data: NAV, dividends, premium/discount, distribution yield, trading metrics.
 *
 * Data flow:
 *   fetch-reit-disclosure.py (akshare) → seed-reit-disclosure.mjs → Redis reits:disclosure:v1 → this handler
 */

import type {
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/reits/v1/service_server';
import { REDIS_KEYS } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

interface ReitDividend {
  year: string;
  recordDate: string;
  exDate: string;
  amount: number;
  description: string;
  payDate: string;
}

interface ReitDisclosure {
  code: string;
  symbol: string;
  name: string;
  nav?: number;
  navDate?: string;
  cumulativeNav?: number;
  premiumDiscount?: number;
  totalDistributed?: number;
  distributionYield?: number;
  dividends?: ReitDividend[];
  price?: number;
  change?: number;
  volume?: number;
  turnover?: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  error?: string;
}

interface DisclosureData {
  disclosures: ReitDisclosure[];
  source: string;
  lastUpdated: string;
}

export async function getReitDisclosure(
  _ctx: ServerContext,
  req: { reitSymbol?: string },
): Promise<{ disclosures: ReitDisclosure[]; source: string; lastUpdated: string }> {
  try {
    const data = await getCachedJson(REDIS_KEYS.disclosure, true) as DisclosureData | null;

    if (!data) {
      return { disclosures: [], source: '', lastUpdated: '' };
    }

    let disclosures = data.disclosures || [];

    if (req.reitSymbol) {
      disclosures = disclosures.filter((d) => d.symbol === req.reitSymbol);
    }

    return {
      disclosures,
      source: data.source || 'akshare/eastmoney',
      lastUpdated: data.lastUpdated || '',
    };
  } catch {
    return { disclosures: [], source: '', lastUpdated: '' };
  }
}
