/**
 * ListPredictionMarkets RPC -- reads Railway-seeded prediction market data
 * from Redis. All external API calls (Polymarket Gamma, Kalshi) happen on
 * Railway seed scripts, never on Vercel.
 */

import {
  type MarketSource,
  type PredictionServiceHandler,
  type ServerContext,
  type ListPredictionMarketsRequest,
  type ListPredictionMarketsResponse,
  type PredictionMarket,
} from '../../../../src/generated/server/worldmonitor/prediction/v1/service_server';

import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'prediction:markets-bootstrap:v1';

const TECH_CATEGORY_TAGS = ['ai', 'tech', 'crypto', 'science'];
const FINANCE_CATEGORY_TAGS = ['economy', 'fed', 'inflation', 'interest-rates', 'recession', 'trade', 'tariffs', 'debt-ceiling'];

interface BootstrapMarket {
  title: string;
  yesPrice: number;
  volume: number;
  url: string;
  endDate?: string;
  source?: 'kalshi' | 'polymarket';
}

interface BootstrapData {
  geopolitical?: BootstrapMarket[];
  tech?: BootstrapMarket[];
  finance?: BootstrapMarket[];
}

function toProtoMarket(m: BootstrapMarket, category: string): PredictionMarket {
  return {
    id: m.url?.split('/').pop() || '',
    title: m.title,
    yesPrice: (m.yesPrice ?? 50) / 100,
    volume: m.volume ?? 0,
    url: m.url || '',
    closesAt: m.endDate ? Date.parse(m.endDate) : 0,
    category,
    source: m.source === 'kalshi' ? 'MARKET_SOURCE_KALSHI' as MarketSource : 'MARKET_SOURCE_POLYMARKET' as MarketSource,
  };
}

export const listPredictionMarkets: PredictionServiceHandler['listPredictionMarkets'] = async (
  _ctx: ServerContext,
  req: ListPredictionMarketsRequest,
): Promise<ListPredictionMarketsResponse> => {
  try {
    const category = (req.category || '').slice(0, 50);
    const query = (req.query || '').slice(0, 100);
    const limit = clampInt(req.pageSize, 50, 1, 100);

    const bootstrap = await getCachedJson(BOOTSTRAP_KEY) as BootstrapData | null;
    if (!bootstrap) return { markets: [], pagination: undefined };

    const isTech = category && TECH_CATEGORY_TAGS.includes(category);
    const isFinance = !isTech && category && FINANCE_CATEGORY_TAGS.includes(category);
    const variant = isTech ? bootstrap.tech
      : isFinance ? (bootstrap.finance ?? bootstrap.geopolitical)
      : bootstrap.geopolitical;

    if (!variant || variant.length === 0) return { markets: [], pagination: undefined };

    let markets = variant.map((m) => toProtoMarket(m, category));

    if (query) {
      const q = query.toLowerCase();
      markets = markets.filter((m) => m.title.toLowerCase().includes(q));
    }

    return { markets: markets.slice(0, limit), pagination: undefined };
  } catch {
    return { markets: [], pagination: undefined };
  }
};
