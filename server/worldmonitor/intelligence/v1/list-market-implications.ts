import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListMarketImplicationsRequest,
  ListMarketImplicationsResponse,
  MarketImplicationCard,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'intelligence:market-implications:v1';

interface CachedMarketImplication {
  ticker?: string;
  name?: string;
  direction?: string;
  timeframe?: string;
  confidence?: string;
  title?: string;
  narrative?: string;
  risk_caveat?: string;
  driver?: string;
}

interface CachedMarketImplicationsData {
  cards?: CachedMarketImplication[];
  generatedAt?: string;
}

function toCard(raw: CachedMarketImplication): MarketImplicationCard {
  return {
    ticker: raw.ticker ?? '',
    name: raw.name ?? '',
    direction: raw.direction ?? '',
    timeframe: raw.timeframe ?? '',
    confidence: raw.confidence ?? '',
    title: raw.title ?? '',
    narrative: raw.narrative ?? '',
    riskCaveat: raw.risk_caveat ?? '',
    driver: raw.driver ?? '',
  };
}

export const listMarketImplications: IntelligenceServiceHandler['listMarketImplications'] = async (
  _ctx: ServerContext,
  _req: ListMarketImplicationsRequest,
): Promise<ListMarketImplicationsResponse> => {
  const data = (await getCachedJson(REDIS_KEY, true).catch(() => null)) as CachedMarketImplicationsData | null;

  if (!data || !Array.isArray(data.cards) || data.cards.length === 0) {
    return {
      cards: [],
      degraded: true,
      emptyReason: data ? 'no_cards' : 'data_unavailable',
      generatedAt: '',
    };
  }

  return {
    cards: data.cards.map(toCard),
    degraded: false,
    emptyReason: '',
    generatedAt: data.generatedAt ?? '',
  };
};
