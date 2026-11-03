/**
 * Shared constants for the Cyber domain RPC.
 *
 * ListCyberThreats reads already-converted threats from the seed cache that
 * scripts/seed-cyber-threats.mjs writes on Railway. The upstream fetchers,
 * GeoIP hydration, deduplication, and proto conversion all live in that
 * seeder; this module only carries what the handler needs to page and filter
 * what it reads.
 */

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

export { clampInt } from '../../../_shared/constants';

export const SEVERITY_RANK: Record<string, number> = {
  CRITICALITY_LEVEL_CRITICAL: 4,
  CRITICALITY_LEVEL_HIGH: 3,
  CRITICALITY_LEVEL_MEDIUM: 2,
  CRITICALITY_LEVEL_LOW: 1,
  CRITICALITY_LEVEL_UNSPECIFIED: 0,
};
