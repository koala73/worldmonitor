/**
 * Shared constants, types, and helpers used by multiple intelligence RPCs.
 */

import { hashString, sha256Hex } from '../../../_shared/hash';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 25_000;

// The classify cache (`classify:sebuf:v6`) is written by this handler and by
// the relay's classify seed, and read by classify-event and the feed digest.
// Every reader validates a hit against these lists: the value is Redis-backed
// JSON that any writer with the shared token could replace, and `category`
// reaches a NewsPanel badge.
export const CLASSIFY_VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const CLASSIFY_VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
] as const;

export function isValidClassifyHit(hit: { level: string; category: string }): boolean {
  return (CLASSIFY_VALID_LEVELS as readonly string[]).includes(hit.level)
    && (CLASSIFY_VALID_CATEGORIES as readonly string[]).includes(hit.category);
}
// v5 (2026-04-28): bumped from v4 to evict entries that landed under
// the pre-publisher-prefix-fix classifier (PR #3480). Brand-prefixed
// retrospective titles like "CBS News Radio flashback: D-Day, Invasion
// of Normandy in 1944" had been promoted to severity=critical via the
// `invasion` keyword and persisted in the classify cache. The new
// brand-prefix branch in _classifier.ts re-rules those rows on next
// touch; v5 forces an immediate eviction rather than waiting for
// natural TTL.
// v4 (2026-04-26): bumped from v3 to evict entries poisoned by static
// institutional pages that previously promoted info-keyword titles to
// high/critical via the LLM classifier. See PR for U4 of
// docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md.
// Three sites read/write this prefix: this canonical writer, the digest
// reader at server/worldmonitor/news/v1/list-feed-digest.ts (now uses
// buildClassifyCacheKey), and scripts/ais-relay.cjs (independent inline
// helper — cannot import from .ts). All three are kept in lockstep by
// the news-classify-cache-prefix-audit static-analysis test.
// v5 → v6 (2026-07-06, #4944 U6): the classify chain moved to DeepSeek —
// bumped LAST in the migration merge order so one eviction retires both the
// old-chain rows and any mixed-model residue written during the rollout.
const CLASSIFY_CACHE_PREFIX = 'classify:sebuf:v6:';

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
