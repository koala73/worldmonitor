import { XMLParser } from 'fast-xml-parser';

import type { StockAnalysisHeadline } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS } from './_shared';

export type StockNewsSearchProviderId = 'exa' | 'brave' | 'serpapi' | 'google-news-rss';

type StockNewsSearchResult = {
  provider: StockNewsSearchProviderId;
  headlines: StockAnalysisHeadline[];
};

type SearchProviderDefinition = {
  id: Exclude<StockNewsSearchProviderId, 'google-news-rss'>;
  envKey: 'EXA_API_KEYS' | 'BRAVE_API_KEYS' | 'SERPAPI_API_KEYS';
  search: (query: string, maxResults: number, days: number, apiKey: string) => Promise<StockAnalysisHeadline[]>;
};

type ProviderRotationState = {
  cursor: number;
  errors: Map<string, number>;
  signature: string;
};

const SEARCH_CACHE_TTL_SECONDS = 1_200;
const PROVIDER_ERROR_THRESHOLD = 3;
const SEARCH_XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
});
const providerState = new Map<string, ProviderRotationState>();

export function resetStockNewsSearchStateForTests(): void {
  providerState.clear();
}

function splitApiKeys(raw: string | undefined): string[] {
  return String(raw || '')
    .split(/[\n,]+/)
    .map(key => key.trim())
    .filter(Boolean);
}

function normalizeSymbol(raw: string): string {
  return raw.trim().replace(/\s+/g, '').slice(0, 32).toUpperCase();
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16).padStart(8, '0');
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || 'Unknown source';
  } catch {
    return 'Unknown source';
  }
}

function parsePublishedAt(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeDateToTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const raw = value.trim().toLowerCase();
  const absolute = Date.parse(raw);
  if (Number.isFinite(absolute)) return absolute;

  const match = raw.match(/^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months)\s+ago$/);
  if (!match) return 0;

  const amount = Number(match[1] || 0);
  const unit = match[2] || '';
  const now = Date.now();
  const unitMs =
    unit.startsWith('minute') ? 60_000 :
      unit.startsWith('hour') ? 3_600_000 :
        unit.startsWith('day') ? 86_400_000 :
          unit.startsWith('week') ? 7 * 86_400_000 :
            30 * 86_400_000;
  return now - (amount * unitMs);
}

function dedupeHeadlines(headlines: StockAnalysisHeadline[], maxResults: number): StockAnalysisHeadline[] {
  const seen = new Set<string>();
  const normalized = headlines
    .filter(item => item.title.trim() && item.link.trim())
    .filter((item) => {
      const key = `${item.link.trim().toLowerCase()}|${item.title.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return normalized.slice(0, maxResults);
}

function getSearchDays(now = new Date()): number {
  const weekday = now.getDay();
  if (weekday === 1) return 3;
  if (weekday === 0 || weekday === 6) return 2;
  return 1;
}

export function buildStockNewsSearchQuery(symbol: string, name: string): string {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedName = name.trim();
  return normalizedName
    ? `${normalizedName} ${normalizedSymbol} stock latest news`
    : `${normalizedSymbol} stock latest news`;
}

function getProviderCandidates(provider: SearchProviderDefinition): string[] {
  const keys = splitApiKeys(process.env[provider.envKey]);
  if (keys.length === 0) return [];

  const signature = keys.join('|');
  let state = providerState.get(provider.id);
  if (!state || state.signature !== signature) {
    state = { cursor: 0, errors: new Map<string, number>(), signature };
    providerState.set(provider.id, state);
  }

  const ordered: string[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const candidate = keys[(state.cursor + i) % keys.length]!;
    if ((state.errors.get(candidate) || 0) < PROVIDER_ERROR_THRESHOLD) {
      ordered.push(candidate);
    }
  }

  if (ordered.length > 0) {
    state.cursor = (state.cursor + 1) % keys.length;
    return ordered;
  }

  state.errors = new Map<string, number>();
  state.cursor = (state.cursor + 1) % keys.length;
  return [...keys];
}

function recordProviderSuccess(providerId: string, apiKey: string): void {
  const state = providerState.get(providerId);
  if (!state) return;
  const errors = state.errors.get(apiKey) || 0;
  if (errors > 0) state.errors.set(apiKey, errors - 1);
}

function recordProviderError(providerId: string, apiKey: string): void {
  const state = providerState.get(providerId);
  if (!state) return;
  state.errors.set(apiKey, (state.errors.get(apiKey) || 0) + 1);
}

async function searchWithExa(query: string, maxResults: number, days: number, apiKey: string): Promise<StockAnalysisHeadline[]> {
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString();
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'User-Agent': CHROME_UA,
    },
    body: JSON.stringify({
      query,
      numResults: Math.min(maxResults, 10),
      type: 'neural',
      useAutoprompt: false,
      startPublishedDate: startDate,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Exa HTTP ${response.status}`);
  }

  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; publishedDate?: string; author?: string }>;
  };
  return dedupeHeadlines(
    (payload.results || []).map(item => ({
      title: String(item.title || '').trim(),
      source: extractDomain(String(item.url || '')),
      link: String(item.url || '').trim(),
      publishedAt: parsePublishedAt(item.publishedDate),
    })),
    maxResults,
  );
}

