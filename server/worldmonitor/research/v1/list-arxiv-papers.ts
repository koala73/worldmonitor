/**
 * RPC: listArxivPapers -- reads seeded arXiv data from Railway seed cache.
 * All external arXiv API calls happen in seed-research.mjs on Railway.
 */

import type {
  ServerContext,
  ListArxivPapersRequest,
  ListArxivPapersResponse,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { ValidationError } from '../../../../src/generated/server/worldmonitor/research/v1/service_server';
import trackedCategories from '../../../../scripts/shared/research-arxiv-categories.json';
import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_KEY_PREFIX = 'research:arxiv:v1';

export async function listArxivPapers(
  ctx: ServerContext,
  req: ListArxivPapersRequest,
): Promise<ListArxivPapersResponse> {
  const category = req.category || '';
  if (category && !trackedCategories.includes(category)) {
    throw new ValidationError([{ field: 'category', description: 'Unsupported arXiv category' }]);
  }
  const categories = category ? [category] : trackedCategories;
  const pageSize = clampInt(req.pageSize, 50, 1, 100);
  const snapshots = await Promise.all(categories.map(async (selected) => {
    try {
      return await getCachedJson(`${SEED_KEY_PREFIX}:${selected}::50`, true) as ListArxivPapersResponse | null;
    } catch {
      return null;
    }
  }));
  const papers = new Map<string, ListArxivPapersResponse['papers'][number]>();
  let incomplete = false;
  for (const snapshot of snapshots) {
    if (!Array.isArray(snapshot?.papers)) {
      incomplete = true;
      continue;
    }
    for (const paper of snapshot.papers) {
      if (!paper || typeof paper.id !== 'string' || !Number.isFinite(paper.publishedAt)) {
        incomplete = true;
        continue;
      }
      if (!papers.has(paper.id)) papers.set(paper.id, paper);
    }
  }
  const result = {
    papers: [...papers.values()].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, pageSize),
    pagination: undefined,
  };
  return incomplete ? markNoStoreFallbackResponse(ctx.request, result) : result;
}
