import { ENTITY_REGISTRY, type EntityEntry } from '@/config/entities';

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

let cachedIndex: EntityIndex | null = null;

export function getEntityIndex(): EntityIndex {
  if (!cachedIndex) {
    cachedIndex = buildEntityIndex(ENTITY_REGISTRY);
  }
  return cachedIndex;
}

export function lookupEntityByAlias(alias: string): EntityEntry | undefined {
  const index = getEntityIndex();
  const id = index.byAlias.get(alias.toLowerCase());
  return id ? index.byId.get(id) : undefined;
}

export function lookupEntitiesByKeyword(keyword: string): EntityEntry[] {
  const index = getEntityIndex();
  const ids = index.byKeyword.get(keyword.toLowerCase());
  if (!ids) return [];
  return Array.from(ids)
    .map(id => index.byId.get(id))
    .filter((e): e is EntityEntry => e !== undefined);
}

export function lookupEntitiesBySector(sector: string): EntityEntry[] {
  const index = getEntityIndex();
  const ids = index.bySector.get(sector.toLowerCase());
  if (!ids) return [];
  return Array.from(ids)
    .map(id => index.byId.get(id))
    .filter((e): e is EntityEntry => e !== undefined);
}

export function findRelatedEntities(entityId: string): EntityEntry[] {
  const index = getEntityIndex();
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

export function findEntitiesInText(text: string): EntityMatch[] {
  const index = getEntityIndex();
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
    const kwRegex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'gi');
    const kwMatch = kwRegex.exec(text);
    if (!kwMatch) continue;

    for (const entityId of entityIds) {
      if (seen.has(entityId)) continue;

      matches.push({
        entityId,
        matchedText: keyword,
        matchType: 'keyword',
        confidence: 0.7,
        position: kwMatch.index,
      });
      seen.add(entityId);
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence || a.position - b.position);
}

export function getEntityDisplayName(entityId: string): string {
  const index = getEntityIndex();
  const entity = index.byId.get(entityId);
  return entity?.name ?? entityId;
}
