import type {
  ServerContext,
  SearchGdeltDocumentsRequest,
  SearchGdeltDocumentsResponse,
  GdeltArticle,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'intel:gdelt-docs:v1';
const REDIS_CACHE_TTL = 600; // 10 min

// ========================================================================
// Constants
// ========================================================================

const GDELT_MAX_RECORDS = 20;
const GDELT_DEFAULT_RECORDS = 10;
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';

// ========================================================================
// RPC handler
// ========================================================================

export async function searchGdeltDocuments(
  _ctx: ServerContext,
  req: SearchGdeltDocumentsRequest,
): Promise<SearchGdeltDocumentsResponse> {
  let query = req.query;
  if (!query || query.length < 2) {
    return { articles: [], query: query || '', error: 'Query parameter required (min 2 characters)' };
  }

  // Append tone filter to query if provided (e.g., "tone>5" for positive articles)
  if (req.toneFilter) {
    query = `${query} ${req.toneFilter}`;
  }

  const maxRecords = Math.min(
    req.maxRecords > 0 ? req.maxRecords : GDELT_DEFAULT_RECORDS,
    GDELT_MAX_RECORDS,
  );
  const timespan = req.timespan || '72h';

  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${query}:${timespan}:${maxRecords}`;
    const result = await cachedFetchJson<SearchGdeltDocumentsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const gdeltUrl = new URL(GDELT_DOC_API);
        gdeltUrl.searchParams.set('query', query);
        gdeltUrl.searchParams.set('mode', 'artlist');
        gdeltUrl.searchParams.set('maxrecords', maxRecords.toString());
        gdeltUrl.searchParams.set('format', 'json');
        gdeltUrl.searchParams.set('sort', req.sort || 'date');
        gdeltUrl.searchParams.set('timespan', timespan);

        const response = await fetch(gdeltUrl.toString(), {
          headers: { 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new Error(`GDELT returned ${response.status}`);
        }

        const data = (await response.json()) as {
          articles?: Array<{
            title?: string;
            url?: string;
            domain?: string;
            source?: { domain?: string };
            seendate?: string;
            socialimage?: string;
            language?: string;
            tone?: number;
          }>;
        };

        const articles: GdeltArticle[] = (data.articles || []).map((article) => ({
          title: article.title || '',
          url: article.url || '',
          source: article.domain || article.source?.domain || '',
          date: article.seendate || '',
          image: article.socialimage || '',
          language: article.language || '',
          tone: typeof article.tone === 'number' ? article.tone : 0,
        }));

        if (articles.length === 0) return null;
        return { articles, query, error: '' } as SearchGdeltDocumentsResponse;
      },
    );
    return result || { articles: [], query, error: '' };
  } catch (error) {
    return {
      articles: [],
      query,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