async function searchWithBrave(query: string, maxResults: number, days: number, apiKey: string): Promise<StockAnalysisHeadline[]> {
  const freshness = days <= 1 ? 'pd' : days <= 7 ? 'pw' : days <= 30 ? 'pm' : 'py';
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults, 10)));
  url.searchParams.set('freshness', freshness);
  url.searchParams.set('search_lang', 'en');
  url.searchParams.set('country', 'US');
  url.searchParams.set('safesearch', 'moderate');

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Brave HTTP ${response.status}`);
  }

  const payload = await response.json() as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string; meta_url?: { hostname?: string } }>;
    };
  };
  return dedupeHeadlines(
    (payload.web?.results || []).map(item => ({
      title: String(item.title || '').trim(),
      source: String(item.meta_url?.hostname || '').replace(/^www\./, '') || extractDomain(String(item.url || '')),
      link: String(item.url || '').trim(),
      publishedAt: relativeDateToTimestamp(item.age || item.page_age),
    })),
    maxResults,
  );
}

async function searchWithSerpApi(query: string, maxResults: number, days: number, apiKey: string): Promise<StockAnalysisHeadline[]> {
  const response = await fetch(`https://serpapi.com/search.json?${new URLSearchParams({
    engine: 'google_news',
    q: query,
    api_key: apiKey,
    gl: 'us',
    hl: 'en',
    tbs: days <= 1 ? 'qdr:d' : days <= 7 ? 'qdr:w' : '',
    no_cache: 'false',
  }).toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`SerpAPI HTTP ${response.status}`);
  }

  const payload = await response.json() as {
    news_results?: Array<{ title?: string; link?: string; source?: string; date?: string }>;
    organic_results?: Array<{ title?: string; link?: string; source?: string; date?: string }>;
  };
  const rawResults = (payload.news_results?.length ? payload.news_results : payload.organic_results) || [];
  const maxAgeMs = days * 86_400_000;
  return dedupeHeadlines(
    rawResults
      .map(item => ({
        title: String(item.title || '').trim(),
        source: String(item.source || '').trim() || extractDomain(String(item.link || '')),
        link: String(item.link || '').trim(),
        publishedAt: relativeDateToTimestamp(item.date),
      }))
      .filter(item => !item.publishedAt || (Date.now() - item.publishedAt) <= maxAgeMs),
    maxResults,
  );
}

async function searchViaProviders(query: string, maxResults: number, days: number): Promise<StockNewsSearchResult | null> {
  const providers: SearchProviderDefinition[] = [
    { id: 'exa', envKey: 'EXA_API_KEYS', search: searchWithExa },
    { id: 'brave', envKey: 'BRAVE_API_KEYS', search: searchWithBrave },
    { id: 'serpapi', envKey: 'SERPAPI_API_KEYS', search: searchWithSerpApi },
  ];

  for (const provider of providers) {
    const candidates = getProviderCandidates(provider);
    for (const apiKey of candidates) {
      try {
        const headlines = await provider.search(query, maxResults, days, apiKey);
        recordProviderSuccess(provider.id, apiKey);
        if (headlines.length > 0) {
          return { provider: provider.id, headlines };
        }
        break;
      } catch (error) {
        recordProviderError(provider.id, apiKey);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[stock-news-search] ${provider.id} failed: ${message}`);
      }
    }
  }

  return null;
}

async function fetchGoogleNewsRss(query: string, maxResults: number): Promise<StockAnalysisHeadline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    const parsed = SEARCH_XML.parse(xml) as {
      rss?: { channel?: { item?: Array<Record<string, unknown>> | Record<string, unknown> } };
    };
    const items = Array.isArray(parsed.rss?.channel?.item)
      ? parsed.rss?.channel?.item
      : parsed.rss?.channel?.item ? [parsed.rss.channel.item] : [];

    return dedupeHeadlines(
      items.map((item) => {
        const source = typeof item.source === 'string'
          ? item.source
          : typeof (item.source as Record<string, unknown> | undefined)?.['#text'] === 'string'
            ? String((item.source as Record<string, unknown>)['#text'])
            : '';
        return {
          title: String(item.title || '').trim(),
          source: source || 'Google News',
          link: String(item.link || '').trim(),
          publishedAt: parsePublishedAt(item.pubDate),
        };
      }),
      maxResults,
    );
  } catch {
    return [];
  }
}

export async function searchRecentStockHeadlines(symbol: string, name: string, maxResults = 5): Promise<StockNewsSearchResult> {
  const query = buildStockNewsSearchQuery(symbol, name);
  const days = getSearchDays();
  const symbolKey = normalizeSymbol(symbol) || 'UNKNOWN';
  const queryHash = stableHash(query).slice(0, 12);
  const cacheKey = `market:stock-news-search:v1:${symbolKey}:${days}:${maxResults}:${queryHash}`;

  const cached = await cachedFetchJson<StockNewsSearchResult>(cacheKey, SEARCH_CACHE_TTL_SECONDS, async () => {
    const providerResult = await searchViaProviders(query, maxResults, days);
    if (providerResult?.headlines.length) return providerResult;
    return {
      provider: 'google-news-rss',
      headlines: await fetchGoogleNewsRss(query, maxResults),
    };
  }, 180);

  return cached || { provider: 'google-news-rss', headlines: [] };
}
