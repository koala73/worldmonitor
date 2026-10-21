import type { EntityEntry } from './entity-registry.js';

export interface AliasMatcher {
  alias: string;
  entityId: string;
  regex: RegExp;
}

export interface EntityIndex {
  byId: Map<string, EntityEntry>;
  byAlias: Map<string, string>;
  byKeyword: Map<string, Set<string>>;
  bySector: Map<string, Set<string>>;
  byType: Map<string, Set<string>>;
  aliasMatchers: AliasMatcher[];
}

export interface EntityMatch {
  entityId: string;
  matchedText: string;
  matchType: 'alias' | 'keyword' | 'name';
  confidence: number;
  position: number;
}

export interface ExtractedEntity {
  entityId: string;
  name: string;
  matchedText: string;
  matchType: 'alias' | 'keyword' | 'name';
  confidence: number;
}

export interface EntityClusterInput {
  id: string;
  primaryTitle: string;
  allItems?: Array<{ title: string }>;
}

export interface NewsEntityContext {
  clusterId: string;
  title: string;
  entities: ExtractedEntity[];
  primaryEntity?: string;
  relatedEntityIds: string[];
}

export declare function buildEntityIndex(entities: EntityEntry[]): EntityIndex;
export declare function getEntityIndex(): EntityIndex;
export declare function lookupEntityByAlias(alias: string, index?: EntityIndex): EntityEntry | undefined;
export declare function lookupEntitiesByKeyword(keyword: string, index?: EntityIndex): EntityEntry[];
export declare function lookupEntitiesBySector(sector: string, index?: EntityIndex): EntityEntry[];
export declare function findRelatedEntities(entityId: string, index?: EntityIndex): EntityEntry[];
export declare function findEntitiesInText(text: string, index?: EntityIndex): EntityMatch[];
export declare function getEntityDisplayName(entityId: string, index?: EntityIndex): string;
export declare function extractEntitiesFromTitle(title: string, index?: EntityIndex): ExtractedEntity[];
export declare function extractEntityContext(
  cluster: EntityClusterInput,
  index?: EntityIndex,
): NewsEntityContext;
export declare function extractEntityContexts(
  clusters: EntityClusterInput[],
  index?: EntityIndex,
): Map<string, NewsEntityContext>;
