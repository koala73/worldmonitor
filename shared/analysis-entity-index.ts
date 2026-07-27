/**
 * Entity Index Core — dependency-free entity lookup + news entity extraction.
 *
 * Extracted from `src/services/entity-index.ts` and the extraction half of
 * `src/services/entity-extraction.ts` so server-side callers (Edge / esbuild
 * bundles, MCP tools) can build and query an entity index without importing
 * anything from `src/`.
 *
 * Every function here is pure: the caller owns the index, there is no module
 * level singleton. `src/services/entity-index.ts` keeps the memoized
 * `getEntityIndex()` used by the dashboard.
 */

import { type EntityEntry, type EntityType } from './entities-data';

export type { EntityEntry, EntityType };

export interface EntityIndex {
  byId: Map<string, EntityEntry>;
  byAlias: Map<string, string>;
  byKeyword: Map<string, Set<string>>;
  bySector: Map<string, Set<string>>;
  byType: Map<string, Set<string>>;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildEntityIndex(entities: EntityEntry[]): EntityIndex {
  const byId = new Map<string, EntityEntry>();
  const byAlias = new Map<string, string>();
  const byKeyword = new Map<string, Set<string>>();
  const bySector = new Map<string, Set<string>>();
  const byType = new Map<string, Set<string>>();

  for (const entity of entities) {
    byId.set(entity.id, entity);

    for (const alias of entity.aliases) {
      byAlias.set(alias.toLowerCase(), entity.id);
    }
    byAlias.set(entity.id.toLowerCase(), entity.id);
    byAlias.set(entity.name.toLowerCase(), entity.id);

    for (const keyword of entity.keywords) {
      const kw = keyword.toLowerCase();
      if (!byKeyword.has(kw)) byKeyword.set(kw, new Set());
      byKeyword.get(kw)!.add(entity.id);
    }

    if (entity.sector) {
      const sector = entity.sector.toLowerCase();
      if (!bySector.has(sector)) bySector.set(sector, new Set());
      bySector.get(sector)!.add(entity.id);
    }

    if (!byType.has(entity.type)) byType.set(entity.type, new Set());
    byType.get(entity.type)!.add(entity.id);
  }

  return { byId, byAlias, byKeyword, bySector, byType };
}

export function lookupEntityByAlias(alias: string, index: EntityIndex): EntityEntry | undefined {
  const id = index.byAlias.get(alias.toLowerCase());
  return id ? index.byId.get(id) : undefined;
}

export function lookupEntitiesByKeyword(keyword: string, index: EntityIndex): EntityEntry[] {
  const ids = index.byKeyword.get(keyword.toLowerCase());
  if (!ids) return [];
  return Array.from(ids)
    .map(id => index.byId.get(id))
    .filter((e): e is EntityEntry => e !== undefined);
}

export function lookupEntitiesBySector(sector: string, index: EntityIndex): EntityEntry[] {
  const ids = index.bySector.get(sector.toLowerCase());
  if (!ids) return [];
  return Array.from(ids)
    .map(id => index.byId.get(id))
    .filter((e): e is EntityEntry => e !== undefined);
}

export function findRelatedEntities(entityId: string, index: EntityIndex): EntityEntry[] {
  const entity = index.byId.get(entityId);
  if (!entity?.related) return [];
  return entity.related.map(id => index.byId.get(id)).filter((e): e is EntityEntry => !!e);
}

export interface EntityMatch {
  entityId: string;
  matchedText: string;
  matchType: 'alias' | 'keyword' | 'name';
  confidence: number;
  position: number;
}

export function findEntitiesInText(text: string, index: EntityIndex): EntityMatch[] {
  const matches: EntityMatch[] = [];
  const seen = new Set<string>();
  const textLower = text.toLowerCase();

  for (const [alias, entityId] of index.byAlias) {
    if (alias.length < 3) continue;

    const regex = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (!seen.has(entityId)) {
        matches.push({
          entityId,
          matchedText: match[0],
          matchType: 'alias',
          confidence: alias.length > 4 ? 0.95 : 0.85,
          position: match.index,
        });
        seen.add(entityId);
        break;
      }
    }
  }

  for (const [keyword, entityIds] of index.byKeyword) {
    if (keyword.length < 3) continue;
    if (!textLower.includes(keyword)) continue;

    for (const entityId of entityIds) {
      if (seen.has(entityId)) continue;

      const pos = textLower.indexOf(keyword);
      matches.push({
        entityId,
        matchedText: keyword,
        matchType: 'keyword',
        confidence: 0.7,
        position: pos,
      });
      seen.add(entityId);
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence || a.position - b.position);
}

export function getEntityDisplayName(entityId: string, index: EntityIndex): string {
  const entity = index.byId.get(entityId);
  return entity?.name ?? entityId;
}

// ============================================================================
// News entity extraction
// ============================================================================

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

/** Minimal structural shape the extractor reads off a news cluster. */
export interface EntityClusterInput {
  id: string;
  primaryTitle: string;
  allItems?: Array<{ title: string }>;
}

export function extractEntitiesFromTitle(title: string, index: EntityIndex): ExtractedEntity[] {
  const matches = findEntitiesInText(title, index);

  return matches.map(match => ({
    entityId: match.entityId,
    name: getEntityDisplayName(match.entityId, index),
    matchedText: match.matchedText,
    matchType: match.matchType,
    confidence: match.confidence,
  }));
}

export function extractEntityContext(
  cluster: EntityClusterInput,
  index: EntityIndex
): NewsEntityContext {
  const primaryEntities = extractEntitiesFromTitle(cluster.primaryTitle, index);
  const entityMap = new Map<string, ExtractedEntity>();

  for (const entity of primaryEntities) {
    if (!entityMap.has(entity.entityId)) {
      entityMap.set(entity.entityId, entity);
    }
  }

  if (cluster.allItems && cluster.allItems.length > 1) {
    for (const item of cluster.allItems.slice(0, 5)) {
      const itemEntities = extractEntitiesFromTitle(item.title, index);
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
    const related = findRelatedEntities(entity.entityId, index);
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

export function extractEntityContexts(
  clusters: EntityClusterInput[],
  index: EntityIndex
): Map<string, NewsEntityContext> {
  const contextMap = new Map<string, NewsEntityContext>();

  for (const cluster of clusters) {
    contextMap.set(cluster.id, extractEntityContext(cluster, index));
  }

  return contextMap;
}
