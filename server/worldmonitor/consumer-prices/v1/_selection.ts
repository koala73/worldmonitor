import { ValidationError } from '../../../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

const MARKETS = new Set(['ae', 'sa', 'ch', 'sg', 'us', 'gb', 'br', 'in', 'au', 'ke']);

export function resolveConsumerPriceSelection(marketCode = '', basketSlug = ''): { market: string; basket: string } {
  if (marketCode.length > 2) {
    throw new ValidationError([{ field: 'marketCode', description: 'Expected a supported two-letter market code' }]);
  }
  const market = marketCode.toLowerCase() || 'ae';
  if (!MARKETS.has(market)) {
    throw new ValidationError([{ field: 'marketCode', description: 'Expected a supported two-letter market code' }]);
  }
  if (basketSlug.length > 13) {
    throw new ValidationError([{ field: 'basketSlug', description: 'Expected the essentials basket for the selected market' }]);
  }
  const basket = basketSlug.toLowerCase() || `essentials-${market}`;
  if (basket !== `essentials-${market}`) {
    throw new ValidationError([{ field: 'basketSlug', description: 'Expected the essentials basket for the selected market' }]);
  }
  return { market, basket };
}
