/**
 * RPC: listTrendingRepos -- reads seeded trending repo data from Railway seed cache.
 * All external OSSInsight/GitHub API calls happen in seed-research.mjs on Railway.
 */

import type {
  ServerContext,
  ListTrendingReposRequest,
  ListTrendingReposResponse,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY_PREFIX = 'research:trending:v1';

export async function listTrendingRepos(
  _ctx: ServerContext,
  req: ListTrendingReposRequest,
): Promise<ListTrendingReposResponse> {
  try {
    const language = req.language || 'python';
    const period = req.period || 'daily';
    const pageSize = clampInt(req.pageSize, 50, 1, 100);
    const seedKey = `${SEED_KEY_PREFIX}:${language}:${period}:50`;
    const result = await getCachedJson(seedKey, true) as ListTrendingReposResponse | null;
    if (!result?.repos?.length) return { repos: [], pagination: undefined };
    return { repos: result.repos.slice(0, pageSize), pagination: undefined };
  } catch {
    return { repos: [], pagination: undefined };
  }
}
