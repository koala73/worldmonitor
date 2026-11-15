/**
 * Research service handler. Each RPC is its own file.
 * list-tech-events.ts fetches on demand. The other three read seeds
 * written by scripts/seed-research.mjs.
 */

import type { ResearchServiceHandler } from '../../../../src/generated/server/worldmonitor/research/v1/service_server';
import { listArxivPapers } from './list-arxiv-papers';
import { listTrendingRepos } from './list-trending-repos';
import { listHackernewsItems } from './list-hackernews-items';
import { listTechEvents } from './list-tech-events';

export const researchHandler: ResearchServiceHandler = {
  listArxivPapers,
  listTrendingRepos,
  listHackernewsItems,
  listTechEvents,
};
