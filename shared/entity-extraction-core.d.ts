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

export declare function buildEntityIndex(entities: EntityEntry[]): EntityIndex;
export declare function getEntityIndex(): EntityIndex;
export declare function lookupEntityByAlias(alias: string): EntityEntry | undefined;
export declare function lookupEntitiesByKeyword(keyword: string): EntityEntry[];
export declare function lookupEntitiesBySector(sector: string): EntityEntry[];
export declare function findRelatedEntities(entityId: string): EntityEntry[];
export declare function findEntitiesInText(text: string): EntityMatch[];
export declare function getEntityDisplayName(entityId: string): string;
export declare function extractEntitiesFromTitle(title: string): ExtractedEntity[];
