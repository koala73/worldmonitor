import type { ClusteredEventCore } from './analysis-core';
import {
  getEntityIndex,
  getEntityDisplayName,
} from './entity-index';
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

export function extractEntitiesFromCluster(cluster: ClusteredEventCore): NewsEntityContext {
  return extractEntityContext(cluster);
}

export function extractEntitiesFromClusters(
  clusters: ClusteredEventCore[]
): Map<string, NewsEntityContext> {
  return extractEntityContexts(clusters);
}

export function findNewsForEntity(
  entityId: string,
  newsContexts: Map<string, NewsEntityContext>
): Array<{ clusterId: string; title: string; confidence: number }> {
  const index = getEntityIndex();
  const entity = index.byId.get(entityId);
  if (!entity) return [];

  const relatedIds = new Set<string>([entityId, ...(entity.related ?? [])]);

  const matches: Array<{ clusterId: string; title: string; confidence: number }> = [];

  for (const [clusterId, context] of newsContexts) {
    const directMatch = context.entities.find(e => e.entityId === entityId);
    if (directMatch) {
      matches.push({
        clusterId,
        title: context.title,
        confidence: directMatch.confidence,
      });
      continue;
    }

    const relatedMatch = context.entities.find(e => relatedIds.has(e.entityId));
    if (relatedMatch) {
      matches.push({
        clusterId,
        title: context.title,
        confidence: relatedMatch.confidence * 0.8,
      });
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

export function findNewsForMarketSymbol(
  symbol: string,
  newsContexts: Map<string, NewsEntityContext>
): Array<{ clusterId: string; title: string; confidence: number }> {
  return findNewsForEntity(symbol, newsContexts);
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
