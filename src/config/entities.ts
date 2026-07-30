/**
 * Entity registry — the data now lives in shared/entity-registry.js (issue
 * #5697) so server-side MCP tools and the client share one source. This
 * module re-exports it unchanged for existing client imports.
 */
export type { EntityType, EntityEntry } from '../../shared/entity-registry.js';
export { ENTITY_REGISTRY, getEntityById } from '../../shared/entity-registry.js';
