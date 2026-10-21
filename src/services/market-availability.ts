export const FINNHUB_CONFIG_MESSAGE = 'FINNHUB_API_KEY not configured — add in Settings';

const MARKET_RATE_LIMIT_MESSAGE = 'Market data temporarily unavailable (rate limited) — retrying shortly';

interface StockMarketAvailabilityInput {
  stockCount: number;
  finnhubSkipped?: boolean;
  rateLimited?: boolean;
}

export interface StockMarketAvailability {
  finnhubStatus: 'ok' | 'error' | null;
  marketsConfigError: string | null;
  rateLimitError: string | null;
  skipCommodityFetch: boolean;
}

export function resolveStockMarketAvailability({
  stockCount,
  finnhubSkipped,
  rateLimited,
}: StockMarketAvailabilityInput): StockMarketAvailability {
  const hasUsableData = stockCount > 0;
  const blockedByRateLimit = Boolean(rateLimited && !hasUsableData);

  return {
    finnhubStatus: blockedByRateLimit ? null : finnhubSkipped ? 'error' : 'ok',
    marketsConfigError: finnhubSkipped && !hasUsableData && !blockedByRateLimit
      ? FINNHUB_CONFIG_MESSAGE
      : null,
    rateLimitError: blockedByRateLimit ? MARKET_RATE_LIMIT_MESSAGE : null,
    skipCommodityFetch: blockedByRateLimit,
  };
}

interface SectorHeatmapAvailabilityInput {
  sectorCount: number;
  finnhubSkipped?: boolean;
}

export function resolveSectorHeatmapAvailability({
  sectorCount,
  finnhubSkipped,
}: SectorHeatmapAvailabilityInput): { configError: string | null } {
  return {
    configError: finnhubSkipped && sectorCount === 0 ? FINNHUB_CONFIG_MESSAGE : null,
  };
}
