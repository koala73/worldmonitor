/**
 * Shared constants, types, and helpers used by multiple intelligence RPCs.
 */

import { hashString, sha256Hex } from '../../../_shared/hash';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 25_000;
const CLASSIFY_CACHE_PREFIX = 'classify:sebuf:v1:';

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
