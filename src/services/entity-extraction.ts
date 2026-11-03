import type { ClusteredEventCore } from './analysis-core';
import { getEntityDisplayName } from './entity-index';
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

export function getTopEntitiesFromNews(
  newsContexts: Map<string, NewsEntityContext>,
  limit = 10
): Array<{ entityId: string; name: string; mentionCount: number; avgConfidence: number }> {
  const entityStats = new Map<string, { count: number; totalConfidence: number }>();

  for (const context of newsContexts.values()) {
    for (const entity of context.entities) {
      const stats = entityStats.get(entity.entityId) ?? { count: 0, totalConfidence: 0 };
      stats.count++;
      stats.totalConfidence += entity.confidence;
      entityStats.set(entity.entityId, stats);
    }
  }

  return Array.from(entityStats.entries())
    .map(([entityId, stats]) => ({
      entityId,
      name: getEntityDisplayName(entityId),
      mentionCount: stats.count,
      avgConfidence: stats.totalConfidence / stats.count,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, limit);
}
