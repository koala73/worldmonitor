// IMPORTANT: This module is the canonical cache-key builder shared by both
// client (src/) and server (server/ via _shared.ts re-export). It imports
// hashString from src/utils/hash.ts — do NOT swap to server/_shared/hash.ts
// or client/server cache keys will silently diverge.
import { hashString } from './hash';

// Bumped v5 → v6 on 2026-04-24 alongside the RSS-description-grounding fix.
// Even callers that DON'T pass `bodies` see a forced cold-start here so the
// pre-grounding headline-only rows age out cleanly on first tick after
// deploy (they were produced from different prompts than what the handler
// now builds when bodies are present). See
// docs/plans/2026-04-24-001-fix-rss-description-end-to-end-plan.md U6.
export const CACHE_VERSION = 'v6';

const MAX_HEADLINE_LEN = 500;
const MAX_HEADLINES_FOR_KEY = 5;
const MAX_GEO_CONTEXT_LEN = 2000;
const MAX_BODY_LEN = 400; // matches SummarizeArticle prompt interpolation clip

export function canonicalizeSummaryInputs(
  headlines: string[],
  geoContext?: string,
  bodies?: string[],
) {
  const canonHeadlines = headlines.slice(0, 10).map(h => typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : '');
  // Bodies are paired 1:1 with headlines. Callers may pass a shorter array
  // (or omit entirely) — pad to match headline count so pair-wise identity
  // stays stable regardless of caller convention.
  const rawBodies = Array.isArray(bodies) ? bodies : [];
  const canonBodies: string[] = canonHeadlines.map((_, i) => {
    const b = rawBodies[i];
    return typeof b === 'string' ? b.slice(0, MAX_BODY_LEN) : '';
  });
  return {
    headlines: canonHeadlines,
    geoContext: typeof geoContext === 'string' ? geoContext.slice(0, MAX_GEO_CONTEXT_LEN) : '',
    bodies: canonBodies,
  };
}

/**
 * Canonical cache-key builder for SummarizeArticle results. Shared by both
 * client (src/services/summarization.ts) and server (server/worldmonitor/
 * news/v1/_shared.ts re-export as getCacheKey). Client and server MUST call
 * with identical inputs for the cache to align — sanitise any adversarial
 * text (bodies, geoContext) the same way on both sides before calling.
 *
 * @param bodies Paired 1:1 with headlines (post-sort, post-sanitize).
 *   - When every body is empty → no `:bd<hash>` segment → key identical to
 *     the headline-only v5 shape (modulo the v5→v6 version bump).
 *   - When any body is non-empty → appends `:bd<hash>` where hash is over
 *     the pair-wise-sorted bodies string.
 *   - In translate mode, bodies are ignored (that path is headline[0]-only).
 */
export function buildSummaryCacheKey(
  headlines: string[],
  mode: string,
  geoContext?: string,
  variant?: string,
  lang?: string,
  systemAppend?: string,
  bodies?: string[],
): string {
  const canon = canonicalizeSummaryInputs(headlines, geoContext, bodies);
  // Pair-wise sort: keep (headline, body) paired through canonical order so
  // the cache identity shifts when either a headline OR its body changes.
  // Without pair-wise sort, swapping a body between stories that share the
  // alphabetic tier would collide the key for distinct prompt content.
  const pairs = canon.headlines.map((h, i) => ({ h, b: canon.bodies[i] ?? '' }));
  pairs.sort((a, b) => {
    if (a.h < b.h) return -1;
    if (a.h > b.h) return 1;
    // Tie-break on body so duplicate headlines produce stable order across
    // runs — without this, duplicate-headline pairs sort non-deterministically
    // and the bodies-hash drifts across rebuilds.
    if (a.b < b.b) return -1;
    if (a.b > b.b) return 1;
    return 0;
  });
  const topPairs = pairs.slice(0, MAX_HEADLINES_FOR_KEY);
  const sortedHeadlines = topPairs.map(p => p.h).join('|');

  const anyBody = topPairs.some(p => p.b.length > 0);
  // `:bd` (body-digest) rather than `:b` so a future string-match against the
  // key doesn't collide with the literal `:brief:` mode segment.
  const bodiesHash = anyBody ? ':bd' + hashString(topPairs.map(p => p.b).join('|')) : '';

  const geoHash = canon.geoContext ? ':g' + hashString(canon.geoContext) : '';
  const hash = hashString(`${mode}:${sortedHeadlines}`);
  const normalizedVariant = typeof variant === 'string' && variant ? variant.toLowerCase() : 'full';
  const normalizedLang = typeof lang === 'string' && lang ? lang.toLowerCase() : 'en';
  const fwHash = systemAppend ? ':fw' + hashString(systemAppend).slice(0, 8) : '';

  if (mode === 'translate') {
    // translate mode only uses headlines[0]; bodies are never interpolated.
    // Skip the bodies segment so translate cache identity is not shifted
    // by unrelated upstream RSS-description changes.
    const targetLang = normalizedVariant || normalizedLang;
    return `summary:${CACHE_VERSION}:${mode}:${targetLang}:${hash}${geoHash}${fwHash}`;
  }

  return `summary:${CACHE_VERSION}:${mode}:${normalizedVariant}:${normalizedLang}:${hash}${geoHash}${bodiesHash}${fwHash}`;
}
