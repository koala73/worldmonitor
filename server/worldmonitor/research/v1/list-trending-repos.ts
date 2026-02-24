/**
 * RPC: listTrendingRepos
 *
 * Fetches trending GitHub repos from gitterapp JSON API with
 * herokuapp fallback. Returns empty array on any failure.
 */

import type {
  ServerContext,
  ListTrendingReposRequest,
  ListTrendingReposResponse,
  GithubRepo,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'research:trending:v1';
const REDIS_CACHE_TTL = 3600; // 1 hr — daily trending data

// ---------- Fetch ----------

async function fetchTrendingRepos(req: ListTrendingReposRequest): Promise<GithubRepo[]> {
  const language = req.language || 'python';
  const period = req.period || 'daily';
  const pageSize = req.pagination?.pageSize || 50;

  // Primary API
  const primaryUrl = `https://api.gitterapp.com/repositories?language=${language}&since=${period}`;
  let data: any[];

  try {
    const response = await fetch(primaryUrl, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error('Primary API failed');
    data = await response.json() as any[];
  } catch {
    // Fallback API
    try {
      const fallbackUrl = `https://gh-trending-api.herokuapp.com/repositories/${language}?since=${period}`;
      const fallbackResponse = await fetch(fallbackUrl, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
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

// ---------- Handler ----------

export async function listTrendingRepos(
  _ctx: ServerContext,
  req: ListTrendingReposRequest,
): Promise<ListTrendingReposResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.language || 'python'}:${req.period || 'daily'}:${req.pagination?.pageSize || 50}`;
    const cached = (await getCachedJson(cacheKey)) as ListTrendingReposResponse | null;
    if (cached?.repos?.length) return cached;

    const repos = await fetchTrendingRepos(req);
    const result: ListTrendingReposResponse = { repos, pagination: undefined };
    if (repos.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { repos: [], pagination: undefined };
  }
}
