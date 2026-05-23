/**
 * Country-scoped LLM-driven deduplication for Live News items.
 *
 * # Why
 *
 * Title-fingerprint dedup (in `_normalize.ts`) catches near-identical
 * wording across outlets but misses semantic duplicates — three sources
 * reporting the same event with very different headlines:
 *   • Reuters: "U.S. Senate passes border security bill 71-29"
 *   • BBC:     "American senators back immigration legislation"
 *   • AP:      "Senate clears bipartisan border deal"
 *
 * # Approach
 *
 * Each item is assigned a `canonical` hash:
 *   - For unique items: canonical = item's own titleHash.
 *   - For duplicates: canonical = the titleHash of the representative
 *     item it's a duplicate of.
 *
 * Items grouped by canonical hash collapse into one entry — we keep the
 * highest-priority source as the visible item for each group.
 *
 * # Why country-scoped
 *
 * Limits the LLM comparison space dramatically: ~180 items spread across
 * ~30 countries means ~6 items per country on average. The LLM only ever
 * compares within a country bucket, so a single batched call covers
 * every newly-seen item with very few input tokens.
 *
 * # Caching strategy
 *
 * Per-item, "canonical" decisions are cached at:
 *   `live-news:dedup:v1:{titleHash}` → { canonical: string }
 *
 * TTL: 30 days. Once an item is classified, we **never** re-evaluate it
 * — even if the items it was originally compared against have rolled
 * off. This is by design (per product spec): "when we forget this news,
 * we shouldn't try to control it again after some time later". A
 * duplicate stays a duplicate forever.
 *
 * # Pre-conditions
 *
 * Dedup needs `summary` and `country` populated to be effective. On the
 * first poll after a deploy these are missing (LLM enrichment hasn't
 * run yet) → no dedup happens that round. By the second/third poll,
 * caches warm up and dedup kicks in. Acceptable progressive behavior.
 */

import { callGemini } from '../../_shared/llm';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { LiveNewsItem } from './_normalize';
import { classifyUnknownsViaEmbedAsync } from './_dedup-embed';

const CACHE_PREFIX = 'live-news:dedup:v1:';
const DEDUP_TTL_S = 3 * 24 * 60 * 60; // 3 days — matches the project-wide max-retention rule

/**
 * Selects which clustering algorithm fills the dedup cache:
 *
 *   • `'embed'` — Gemini text-embedding-004 + cosine clustering.
 *                 Free-tier covered, sub-second, deterministic.
 *                 Default in production.
 *   • `'llm'`   — original Gemini Flash JSON classifier.
 *                 Slower, costs tokens, but country-scoped semantic
 *                 reasoning is sometimes sharper on edge cases.
 *                 Kept as a rollback path; set WM_DEDUP_MODE=llm to
 *                 force.
 *
 * Both paths write to the same Redis key (`live-news:dedup:v1:{hash}`),
 * so switching modes doesn't invalidate previously cached decisions —
 * each entry remains valid until the 30-day TTL expires regardless of
 * which path wrote it.
 */
type DedupMode = 'embed' | 'llm';
function getDedupMode(): DedupMode {
  return process.env.WM_DEDUP_MODE === 'llm' ? 'llm' : 'embed';
}

/**
 * Short TTL for the auto-cached "ineligible — pass as unique" decisions
 * we write for items that lack summary or country at evaluation time.
 *
 * Why short? These items might gain a summary or country on a future
 * cycle (location enrichment runs async, paraphrase can fail and retry).
 * If they later become eligible, we want them to be re-evaluated as
 * potentially-duplicate rather than permanently locked as "unique".
 *
 * 6 hours is long enough to absorb the steady-state convergence
 * (most enrichment finishes within ~2 minutes) and short enough to
 * give re-evaluation a meaningful window.
 */
