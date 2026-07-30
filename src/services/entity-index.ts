/**
 * Entity index — implementation moved to shared/entity-extraction-core.js
 * (issue #5697) so server-side MCP tools share the exact matcher. This module
 * re-exports the shared implementation for existing client imports.
 */
export type { EntityIndex, EntityMatch } from '../../shared/entity-extraction-core.js';
export {
  buildEntityIndex,
  getEntityIndex,
  lookupEntityByAlias,
  lookupEntitiesByKeyword,
  lookupEntitiesBySector,
  findRelatedEntities,
  findEntitiesInText,
  getEntityDisplayName,
} from '../../shared/entity-extraction-core.js';
