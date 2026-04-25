/**
 * Shared constants, types, and helpers used by multiple intelligence RPCs.
 */

import { hashString, sha256Hex } from '../../../_shared/hash';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 25_000;
// v4 (2026-04-26): bumped from v3 to evict entries poisoned by static
// institutional pages that previously promoted info-keyword titles to
// high/critical via the LLM classifier. See PR for U4 of
// docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md.
// Three sites read/write this prefix: this canonical writer, the digest
// reader at server/worldmonitor/news/v1/list-feed-digest.ts (now uses
// buildClassifyCacheKey), and scripts/ais-relay.cjs (independent inline
// helper — cannot import from .ts). All three were updated atomically.
const CLASSIFY_CACHE_PREFIX = 'classify:sebuf:v4:';

// ========================================================================
// Tier-1 country definitions (used by risk-scores + country-intel-brief)
// ========================================================================

export const TIER1_COUNTRIES: Record<string, string> = {
  US: 'United States', RU: 'Russia', CN: 'China', UA: 'Ukraine', IR: 'Iran',
  IL: 'Israel', TW: 'Taiwan', KP: 'North Korea', SA: 'Saudi Arabia', TR: 'Turkey',
  PL: 'Poland', DE: 'Germany', FR: 'France', GB: 'United Kingdom', IN: 'India',
  PK: 'Pakistan', SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
  CU: 'Cuba', MX: 'Mexico', BR: 'Brazil', AE: 'United Arab Emirates',
  KR: 'South Korea', IQ: 'Iraq', AF: 'Afghanistan', LB: 'Lebanon',
  EG: 'Egypt', JP: 'Japan', QA: 'Qatar',
};

// ========================================================================
// Helpers
// ========================================================================

export { hashString, sha256Hex };

export async function buildClassifyCacheKey(title: string): Promise<string> {
  return `${CLASSIFY_CACHE_PREFIX}${(await sha256Hex(title.toLowerCase())).slice(0, 16)}`;
}
