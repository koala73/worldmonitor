/**
 * Client-side entity index — memoized singleton over the shared, dependency-free
 * core in `shared/analysis-entity-index.ts`.
 *
 * The lookup logic lives in shared/ so server-side callers can inject their own
 * index. This module only adds the process-wide memoization the dashboard relies
 * on, and keeps the singleton-flavoured signatures existing callers use.
 */

import { ENTITY_REGISTRY, type EntityEntry } from '@/config/entities';
import type { EntityIndex, EntityMatch } from '../../shared/analysis-entity-index';
import {
  buildEntityIndex,
  findEntitiesInText as findEntitiesInTextCore,
  findRelatedEntities as findRelatedEntitiesCore,
  getEntityDisplayName as getEntityDisplayNameCore,
  lookupEntitiesByKeyword as lookupEntitiesByKeywordCore,
  lookupEntitiesBySector as lookupEntitiesBySectorCore,
  lookupEntityByAlias as lookupEntityByAliasCore,
} from '../../shared/analysis-entity-index';

export type { EntityIndex, EntityMatch };
export { buildEntityIndex };

let cachedIndex: EntityIndex | null = null;

export function getEntityIndex(): EntityIndex {
  if (!cachedIndex) {
    cachedIndex = buildEntityIndex(ENTITY_REGISTRY);
  }
  return cachedIndex;
}

export function lookupEntityByAlias(alias: string): EntityEntry | undefined {
  return lookupEntityByAliasCore(alias, getEntityIndex());
}

export function lookupEntitiesByKeyword(keyword: string): EntityEntry[] {
  return lookupEntitiesByKeywordCore(keyword, getEntityIndex());
}

export function lookupEntitiesBySector(sector: string): EntityEntry[] {
  return lookupEntitiesBySectorCore(sector, getEntityIndex());
}

export function findRelatedEntities(entityId: string): EntityEntry[] {
  return findRelatedEntitiesCore(entityId, getEntityIndex());
}

export function findEntitiesInText(text: string): EntityMatch[] {
  return findEntitiesInTextCore(text, getEntityIndex());
}

export function getEntityDisplayName(entityId: string): string {
  return getEntityDisplayNameCore(entityId, getEntityIndex());
}
