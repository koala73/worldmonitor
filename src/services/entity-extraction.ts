import type { ClusteredEventCore } from './analysis-core';
import {
  extractEntitiesFromTitle,
  extractEntityContext,
  extractEntityContexts,
  type NewsEntityContext,
} from '../../shared/entity-extraction-core.js';

export type {
  ExtractedEntity,
  NewsEntityContext,
} from '../../shared/entity-extraction-core.js';
export { extractEntitiesFromTitle };
export {
  findNewsForEntity,
  findNewsForMarketSymbol,
} from '../../shared/market-alert-core.js';

export function extractEntitiesFromCluster(cluster: ClusteredEventCore): NewsEntityContext {
  return extractEntityContext(cluster);
}

export function extractEntitiesFromClusters(
  clusters: ClusteredEventCore[]
): Map<string, NewsEntityContext> {
  return extractEntityContexts(clusters);
}
