/**
 * RPC: listArxivPapers
 *
 * Fetches papers from the arXiv Atom XML API, parsed via fast-xml-parser.
 * Returns empty array on any failure (graceful degradation).
 */

import { XMLParser } from 'fast-xml-parser';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'research:arxiv:v1';
const REDIS_CACHE_TTL = 3600; // 1 hr — daily arXiv updates
import type {
  ServerContext,
  ListArxivPapersRequest,
  ListArxivPapersResponse,
  ArxivPaper,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

// ---------- XML Parser ----------

const xmlParser = new XMLParser({
  ignoreAttributes: false, // CRITICAL: arXiv uses attributes for category term, link href/rel
  attributeNamePrefix: '@_',
  isArray: (_name: string, jpath: string) =>
    /\.(entry|author|category|link)$/.test(jpath),
});

// ---------- Fetch ----------

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
    headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
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

// ---------- Handler ----------

export async function listArxivPapers(
  _ctx: ServerContext,
  req: ListArxivPapersRequest,
): Promise<ListArxivPapersResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.category || 'cs.AI'}:${req.query || ''}:${req.pagination?.pageSize || 50}`;
    const cached = (await getCachedJson(cacheKey)) as ListArxivPapersResponse | null;
    if (cached?.papers?.length) return cached;

    const papers = await fetchArxivPapers(req);
    const result: ListArxivPapersResponse = { papers, pagination: undefined };
    if (papers.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { papers: [], pagination: undefined };
  }
}
