/**
 * Shared constants and helpers for the REIT service handler RPCs.
 */

export { parseStringArray } from '../../../_shared/parse-string-array';

// Redis cache keys (populated by seed scripts in /scripts/seed-reit-*.mjs)
export const REDIS_KEYS = {
  quotes: 'reits:quotes:v1',
  correlation: 'reits:correlation:v1',
  properties: 'reits:properties:v1',
  social: 'reits:social:v1',
} as const;
