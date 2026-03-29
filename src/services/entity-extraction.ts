import type { ClusteredEventCore } from './analysis-core';
import {
  findEntitiesInText,
  getEntityIndex,
  getEntityDisplayName,
  findRelatedEntities,
} from './entity-index';

export interface ExtractedEntity {
  entityId: string;
  name: string;
  matchedText: string;
  matchType: 'alias' | 'keyword' | 'name';
  confidence: number;
}

export interface NewsEntityContext {
  clusterId: string;
  title: string;
  entities: ExtractedEntity[];
  primaryEntity?: string;
  relatedEntityIds: string[];
}

export function extractEntitiesFromTitle(title: string): ExtractedEntity[] {
  const matches = findEntitiesInText(title);

  return matches.map(match => ({
    entityId: match.entityId,
    name: getEntityDisplayName(match.entityId),
    matchedText: match.matchedText,
    matchType: match.matchType,
    confidence: match.confidence,
  }));
}

export function extractEntitiesFromCluster(cluster: ClusteredEventCore): NewsEntityContext {
  const primaryEntities = extractEntitiesFromTitle(cluster.primaryTitle);
  const entityMap = new Map<string, ExtractedEntity>();

  for (const entity of primaryEntities) {
    if (!entityMap.has(entity.entityId)) {
      entityMap.set(entity.entityId, entity);
    }
  }

  if (cluster.allItems && cluster.allItems.length > 1) {
    for (const item of cluster.allItems.slice(0, 5)) {
      const itemEntities = extractEntitiesFromTitle(item.title);
      for (const entity of itemEntities) {
        if (!entityMap.has(entity.entityId)) {
          entity.confidence *= 0.9;
          entityMap.set(entity.entityId, entity);
        }
      }
    }
  }

  const entities = [...entityMap.values()]
    .sort((a, b) => b.confidence - a.confidence);

  const primaryEntity = entities[0]?.entityId;

  const relatedEntityIds = new Set<string>();
  for (const entity of entities) {
    const related = findRelatedEntities(entity.entityId);
    for (const rel of related) {
      relatedEntityIds.add(rel.id);
    }
  }

  return {
    clusterId: cluster.id,
    title: cluster.primaryTitle,
    entities,
    primaryEntity,
    relatedEntityIds: [...relatedEntityIds],
  };
}

export function extractEntitiesFromClusters(
  clusters: ClusteredEventCore[]
): Map<string, NewsEntityContext> {
  const contextMap = new Map<string, NewsEntityContext>();

  for (const cluster of clusters) {
    const context = extractEntitiesFromCluster(cluster);
    contextMap.set(cluster.id, context);
  }

  return contextMap;
}

export function findNewsForEntity(
  entityId: string,
  newsContexts: Map<string, NewsEntityContext>
): { clusterId: string; title: string; confidence: number }[] {
  const index = getEntityIndex();
  const entity = index.byId.get(entityId);
  if (!entity) return [];

  const relatedIds = new Set<string>([entityId, ...(entity.related ?? [])]);

  const matches: { clusterId: string; title: string; confidence: number }[] = [];

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
): { clusterId: string; title: string; confidence: number }[] {
  return findNewsForEntity(symbol, newsContexts);
}

export function getTopEntitiesFromNews(
  newsContexts: Map<string, NewsEntityContext>,
  limit = 10
): { entityId: string; name: string; mentionCount: number; avgConfidence: number }[] {
  const entityStats = new Map<string, { count: number; totalConfidence: number }>();

  for (const context of newsContexts.values()) {
    for (const entity of context.entities) {
      const stats = entityStats.get(entity.entityId) ?? { count: 0, totalConfidence: 0 };
      stats.count++;
      stats.totalConfidence += entity.confidence;
      entityStats.set(entity.entityId, stats);
    }
  }

  return [...entityStats.entries()]
    .map(([entityId, stats]) => ({
      entityId,
      name: getEntityDisplayName(entityId),
      mentionCount: stats.count,
      avgConfidence: stats.totalConfidence / stats.count,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, limit);
}
