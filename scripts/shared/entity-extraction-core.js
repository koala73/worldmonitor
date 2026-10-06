/**
 * Registry-based entity extraction — single implementation shared by the
 * client (src/services/entity-index.ts re-exports from here) and server-side
 * MCP tools (issue #5697). Ported from src/services/entity-index.ts +
 * extractEntitiesFromTitle from src/services/entity-extraction.ts.
 *
 * Behavior-preserving port with one mechanical change: alias regexes are
 * precompiled at index-build time (the original compiled one RegExp per alias
 * per call — the hot spot when scanning ~200 headlines server-side). Matchers
 * are derived from the final byAlias map so duplicate-alias overwrite and
 * iteration order match the original exactly; lastIndex is reset before every
 * scan because the compiled 'g' regexes are shared across calls.
 *
 * INVARIANT: findEntitiesInText must stay fully synchronous. The compiled
 * regexes are module-level shared state carrying mutable `lastIndex`, and
 * sharing is safe only because no two scans can interleave. Introducing an
 * await anywhere inside the matcher loop (ML enrichment is the tempting one)
 * would let concurrent callers clobber each other's scan position, producing
 * silently missed matches that the sequential idempotency test cannot catch.
 *
 * Dependency-free ESM apart from ./entity-registry.js. Types in
 * entity-extraction-core.d.ts.
 */

import { ENTITY_REGISTRY } from './entity-registry.js';
import { escapeRegex } from './text-analysis-core.js';

export function buildEntityIndex(entities) {
  const byId = new Map();
  const byAlias = new Map();
  const byKeyword = new Map();
  const bySector = new Map();
  const byType = new Map();

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
      byKeyword.get(kw).add(entity.id);
    }

    if (entity.sector) {
      const sector = entity.sector.toLowerCase();
      if (!bySector.has(sector)) bySector.set(sector, new Set());
      bySector.get(sector).add(entity.id);
    }

    if (!byType.has(entity.type)) byType.set(entity.type, new Set());
    byType.get(entity.type).add(entity.id);
  }

  // Precompiled alias matchers, in byAlias iteration order (post-overwrite),
  // skipping the same <3-char aliases findEntitiesInText always skipped.
  const aliasMatchers = [];
  for (const [alias, entityId] of byAlias) {
    if (alias.length < 3) continue;
    aliasMatchers.push({
      alias,
      entityId,
      regex: new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi'),
    });
  }

  return { byId, byAlias, byKeyword, bySector, byType, aliasMatchers };
}

let cachedIndex = null;

export function getEntityIndex() {
  if (!cachedIndex) {
    cachedIndex = buildEntityIndex(ENTITY_REGISTRY);
  }
  return cachedIndex;
}

export function lookupEntityByAlias(alias, index = getEntityIndex()) {
  const id = index.byAlias.get(alias.toLowerCase());
  return id ? index.byId.get(id) : undefined;
}

function resolveEntitiesById(index, ids) {
  if (!ids) return [];
  return Array.from(ids)
    .map(id => index.byId.get(id))
    .filter(entity => entity !== undefined);
}

export function lookupEntitiesByKeyword(keyword, index = getEntityIndex()) {
  return resolveEntitiesById(index, index.byKeyword.get(keyword.toLowerCase()));
}

export function lookupEntitiesBySector(sector, index = getEntityIndex()) {
  return resolveEntitiesById(index, index.bySector.get(sector.toLowerCase()));
}

export function findRelatedEntities(entityId, index = getEntityIndex()) {
  const entity = index.byId.get(entityId);
  return resolveEntitiesById(index, entity?.related);
}

export function findEntitiesInText(text, index = getEntityIndex()) {
  const matches = [];
  const seen = new Set();
  const textLower = text.toLowerCase();

  for (const { alias, entityId, regex } of index.aliasMatchers) {
    regex.lastIndex = 0;
    let match;
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

export function getEntityDisplayName(entityId, index = getEntityIndex()) {
  const entity = index.byId.get(entityId);
  return entity?.name ?? entityId;
}

export function extractEntitiesFromTitle(title, index = getEntityIndex()) {
  const matches = findEntitiesInText(title, index);

  return matches.map(match => ({
    entityId: match.entityId,
    name: getEntityDisplayName(match.entityId, index),
    matchedText: match.matchedText,
    matchType: match.matchType,
    confidence: match.confidence,
  }));
}

export function extractEntityContext(cluster, index = getEntityIndex()) {
  const primaryEntities = extractEntitiesFromTitle(cluster.primaryTitle, index);
  const entityMap = new Map();

  for (const entity of primaryEntities) {
    if (!entityMap.has(entity.entityId)) {
      entityMap.set(entity.entityId, entity);
    }
  }

  if (cluster.allItems && cluster.allItems.length > 1) {
    for (const item of cluster.allItems.slice(0, 5)) {
      if (item.title === cluster.primaryTitle) continue;
      const itemEntities = extractEntitiesFromTitle(item.title, index);
      for (const entity of itemEntities) {
        if (!entityMap.has(entity.entityId)) {
          entityMap.set(entity.entityId, {
            ...entity,
            confidence: entity.confidence * 0.9,
          });
        }
      }
    }
  }

  const entities = Array.from(entityMap.values())
    .sort((a, b) => b.confidence - a.confidence);
  const relatedEntityIds = new Set();

  for (const entity of entities) {
    for (const related of findRelatedEntities(entity.entityId, index)) {
      relatedEntityIds.add(related.id);
    }
  }

  return {
    clusterId: cluster.id,
    title: cluster.primaryTitle,
    entities,
    primaryEntity: entities[0]?.entityId,
    relatedEntityIds: Array.from(relatedEntityIds),
  };
}

export function extractEntityContexts(clusters, index = getEntityIndex()) {
  const contexts = new Map();
  for (const cluster of clusters) {
    contexts.set(cluster.id, extractEntityContext(cluster, index));
  }
  return contexts;
}
