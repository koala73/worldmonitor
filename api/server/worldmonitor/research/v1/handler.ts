/**
 * Research service handler -- implements the generated ResearchServiceHandler
 * interface with 3 RPCs: arXiv papers, GitHub trending repos, Hacker News items.
 *
 * Each RPC proxies a different upstream API:
 * - arXiv: Atom XML API parsed via fast-xml-parser (ignoreAttributes: false)
 * - GitHub trending: gitterapp JSON API with herokuapp fallback
 * - Hacker News: Firebase JSON API with 2-step fetch (IDs then items)
 *
 * All RPCs return empty arrays on ANY failure (graceful degradation).
 */

import { XMLParser } from 'fast-xml-parser';
import type {
  ResearchServiceHandler,
  ServerContext,
  ListArxivPapersRequest,
  ListArxivPapersResponse,
  ArxivPaper,
  ListTrendingReposRequest,
  ListTrendingReposResponse,
  GithubRepo,
  ListHackernewsItemsRequest,
  ListHackernewsItemsResponse,
  HackernewsItem,
} from '../../../../../src/generated/server/worldmonitor/research/v1/service_server';

// ---------- XML Parser (arXiv) ----------

const xmlParser = new XMLParser({
  ignoreAttributes: false, // CRITICAL: arXiv uses attributes for category term, link href/rel
  attributeNamePrefix: '@_',
  isArray: (_name: string, jpath: string) =>
    /\.(entry|author|category|link)$/.test(jpath),
});

// ---------- Constants ----------

const ALLOWED_HN_FEEDS = new Set(['top', 'new', 'best', 'ask', 'show', 'job']);
const HN_MAX_CONCURRENCY = 10;

// ---------- RPC 1: arXiv ----------

async function fetchArxivPapers(req: ListArxivPapersRequest): Promise<ArxivPaper[]> {
  const category = req.category || 'cs.AI';
  const pageSize = req.pagination?.pageSize || 50;

  let searchQuery: string;
  if (req.query) {
    searchQuery = `all:${req.query}+AND+cat:${category}`;
  } else {
    searchQuery = `cat:${category}`;
  }

  const url = `https://export.arxiv.org/api/query?search_query=${searchQuery}&start=0&max_results=${pageSize}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/xml' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return [];

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);
  const feed = parsed?.feed;
  if (!feed) return [];

  const entries: any[] = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];

  return entries.map((entry: any): ArxivPaper => {
    // Extract ID: last segment after last '/'
    const rawId = String(entry.id || '');
    const id = rawId.split('/').pop() || rawId;

    // Clean title (arXiv titles can have internal newlines)
    const title = (entry.title || '').trim().replace(/\s+/g, ' ');

    // Clean summary
    const summary = (entry.summary || '').trim().replace(/\s+/g, ' ');

    // Authors
    const authors = (entry.author ?? []).map((a: any) => a.name || '');

    // Categories (from attributes)
    const categories = (entry.category ?? []).map((c: any) => c['@_term'] || '');

    // Published time (Unix epoch ms)
    const publishedAt = entry.published ? new Date(entry.published).getTime() : 0;

    // URL: find link with rel="alternate", fallback to entry.id
    const links: any[] = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];
    const alternateLink = links.find((l: any) => l['@_rel'] === 'alternate');
    const url = alternateLink?.['@_href'] || rawId;

    return { id, title, summary, authors, categories, publishedAt, url };
  });
}

// ---------- RPC 2: GitHub Trending ----------

async function fetchTrendingRepos(req: ListTrendingReposRequest): Promise<GithubRepo[]> {
  const language = req.language || 'python';
  const period = req.period || 'daily';
  const pageSize = req.pagination?.pageSize || 50;

  // Primary API
  const primaryUrl = `https://api.gitterapp.com/repositories?language=${language}&since=${period}`;
  let data: any[];

  try {
    const response = await fetch(primaryUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error('Primary API failed');
    data = await response.json() as any[];
  } catch {
    // Fallback API
    try {
      const fallbackUrl = `https://gh-trending-api.herokuapp.com/repositories/${language}?since=${period}`;
      const fallbackResponse = await fetch(fallbackUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!fallbackResponse.ok) return [];
      data = await fallbackResponse.json() as any[];
    } catch {
      return [];
    }
  }

  if (!Array.isArray(data)) return [];

  return data.slice(0, pageSize).map((raw: any): GithubRepo => ({
    fullName: `${raw.author}/${raw.name}`,
    description: raw.description || '',
    language: raw.language || '',
    stars: raw.stars || 0,
    starsToday: raw.currentPeriodStars || 0,
    forks: raw.forks || 0,
    url: raw.url || `https://github.com/${raw.author}/${raw.name}`,
  }));
}

// ---------- RPC 3: Hacker News ----------

async function fetchHackernewsItems(req: ListHackernewsItemsRequest): Promise<HackernewsItem[]> {
  const feedType = ALLOWED_HN_FEEDS.has(req.feedType) ? req.feedType : 'top';
  const pageSize = req.pagination?.pageSize || 30;

  // Step 1: Fetch story IDs
  const idsUrl = `https://hacker-news.firebaseio.com/v0/${feedType}stories.json`;
  const idsResponse = await fetch(idsUrl, {
    signal: AbortSignal.timeout(10000),
  });

  if (!idsResponse.ok) return [];

  const allIds: unknown = await idsResponse.json();
  if (!Array.isArray(allIds)) return [];

  // Step 2: Batch-fetch individual items with bounded concurrency
  const ids = allIds.slice(0, pageSize) as number[];
  const items: HackernewsItem[] = [];

  for (let i = 0; i < ids.length; i += HN_MAX_CONCURRENCY) {
    const batch = ids.slice(i, i + HN_MAX_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id): Promise<HackernewsItem | null> => {
        try {
          const res = await fetch(
            `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!res.ok) return null;
          const raw: any = await res.json();
          if (!raw || raw.type !== 'story') return null;
          return {
            id: raw.id || 0,
            title: raw.title || '',
            url: raw.url || '',
            score: raw.score || 0,
            commentCount: raw.descendants || 0,
            by: raw.by || '',
            submittedAt: (raw.time || 0) * 1000, // HN uses Unix seconds, proto uses ms
          };
        } catch {
          return null;
        }
      }),
    );
    for (const item of results) {
      if (item) items.push(item);
    }
  }

  return items;
}

// ---------- Handler ----------

export const researchHandler: ResearchServiceHandler = {
  async listArxivPapers(
    _ctx: ServerContext,
    req: ListArxivPapersRequest,
  ): Promise<ListArxivPapersResponse> {
    try {
      const papers = await fetchArxivPapers(req);
      return { papers, pagination: undefined };
    } catch {
      return { papers: [], pagination: undefined };
    }
  },

  async listTrendingRepos(
    _ctx: ServerContext,
    req: ListTrendingReposRequest,
  ): Promise<ListTrendingReposResponse> {
    try {
      const repos = await fetchTrendingRepos(req);
      return { repos, pagination: undefined };
    } catch {
      return { repos: [], pagination: undefined };
    }
  },

  async listHackernewsItems(
    _ctx: ServerContext,
    req: ListHackernewsItemsRequest,
  ): Promise<ListHackernewsItemsResponse> {
    try {
      const items = await fetchHackernewsItems(req);
      return { items, pagination: undefined };
    } catch {
      return { items: [], pagination: undefined };
    }
  },
};
