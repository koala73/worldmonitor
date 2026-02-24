import {
  ResearchServiceClient,
  type ArxivPaper,
  type GithubRepo,
  type HackernewsItem,
} from '@/generated/client/worldmonitor/research/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// Re-export proto types (no legacy mapping needed -- proto types are clean)
export type { ArxivPaper, GithubRepo, HackernewsItem };

const client = new ResearchServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const arxivBreaker = createCircuitBreaker<ArxivPaper[]>({ name: 'ArXiv Papers' });
const trendingBreaker = createCircuitBreaker<GithubRepo[]>({ name: 'GitHub Trending' });
const hnBreaker = createCircuitBreaker<HackernewsItem[]>({ name: 'Hacker News' });

export async function fetchArxivPapers(
  category = 'cs.AI',
  query = '',
  pageSize = 50,
): Promise<ArxivPaper[]> {
  return arxivBreaker.execute(async () => {
    const resp = await client.listArxivPapers({
      category,
      query,
      pagination: { pageSize, cursor: '' },
    });
    return resp.papers;
  }, []);
}

export async function fetchTrendingRepos(
  language = 'python',
  period = 'daily',
  pageSize = 50,
): Promise<GithubRepo[]> {
  return trendingBreaker.execute(async () => {
    const resp = await client.listTrendingRepos({
      language,
      period,
      pagination: { pageSize, cursor: '' },
    });
    return resp.repos;
  }, []);
}

export async function fetchHackernewsItems(
  feedType = 'top',
  pageSize = 30,
): Promise<HackernewsItem[]> {
  return hnBreaker.execute(async () => {
    const resp = await client.listHackernewsItems({
      feedType,
      pagination: { pageSize, cursor: '' },
    });
    return resp.items;
  }, []);
}
