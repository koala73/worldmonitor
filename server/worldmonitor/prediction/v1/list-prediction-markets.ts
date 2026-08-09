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

import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';
import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'prediction:markets-bootstrap:v1';

const TECH_CATEGORY_TAGS = filterParamContracts.predictionMarketTechCategories;
const FINANCE_CATEGORY_TAGS = filterParamContracts.predictionMarketFinanceCategories;

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
  fetchedAt?: number;
}

const DEGENERATE_MARKET_SLUGS = new Set(['undefined', 'null', 'nan', '']);

function bootstrapMarketIdentity(market: BootstrapMarket): string {
  const url = String(market?.url ?? '').trim();
  if (url) {
    const path = url.split(/[?#]/)[0] ?? '';
    const slug = path.replace(/\/+$/, '').split('/').pop() ?? '';
    if (!DEGENERATE_MARKET_SLUGS.has(slug.toLowerCase())) return `url:${url}`;
  }
  return `title:${String(market?.title ?? '').trim().toLowerCase()}`;
}

function dedupeBootstrapMarkets(markets: BootstrapMarket[]): BootstrapMarket[] {
  const best = new Map<string, BootstrapMarket>();
  for (const market of markets) {
    const identity = bootstrapMarketIdentity(market);
    const incumbent = best.get(identity);
    if (!incumbent) {
      best.set(identity, market);
      continue;
    }
    const incumbentVolume = Number(incumbent.volume);
    const challengerVolume = Number(market.volume);
    const incumbentRank = Number.isFinite(incumbentVolume) ? incumbentVolume : -Infinity;
    const challengerRank = Number.isFinite(challengerVolume) ? challengerVolume : -Infinity;
    if (challengerRank > incumbentRank) best.set(identity, market);
  }
  return [...best.values()];
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
    if (!bootstrap) return { markets: [], pagination: undefined, fetchedAt: 0, dataAvailable: false };

    const fetchedAt = Number(bootstrap.fetchedAt ?? 0);

    const isTech = category && TECH_CATEGORY_TAGS.includes(category);
    const isFinance = !isTech && category && FINANCE_CATEGORY_TAGS.includes(category);
    // `category` is optional on this public endpoint, and omitting it must keep
    // meaning "every market" (#5733). Before the producer's pools were made
    // disjoint, `bootstrap.geopolitical` WAS every market, so the no-category
    // caller and an explicit geopolitical-ish category (the site variant sends
    // 'politics') could share one branch. Now they must not: the pool is
    // strictly geopolitical, so an empty category has to union all three or the
    // documented default response silently narrows to geo-only.
    //
    // The union is DEDUPED, not just concatenated: for up to the seeder's cron
    // interval after this ships, Redis still holds a pre-#5733 payload whose
    // pools are near-duplicates, and a naive concat would answer the default
    // request with the same market three times. Deduping keeps the response
    // correct for either payload vintage. Volume-sorted so it stays ranked
    // rather than ordered pool-by-pool.
    const unionAllPools = () => {
      return dedupeBootstrapMarkets([
        ...(bootstrap.geopolitical ?? []),
        ...(bootstrap.tech ?? []),
        ...(bootstrap.finance ?? []),
      ]).sort((a, b) => (Number(b?.volume) || 0) - (Number(a?.volume) || 0));
    };

    // A finance request must NOT fall back to the geopolitical pool. That was
    // harmless while geopolitical was a superset of every market; now it would
    // answer "give me finance" with conflict and election markets.
    const variant = isTech ? bootstrap.tech
      : isFinance ? bootstrap.finance
      : category ? bootstrap.geopolitical
      : unionAllPools();

    if (!variant || variant.length === 0) return { markets: [], pagination: undefined, fetchedAt, dataAvailable: false };

    let markets = variant.map((m) => toProtoMarket(m, category));

    if (query) {
      const q = query.toLowerCase();
      markets = markets.filter((m) => m.title.toLowerCase().includes(q));
    }

    return { markets: markets.slice(0, limit), pagination: undefined, fetchedAt, dataAvailable: true };
  } catch {
    return { markets: [], pagination: undefined, fetchedAt: 0, dataAvailable: false };
  }
};
