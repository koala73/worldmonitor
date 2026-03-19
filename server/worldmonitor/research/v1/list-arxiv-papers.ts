/**
 * RPC: listArxivPapers -- reads seeded arXiv data from Railway seed cache.
 * All external arXiv API calls happen in seed-research.mjs on Railway.
 */

import type {
  ServerContext,
  ListArxivPapersRequest,
  ListArxivPapersResponse,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY_PREFIX = 'research:arxiv:v1';

export async function listArxivPapers(
  _ctx: ServerContext,
  req: ListArxivPapersRequest,
): Promise<ListArxivPapersResponse> {
  try {
    const category = req.category || 'cs.AI';
    const pageSize = clampInt(req.pageSize, 50, 1, 100);
    const seedKey = `${SEED_KEY_PREFIX}:${category}::50`;
    const result = await getCachedJson(seedKey, true) as ListArxivPapersResponse | null;
    if (!result?.papers?.length) return { papers: [], pagination: undefined };
    return { papers: result.papers.slice(0, pageSize), pagination: undefined };
  } catch {
    return { papers: [], pagination: undefined };
  }
}
