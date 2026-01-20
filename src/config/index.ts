export * from './feeds';
export * from './markets';
export * from './geo';
export * from './panels';
export * from './irradiators';
export * from './pipelines';
export * from './ai-datacenters';
export * from './ports';
export * from './tech-companies';
export * from './ai-research-labs';
export * from './startup-ecosystems';

export const API_URLS = {
  finnhub: (symbols: string[]) =>
    `/api/finnhub?symbols=${symbols.map(s => encodeURIComponent(s)).join(',')}`,
  yahooFinance: (symbol: string) =>
    `/api/yahoo-finance?symbol=${encodeURIComponent(symbol)}`,
  coingecko:
    '/api/coingecko?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
  polymarket: '/api/polymarket?closed=false&order=volume&ascending=false&limit=100',
  earthquakes: '/api/earthquakes',
  arxiv: (category: string = 'cs.AI', maxResults: number = 50) =>
    `/api/arxiv?category=${encodeURIComponent(category)}&max_results=${maxResults}`,
  githubTrending: (language: string = 'python', since: string = 'daily') =>
    `/api/github-trending?language=${encodeURIComponent(language)}&since=${since}`,
  hackernews: (type: string = 'top', limit: number = 30) =>
    `/api/hackernews?type=${type}&limit=${limit}`,
};

export const REFRESH_INTERVALS = {
  feeds: 5 * 60 * 1000,    // 5 minutes
  markets: 60 * 1000,       // 1 minute
  crypto: 60 * 1000,        // 1 minute
  predictions: 5 * 60 * 1000, // 5 minutes
  ais: 10 * 60 * 1000, // 10 minutes
  arxiv: 60 * 60 * 1000, // 1 hour
  githubTrending: 30 * 60 * 1000, // 30 minutes
  hackernews: 5 * 60 * 1000, // 5 minutes
};
