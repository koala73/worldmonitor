import type {
  ServerContext,
  SearchGdeltDocumentsRequest,
  SearchGdeltDocumentsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEEDED_KEY = 'intelligence:gdelt-intel:v1';

// All GDELT fetching happens in the Railway seed script
// (scripts/seed-gdelt-intel.mjs). This handler reads pre-seeded
// topic data from Redis only (gold standard: Vercel reads, Railway writes).

type SeededGdeltData = {
  topics?: Array<{
    id: string;
    articles: Array<{
      title: string;
      url: string;
      source: string;
      date: string;
      image: string;
      language: string;
      tone: number;
    }>;
  }>;
};

export async function searchGdeltDocuments(
  _ctx: ServerContext,
  req: SearchGdeltDocumentsRequest,
): Promise<SearchGdeltDocumentsResponse> {
  if (!req.query || req.query.length < 2) {
    return { articles: [], query: req.query || '', error: 'Query parameter required' };
  }

  try {
    const seeded = await getCachedJson(SEEDED_KEY, true) as SeededGdeltData | null;
    if (!seeded?.topics?.length) {
      return { articles: [], query: req.query, error: '' };
    }

    const queryLower = req.query.toLowerCase();
    const match = seeded.topics.find(t =>
      queryLower.includes(t.id) || t.articles.some(a => a.title.toLowerCase().includes(queryLower.slice(0, 20)))
    );

    if (!match) {
      return { articles: [], query: req.query, error: '' };
    }

    const maxRecords = Math.min(req.maxRecords > 0 ? req.maxRecords : 10, 20);
    return {
      articles: match.articles.slice(0, maxRecords),
      query: req.query,
      error: '',
    };
  } catch {
    return { articles: [], query: req.query, error: '' };
  }
}
