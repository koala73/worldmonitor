// IMPORTANT: This module is the canonical cache-key builder shared by both
// client (src/) and server (server/ via _shared.ts re-export). It imports
// hashString from src/utils/hash.ts — do NOT swap to server/_shared/hash.ts
// or client/server cache keys will silently diverge.
import { hashString } from './hash';

// Bumped v8 → v9 on 2026-08-01 (#5969): prompt generation and cache
// identity now select the same first five unique, non-empty headlines in
// request order before the selected pairs are sorted for stable hashing.
// Retire v8 rows so a key minted with the old sort-before-cap window cannot
// serve a summary generated from a different story set.
//
// Bumped v7 → v8 on 2026-07-06 (#4944): the summarize provider chain moved
// from groq llama-3.1-8b-instant-first to OpenRouter deepseek-v4-flash-first,
// so v7 rows carry old-model voice — retire them cleanly at cutover instead
// of serving mixed-model summaries for the TTL.
//
// v6 → v7 (2026-07-05, #4914): identical (headline, body) pairs now
// dedup before the top-5 slice, so v6 rows keyed over a duplicate-bearing
// composition would never be hit again anyway — the bump retires them
// cleanly instead of leaving orphans to age out.
//
// v5 → v6 (2026-04-24): RSS-description-grounding fix. Even callers that
// DON'T pass `bodies` saw a forced cold-start so the pre-grounding
// headline-only rows aged out cleanly on first tick after deploy. See
// docs/plans/2026-04-24-001-fix-rss-description-end-to-end-plan.md U6.
export const CACHE_VERSION = 'v9';

const MAX_HEADLINE_LEN = 500;
export const MAX_SUMMARY_HEADLINES = 5;
const MAX_GEO_CONTEXT_LEN = 2000;
const MAX_BODY_LEN = 400; // matches SummarizeArticle prompt interpolation clip

export interface SummaryHeadlinePair {
  h: string;
  b: string;
}

/**
 * Select the exact headline/body window used by summary prompts and cache
 * identity. Headline identity is first-arrival-wins because the prompt also
 * keeps the first body paired with a repeated headline.
 */
export function selectUniqueHeadlinePairs(
  pairs: readonly SummaryHeadlinePair[],
): SummaryHeadlinePair[] {
  const selected: SummaryHeadlinePair[] = [];
  const seen = new Set<string>();

  for (const pair of pairs) {
    if (pair.h.length === 0 || seen.has(pair.h)) continue;
    seen.add(pair.h);
    selected.push(pair);
    if (selected.length === MAX_SUMMARY_HEADLINES) break;
  }

  return selected;
}

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
 * @param bodies Paired 1:1 with headlines (request order, post-sanitize).
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
  const pairs = canon.headlines.map((h, i) => ({ h, b: canon.bodies[i] ?? '' }));
  // Select in request order before sorting. Prompt generation uses the same
  // helper, so no story outside the cache-key window can affect the summary.
  // Sorting the selected pairs keeps identity stable across reorderings
  // WITHIN the window while preserving each headline/body association. Note
  // the window itself is request-order dependent once more than
  // MAX_SUMMARY_HEADLINES unique headlines arrive: permuting such an input
  // selects a different five and therefore mints a different key. That is
  // required — the prompt selects in request order too — so any caller that
  // passes more than MAX_SUMMARY_HEADLINES headlines must keep its ordering
  // stable across repeat requests for the same story set, or it will miss.
  // Headline-only comparison: selectUniqueHeadlinePairs guarantees unique
  // `h` in its output, so a body tie-break could never execute.
  // `selected` keeps request order — translate mode keys off its first entry,
  // mirroring the prompt, which interpolates only headlines[0].
  const selected = selectUniqueHeadlinePairs(pairs);
  const topPairs = [...selected].sort((a, b) => {
    if (a.h < b.h) return -1;
    if (a.h > b.h) return 1;
    return 0;
  });
  // Length-prefix each field before joining. A bare '|' join is ambiguous
  // because no sanitizer strips '|' from headlines: ['A|B','C'] and
  // ['A','B|C'] both flatten to 'A|B|C', so two genuinely different story
  // windows minted one key and either could be served the other's summary.
  const sortedHeadlines = topPairs.map(p => `${p.h.length}:${p.h}`).join('|');

  const anyBody = topPairs.some(p => p.b.length > 0);
  // `:bd` (body-digest) rather than `:b` so a future string-match against the
  // key doesn't collide with the literal `:brief:` mode segment.
  const bodiesHash = anyBody
    ? ':bd' + hashString(topPairs.map(p => `${p.b.length}:${p.b}`).join('|'))
    : '';

  const geoHash = canon.geoContext ? ':g' + hashString(canon.geoContext) : '';
  const hash = hashString(`${mode}:${sortedHeadlines}`);
  const normalizedVariant = typeof variant === 'string' && variant ? variant.toLowerCase() : 'full';
  const normalizedLang = typeof lang === 'string' && lang ? lang.toLowerCase() : 'en';
  const fwHash = systemAppend ? ':fw' + hashString(systemAppend).slice(0, 8) : '';

  if (mode === 'translate') {
    // translate mode only uses headlines[0]; bodies are never interpolated.
    // Skip the bodies segment so translate cache identity is not shifted
    // by unrelated upstream RSS-description changes.
    //
    // Key on that single headline only, in REQUEST order. Hashing the whole
    // sorted window made the key order-insensitive while the prompt is
    // order-sensitive, so ['Alpha','Beta'] and ['Beta','Alpha'] shared one key
    // but asked for different translations — a hit could return the other
    // headline's text. Keying the exact input also stops unrelated trailing
    // headlines from fragmenting identity for the same translation.
    const firstHeadline = selected[0]?.h ?? '';
    const translateHash = hashString(`${mode}:${firstHeadline.length}:${firstHeadline}`);
    const targetLang = normalizedVariant || normalizedLang;
    return `summary:${CACHE_VERSION}:${mode}:${targetLang}:${translateHash}${geoHash}${fwHash}`;
  }

  return `summary:${CACHE_VERSION}:${mode}:${normalizedVariant}:${normalizedLang}:${hash}${geoHash}${bodiesHash}${fwHash}`;
}
