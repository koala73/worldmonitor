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

  const entities = Array.from(entityMap.values())
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
    relatedEntityIds: Array.from(relatedEntityIds),
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

/**
 * Extracts a location (lat/lon) from text by matching against ENTITY_REGISTRY
 * and country names.
 */
export function extractLocationFromText(text: string): { lat: number, lon: number, name: string } | null {
  const matches = findEntitiesInText(text);
  const locationMatch = matches.find(m => {
    const entity = getEntityIndex().byId.get(m.entityId);
    return entity?.type === 'location' && entity.lat !== undefined && entity.lon !== undefined;
  });

  if (locationMatch) {
    const entity = getEntityIndex().byId.get(locationMatch.entityId)!;
    return { lat: entity.lat!, lon: entity.lon!, name: entity.name };
  }

  // Fallback: simple country name matching if no high-confidence entity found
  const countries = matchCountryNamesInText(text);
  if (countries.length > 0 && countries[0]) {
    return { lat: countries[0].lat, lon: countries[0].lon, name: countries[0].name };
  }

  return null;
}

export function matchCountryNamesInText(text: string): Array<{ name: string, lat: number, lon: number }> {
  // Simple list for fallback geotagging
  const commonCountries: Record<string, [number, number]> = {
    'Israel': [31.0461, 34.8516],
    'Iran': [32.4279, 53.6880],
    'Ukraine': [48.3794, 31.1656],
    'Russia': [61.5240, 105.3188],
    'USA': [37.0902, -95.7129],
    'China': [35.8617, 104.1954],
    'Taiwan': [23.6978, 120.9605],
    'Lebanon': [33.8547, 35.8623],
    'Syria': [34.8021, 38.9968],
    'Yemen': [15.5527, 48.5164],
    'Red Sea': [20.3858, 38.1221],
    'Gaza': [31.3547, 34.3088],
  };

  const results: Array<{ name: string, lat: number, lon: number }> = [];
  const lower = text.toLowerCase();
  for (const [name, coords] of Object.entries(commonCountries)) {
    if (lower.includes(name.toLowerCase())) {
      results.push({ name, lat: coords[0], lon: coords[1] });
    }
  }
  return results;
}