const INELIGIBLE_DEDUP_TTL_S = 6 * 60 * 60; // 6 hours
/**
 * Cap on items sent to the LLM in a single dedup pass.
 *
 * Math with the new short-snippet representation (~100 tokens per item):
 *   50 items × 100 tokens = 5 000 input tokens
 *   Output: 50 × 30 tokens = 1 500
 *   Wall time with Haiku ≈ 8–11 s, comfortably inside 60 s timeout.
 *
 * Previously this was 30 because we were sending full paragraph summaries
 * (~280 tokens each), which blew prompts to 8 K + tokens and routinely
 * timed out. The single-sentence snippet approach (`summarySnippet`)
 * cut per-item token cost ~3× — same cap budget, more items per pass.
 *
 * Items beyond the cap roll over to the next poll. Convergence: 150
 * unknowns clear in 3 polls (~90 s), vs 5 polls (~150 s) at 30/pass.
 */
const MAX_LLM_ITEMS_PER_PASS = 50;

/**
 * Per-call timeout for the dedup LLM request. The default in `callGemini`
 * is 25 s, which we kept hitting on busy news days when the prompt was
 * large AND Anthropic was slow. 60 s is generous enough to absorb
 * occasional API jitter without blocking forever — we're inside a
 * `keepAlive`-wrapped background task, so even a long call doesn't
 * delay the user's response.
 */
const DEDUP_LLM_TIMEOUT_MS = 60_000;

