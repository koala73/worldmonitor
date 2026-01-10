export * from './feeds';
export * from './markets';
export * from './geo';
export * from './panels';
export * from './irradiators';
export * from './pipelines';
export * from './ai-datacenters';
export * from './protests';

export const API_URLS = {
  yahooFinance: (symbol: string) =>
    `/api/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}`,
  coingecko:
    '/api/coingecko/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
  polymarket: '/api/polymarket/events?closed=false&limit=20',
  earthquakes: '/api/earthquake/earthquakes/feed/v1.0/summary/4.5_day.geojson',
};

export const REFRESH_INTERVALS = {
  feeds: 5 * 60 * 1000,    // 5 minutes
  markets: 60 * 1000,       // 1 minute
  crypto: 60 * 1000,        // 1 minute
  predictions: 5 * 60 * 1000, // 5 minutes
};