interface CachedDedupDecision {
  /** titleHash of the representative item this hash collapses to. */
  canonical: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path: load cached decisions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map of titleHash → canonical hash for every item with a cached decision.
 * Items missing from the map are "unknown" and need LLM evaluation.
 */
export async function loadCachedDedupMap(items: LiveNewsItem[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (items.length === 0) return map;

  const keys = items.map((it) => `${CACHE_PREFIX}${it.titleHash}`);
  const cache = await getCachedJsonBatch(keys);

  for (let i = 0; i < items.length; i++) {
    const cached = cache.get(keys[i]!);
    if (cached && typeof cached === 'object' && 'canonical' in (cached as Record<string, unknown>)) {
      const c = cached as CachedDedupDecision;
      if (typeof c.canonical === 'string' && c.canonical.length > 0) {
        map.set(items[i]!.titleHash, c.canonical);
      }
    }
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply dedup using current map (drop duplicates, keep canonicals)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce `items` to unique stories using the dedup map. Items without
 * an entry in the map keep their own titleHash as canonical, so they
 * pass through unaffected — letting the system progressively dedup as
 * cache warms up without ever blocking item visibility.
 *
 * Tie-break when multiple items share a canonical: keeps the one
 * already chosen as canonical (matched titleHash === canonical), or
 * falls back to first-seen.
 */
export function applyDedup(items: LiveNewsItem[], dedupMap: Map<string, string>): LiveNewsItem[] {
  // Group items by canonical
  const byCanonical = new Map<string, LiveNewsItem[]>();
  for (const item of items) {
    const canonical = dedupMap.get(item.titleHash) ?? item.titleHash;
    const bucket = byCanonical.get(canonical) ?? [];
    bucket.push(item);
    byCanonical.set(canonical, bucket);
  }

  // For each canonical group, pick the representative:
  //   1. The item whose titleHash IS the canonical wins (it was named the canonical).
  //   2. Otherwise the first-encountered (most recent due to upstream sort).
  const result: LiveNewsItem[] = [];
  for (const [canonical, group] of byCanonical) {
    const representative = group.find((it) => it.titleHash === canonical) ?? group[0]!;
    result.push(representative);
  }

  // Re-sort by recency since map iteration order isn't guaranteed.
  result.sort((a, b) => b.publishedAt - a.publishedAt);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant: dedup that PRESERVES duplicates as `sources[]` on the canonical
// ─────────────────────────────────────────────────────────────────────────────

/** A single outlet's view of the same underlying story. */
export interface AlternateSource {
  source: string;       // e.g. "Reuters", "BBC News"
  title: string;        // headline as that outlet phrased it (often differs)
  link: string;         // URL to that outlet's article
  publishedAt: number;  // ms since epoch — when that outlet published it
}

/** Canonical news story enriched with every outlet that reported on it. */
export interface LiveNewsItemWithSources extends LiveNewsItem {
  /**
   * All outlets reporting on this story, representative first.
   *   - For unique stories (no duplicates known yet): length 1, contains
   *     just the canonical itself. Always at least 1 entry.
   *   - For deduped stories: representative + each duplicate outlet,
   *     ordered by publishedAt DESC after the lead.
   *
   * Note: the representative's source/title/link are mirrored both at
   * the top level (legacy fields) AND in sources[0] so iOS clients can
   * decode either way without conditionals.
   */
  sources: AlternateSource[];
}

/**
 * Same grouping logic as `applyDedup`, but instead of dropping duplicate
 * items it attaches them to the canonical as a `sources` array. Used by
 * the v2 endpoint (`list-us-headlines` v2). v1 stays on `applyDedup`.
 *
 * The representative item is picked identically to v1 (canonical match
 * first, then first-encountered) — so for stories already classified by
 * v1, the same article surfaces as the lead in both endpoints.
 */
export function applyDedupWithSources(
  items: LiveNewsItem[],
  dedupMap: Map<string, string>,
): LiveNewsItemWithSources[] {
  // Group items by canonical (identical to applyDedup)
  const byCanonical = new Map<string, LiveNewsItem[]>();
  for (const item of items) {
    const canonical = dedupMap.get(item.titleHash) ?? item.titleHash;
    const bucket = byCanonical.get(canonical) ?? [];
    bucket.push(item);
    byCanonical.set(canonical, bucket);
  }

  const result: LiveNewsItemWithSources[] = [];
  for (const [canonical, group] of byCanonical) {
    // Representative selection mirrors applyDedup so v1/v2 leads match.
    const representative = group.find((it) => it.titleHash === canonical) ?? group[0]!;

    // Build sources array: representative first, duplicates by recency after.
    const others = group.filter((it) => it.titleHash !== representative.titleHash);
    others.sort((a, b) => b.publishedAt - a.publishedAt);

    const sources: AlternateSource[] = [representative, ...others].map((it) => ({
      source: it.source,
      title: it.title,
      link: it.link,
      publishedAt: it.publishedAt,
    }));

    result.push({
      ...representative,
      sources,
    });
  }

  result.sort((a, b) => b.publishedAt - a.publishedAt);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path: classify "unknown" items via LLM (per-country)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a news deduplication classifier. Items are grouped by the country they're about.

For each item flagged "unknown", determine whether it reports the SAME underlying news event as any other item in the same country group (whether "unknown" or "anchor"). Be strict: items are duplicates only when they cover the same specific event (same shooting, same vote, same diplomatic announcement). Different events on the same topic — separate protests, different earnings reports, different speeches by the same person — are NOT duplicates.

For each "unknown" item, return:
- id: the input id
- canonical: either "self" (if the item is unique / not a duplicate of anything in its group), or the id of the item it duplicates.

Output a JSON object with a "results" array, one entry per "unknown" item:
{"results": [{"id": "...", "canonical": "self" | "<other id>"}]}

Return JSON ONLY. No prose, no markdown, no code fences.`;

interface ItemForLlm {
  id: string;
  status: 'anchor' | 'unknown';
  title: string;
  /** Brief snippet — never the full paragraph summary. See `summarySnippet`. */
  snippet: string;
}

interface LlmResponse {
  results: Array<{ id: string; canonical: string }>;
}

/**
 * Trim the LLM-paraphrased summary down to a single-sentence snippet for
 * dedup purposes. Sending full paragraph summaries (~600 chars × 30 items)
 * blew the prompt past 8 K input tokens and made every dedup call take
 * 15–20 s before output even started — frequently exceeding our timeout
 * window.
 *
 * For dedup, the question we're asking is "is this the same news event?"
 * — and the lead sentence carries virtually all the signal needed. The
 * remaining sentences add context that doesn't change the answer.
 *
 * Heuristic: take the first sentence (split on `.!?`), cap at 200 chars.
 * Falls back to a 200-char prefix if no sentence boundary is found.
 */
function summarySnippet(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return '';
  // First sentence boundary in the first ~250 chars
  const head = trimmed.slice(0, 250);
  const sentenceEnd = head.search(/[.!?](?:\s|$)/);
  if (sentenceEnd > 30) {
    return head.slice(0, sentenceEnd + 1);
  }
  // No clean sentence boundary — fall back to a hard 200-char prefix.
  return trimmed.slice(0, 200);
}

function buildPrompt(byCountry: Map<string, ItemForLlm[]>): string {
  // Compact JSON (no indentation) to save ~25% tokens vs pretty-print.
  // The LLM reads it just fine without whitespace.
  const groups = [...byCountry.entries()].map(([country, items]) => ({ country, items }));
  return `Country-grouped news items to deduplicate:\n\n${JSON.stringify(groups)}`;
}

function extractJson(text: string): unknown | null {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

/**
 * Salvage individual `{ id, canonical }` entries from a truncated or
 * malformed dedup response. When the LLM's output gets cut off mid-entry
 * (e.g. token-budget exhaustion, response cancellation), strict JSON.parse
 * throws and we'd previously discard the whole batch. This regex-walks the
 * text for *complete* `{"id": "...", "canonical": "..."}` objects and
 * accepts whatever was emitted before truncation.
 *
 * Permissive on whitespace and key order. Intentionally does NOT validate
 * the canonical references (caller already does that). Returns an empty
 * array if nothing parseable was found — caller treats that the same as
 * "LLM returned nothing useful".
 */
function salvageDedupEntries(text: string): Array<{ id: string; canonical: string }> {
  const out: Array<{ id: string; canonical: string }> = [];
  // Match `{...}` blocks that contain both an id and canonical key. The
  // hash ids are 64-hex SHA-256 strings; canonical is either "self" or a
  // similar 64-hex hash.
  const entryRe = /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"canonical"\s*:\s*"([^"]+)"\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(text)) !== null) {
    const [, id, canonical] = match;
    if (id && canonical) out.push({ id, canonical });
  }
  return out;
}

/**
 * Classify the "unknown" items by country using the LLM, write decisions
 * to Redis. Caller fires-and-forgets so the digest response isn't blocked.
 *
 * `allItems` is the full digest (anchors + unknowns); we use the anchors
 * as comparison context. Items missing `summary` or `country` are skipped
 * — they can't be reliably deduped without those fields.
 */
export async function classifyUnknownsAsync(
  allItems: LiveNewsItem[],
  knownMap: Map<string, string>,
): Promise<void> {
  // Dispatch to the embedding-based clusterer unless the rollback flag
  // is set. Both paths satisfy the same contract: mutate `knownMap` in
  // place, persist decisions to the dedup cache, never throw.
  if (getDedupMode() === 'embed') {
    return classifyUnknownsViaEmbedAsync(allItems, knownMap);
  }

  // ── Legacy LLM path ──────────────────────────────────────────────
  //
  // Kept verbatim from the original implementation so flipping
  // WM_DEDUP_MODE=llm produces identical behavior to before.
  // Items missing summary or country can't be deduped — there's nothing
  // to compare against. They'd otherwise sit in "unknown" limbo forever:
  // every cycle they'd show up in the unknownDedup count, the dedup
  // function would silently skip them, and the next cycle would repeat.
  // Cache them as self-canonical (treat as unique) on a SHORT TTL so:
  //   1. They stop polluting the unknownDedup count
  //   2. If their location/summary later fills in, the short TTL lets
  //      them get re-evaluated rather than locking the decision forever
  const ineligibleUnknowns = allItems.filter(
    (it) => !knownMap.has(it.titleHash) &&
      (typeof it.summary !== 'string' || it.summary.length === 0 ||
       typeof it.country !== 'string' || it.country.length === 0),
  );
  if (ineligibleUnknowns.length > 0) {
    await Promise.all(ineligibleUnknowns.map(async (item) => {
      await setCachedJson(
        `${CACHE_PREFIX}${item.titleHash}`,
        { canonical: item.titleHash } as CachedDedupDecision,
        INELIGIBLE_DEDUP_TTL_S,
      );
    }));
    console.log(`[live-news:dedup] auto-cached ${ineligibleUnknowns.length} ineligible items as self-canonical (no summary/country yet)`);
  }

  // Partition: anchors are items with a known canonical; unknowns are the rest.
  // At this point only items WITH both summary and country are still in play.
  const eligibleItems = allItems.filter(
    (it) => typeof it.summary === 'string' && it.summary.length > 0 && typeof it.country === 'string' && it.country.length > 0,
  );

  const byCountry = new Map<string, { anchors: LiveNewsItem[]; unknowns: LiveNewsItem[] }>();
  for (const item of eligibleItems) {
    const country = item.country!;
    const bucket = byCountry.get(country) ?? { anchors: [], unknowns: [] };
    if (knownMap.has(item.titleHash)) {
      bucket.anchors.push(item);
    } else {
      bucket.unknowns.push(item);
    }
    byCountry.set(country, bucket);
  }

  // Special case: countries with exactly one unknown and no anchors.
  // The item is unique by definition — cache it directly without an LLM call.
  const singletonsToCache: LiveNewsItem[] = [];
  for (const [country, { anchors, unknowns }] of byCountry) {
    if (unknowns.length === 1 && anchors.length === 0) {
      singletonsToCache.push(unknowns[0]!);
      byCountry.delete(country);
    }
  }
  await Promise.all(singletonsToCache.map(async (item) => {
    await setCachedJson(`${CACHE_PREFIX}${item.titleHash}`, { canonical: item.titleHash } as CachedDedupDecision, DEDUP_TTL_S);
  }));

  // Build LLM payload: only countries with unknowns AND comparison material.
  const llmGroups = new Map<string, ItemForLlm[]>();
  let unknownCount = 0;
  for (const [country, { anchors, unknowns }] of byCountry) {
    if (unknowns.length === 0) continue;
    if (unknowns.length + anchors.length < 2) continue; // nothing to compare against
    const list: ItemForLlm[] = [
      ...anchors.map((a) => ({
        id: a.titleHash,
        status: 'anchor' as const,
        title: a.title,
        snippet: summarySnippet(a.summary!),
      })),
      ...unknowns.map((u) => ({
        id: u.titleHash,
        status: 'unknown' as const,
        title: u.title,
        snippet: summarySnippet(u.summary!),
      })),
    ];
    llmGroups.set(country, list);
    unknownCount += unknowns.length;
  }

  if (llmGroups.size === 0) {
    if (singletonsToCache.length > 0) {
      console.log(`[live-news:dedup] cached ${singletonsToCache.length} singleton(s); no LLM call needed`);
    }
    return;
  }

  // Cap items if the prompt is getting too big — runaway protection.
  if (unknownCount > MAX_LLM_ITEMS_PER_PASS) {
    console.log(`[live-news:dedup] capping dedup at ${MAX_LLM_ITEMS_PER_PASS}/${unknownCount} unknowns`);
  }

  const result = await callGemini({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(llmGroups),
    // 8 000 token cap for batch of 50 = 160 tokens / item — comfortable
    // headroom on both compact and pretty-printed output. We hit
    // truncation at 4 000 in production for full-batch 50-item passes
    // (Gemini sometimes pretty-prints with extra whitespace, pushing
    // duplicate-canonical entries — which carry a 64-char hash on the
    // RHS — past the budget). 8 000 is well within Gemini Flash Lite's
    // 65 535-token output limit and adds no measurable latency.
    maxTokens: 8000,
    temperature: 0.1,
    // Keep the longer timeout — dedup is still the largest prompt in
    // the system. Gemini Flash Lite is ~3× faster than Claude Haiku in
    // practice, so 60 s gives ample margin.
    timeoutMs: DEDUP_LLM_TIMEOUT_MS,
    // Bill dedup against the same dedicated paraphrase key so its cost
    // is separable from location enrichment in the eachlabs dashboard.
    // Falls back to EACHLABS_API_KEY when the dedicated key is unset.
    apiKeyEnv: 'EACHLABS_API_KEY_PARAPHRASE',
    jsonMode: true,
  });

  if (!result) {
    console.warn('[live-news:dedup] LLM call returned null');
    return;
  }

  // Gemini's JSON mode sometimes returns the bare array instead of the
  // wrapped `{ results: [...] }` we ask for. Accept both shapes.
  const parsed = extractJson(result.content);
  type DedupEntry = LlmResponse['results'][number];
  let results: DedupEntry[] | null =
    Array.isArray(parsed) ? (parsed as DedupEntry[])
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)
        ? (parsed as { results: DedupEntry[] }).results
        : null);

  // Strict JSON parse failed — try to salvage individual entries. This
  // handles the case where Gemini truncated mid-response (token-budget
  // exhaustion or cancellation): the entries before the truncation point
  // are still valid and shouldn't be wasted.
  if (!results) {
    const salvaged = salvageDedupEntries(result.content);
    if (salvaged.length > 0) {
      results = salvaged;
      console.warn(
        `[live-news:dedup] strict parse failed, salvaged ${salvaged.length} entries · ` +
        `responseLen=${result.content.length} · last200="${result.content.slice(-200).replace(/\s+/g, ' ')}"`,
      );
    } else {
      console.warn(
        `[live-news:dedup] failed to parse LLM JSON: ` +
        `responseLen=${result.content.length} · ` +
        `first200="${result.content.slice(0, 200).replace(/\s+/g, ' ')}" · ` +
        `last200="${result.content.slice(-200).replace(/\s+/g, ' ')}"`,
      );
      return;
    }
  }

  // Validate canonical references — the LLM might point at an id that
  // doesn't exist in the input. Fall back to "self" in that case.
  const knownIds = new Set<string>();
  for (const items of llmGroups.values()) {
    for (const item of items) knownIds.add(item.id);
  }

  let writtenUnique = 0;
  let writtenDuplicate = 0;
  await Promise.all(results.map(async (entry) => {
    if (!entry?.id) return;
    let canonical: string;
    if (entry.canonical === 'self' || !entry.canonical) {
      canonical = entry.id;
      writtenUnique++;
    } else if (entry.canonical === entry.id) {
      // LLM pointed at itself — treat as unique
      canonical = entry.id;
      writtenUnique++;
    } else if (knownIds.has(entry.canonical)) {
      canonical = entry.canonical;
      writtenDuplicate++;
    } else {
      // Hallucinated canonical — fall back to self
      canonical = entry.id;
      writtenUnique++;
    }
    await setCachedJson(
      `${CACHE_PREFIX}${entry.id}`,
      { canonical } as CachedDedupDecision,
      DEDUP_TTL_S,
    );
  }));

  console.log(
    `[live-news:dedup] classified ${results.length} unknowns: ${writtenUnique} unique, ${writtenDuplicate} duplicate. ` +
    `(+ ${singletonsToCache.length} singleton-cached). ` +
    `Tokens: in=${result.inputTokens} out=${result.outputTokens}`,
  );
}
