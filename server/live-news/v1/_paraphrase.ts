/**
 * LLM-based paraphrasing for Live News items.
 *
 * Pipeline mirrors the location-enrichment design:
 *   1. BATCH GET cached summaries for every titleHash.
 *   2. Items with hits get `summary` populated immediately.
 *   3. Items still missing → fire-and-forget LLM batch call.
 *   4. LLM responses written to Redis with 30-day TTL.
 *
 * Cache layout:
 *   live-news:para:v1:{titleHash} → { summary } | UNPARAPHRASED_MARKER
 *
 * The LLM may decline to summarize when:
 *   - The RSS description is too sparse (paywall snippet, "Read more...").
 *   - The story has insufficient context to summarize without speculating.
 *   - The headline is non-news (a video clip, podcast intro, etc.).
 *
 * In all those cases we cache the negative marker so we never re-ask, and
 * iOS falls back to the source webpage view (existing behavior).
 */

import { callGemini } from '../../_shared/llm';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { LiveNewsItem } from './_normalize';

const SUMMARY_TTL_S = 3 * 24 * 60 * 60; // 3 days — project-wide max retention
const PARAPHRASE_BATCH_SIZE = 8;          // smaller than location — bigger inputs per item
const MAX_PARAPHRASE_PER_REQUEST = 40;
// v4 — bumped when we tightened the prompt from "100–180 word paragraph"
// down to "40–80 word plain-English short summary". Mixing old verbose
// entries with new concise ones in the same digest produces inconsistent
// UX, so we rotate the namespace to force a fresh generation pass.
// Backfill cost: ~150 cache misses × Gemini Flash Lite = ~$0.05 one-time.
const CACHE_PREFIX = 'live-news:para:v4:';

/** Sentinel — LLM declined to summarize this story. iOS falls back to source. */
const UNPARAPHRASED_MARKER = '__WM_LIVE_NEWS_UNPARAPHRASED__';

interface CachedSummary {
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutates `items` in place: items whose hash has a cached summary get
 * `summary` populated. Returns the sub-list still missing — those are the
 * candidates for LLM enrichment.
 */
export async function attachCachedSummaries(items: LiveNewsItem[]): Promise<LiveNewsItem[]> {
  if (items.length === 0) return [];

  const keys = items.map((it) => `${CACHE_PREFIX}${it.titleHash}`);
  const cache = await getCachedJsonBatch(keys);

  const missing: LiveNewsItem[] = [];
  let attached = 0;
  let negativeHits = 0;
  let malformed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const cached = cache.get(keys[i]!);
    if (cached === undefined) {
      missing.push(item);
      continue;
    }
    if (cached === UNPARAPHRASED_MARKER) {
      // LLM previously declined — leave summary null so iOS falls back to source.
      negativeHits++;
      continue;
    }
    const c = cached as CachedSummary;
    if (c && typeof c.summary === 'string' && c.summary.length > 0) {
      item.summary = c.summary;
      attached++;
    } else {
      // Cached but unexpected shape — note it so we can spot data corruption.
      malformed++;
    }
  }

  console.log(
    `[live-news:para] attachCachedSummaries: ${items.length} items, ` +
    `${attached} attached, ${negativeHits} negative, ${malformed} malformed, ${missing.length} missing. ` +
    `cache.size=${cache.size}`,
  );
  if (attached === 0 && cache.size > 0) {
    // Sanity check — log a sample so we can see what shape Redis actually returned.
    const firstKey = keys.find((k) => cache.has(k));
    if (firstKey) {
      const sample = cache.get(firstKey);
      console.warn(`[live-news:para] zero attachments despite ${cache.size} cache hits. sample key="${firstKey}" value=`, JSON.stringify(sample).slice(0, 300));
    }
  }

  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a neutral news summarizer for a multi-source live news feed.

The reader should grasp the story at a glance, with low effort. Write the way a thoughtful person would explain the news to a friend who hadn't heard it yet — clear, plain, and to the point.

Structure:
- Sentence 1: the key event (who, what, where, when).
- Sentences 2 to 3: the substance — how it happened, who is affected, what numbers / parties / timeline matter.
- Sentence 4: any context that helps the reader understand why this matters or what's next (only if the source supports it).

Length:
- 3 to 5 sentences total, 60 to 120 words. Aim for the middle of that range. Stop when the story is told — do not pad to fill the upper bound.

Language (most important):
- Plain English. Use everyday words instead of formal, technical, or bureaucratic ones:
    "agreed" not "concurred", "talks" not "negotiations" when interchangeable,
    "stopped" not "discontinued", "started" not "commenced", "tried" not "attempted",
    "asked" not "requested", "showed" not "demonstrated", "wants" not "seeks".
- Short, direct sentences. One idea per sentence.
- Active voice. Past or present tense, never future.
- No filler phrases ("It is important to note that...", "In a recent development..."), no rhetorical questions, no editorial spin.
- No source attribution ("According to Reuters..."), no quoted headlines.

Sourcing rules:
- Use ONLY facts in the input title and description. Do not invent specifics (numbers, names, quotes, dates) that are not in the input.
- You MAY add neutral background context drawn from common knowledge about named entities (e.g. what an agency is, where a location is). Do not stretch this into specific claims.

Sparse-input fallback:
- If the input description is genuinely too thin to support a paragraph (for example: just a video link, podcast intro, or one-line headline with no body), still produce the best possible 3 to 4 sentence summary using only what is supported. Do not hallucinate.
- Set summary to null only when the input is so devoid of newsworthy substance that any expansion would be speculation.

Output a JSON object with a "results" array, one entry per input id:
- id: string (matches input)
- summary: paragraph-length factual summary as plain text, or null

Return JSON ONLY. No prose outside the JSON, no markdown fences, no code fences.`;

interface LlmResultEntry {
  id: string;
  summary?: string | null;
}

function buildPrompt(items: LiveNewsItem[]): string {
  const inputs = items.map((it) => ({
    id: it.titleHash,
    title: it.title,
    source: it.source,
    description: it.rawDescription ?? '',
  }));
  return `Summarize these ${items.length} news items:\n\n${JSON.stringify(inputs, null, 2)}`;
}

/** Tolerant JSON parser — same approach as `_enrich.ts`. */
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

/** Validate + normalize a single LLM result entry into our cache shape. */
function toCachedSummary(entry: LlmResultEntry): CachedSummary | null {
  const summary = entry.summary;
  if (typeof summary !== 'string') return null;
  const trimmed = summary.trim();
  // Floor: 60 chars ≈ one short sentence. Below that the LLM probably
  // echoed the title back instead of writing something new — caching it
  // would mean shipping a "title twice" experience to users.
  if (trimmed.length < 60) return null;
  // Ceiling: spec is 40–80 words ≈ 250–500 chars. 1 200 gives plenty
  // of headroom for occasionally longer outputs without letting a
  // runaway response leak into the digest payload.
  if (trimmed.length > 1200) return null;
  return { summary: trimmed };
}

async function paraphraseBatch(batch: LiveNewsItem[]): Promise<void> {
  if (batch.length === 0) return;

  // Filter out items with no source description — they'd produce hallucinated
  // or trivially-rephrased output, neither of which is valuable. Items
  // dropped here get the UNPARAPHRASED_MARKER so iOS falls back to source.
  const withDesc = batch.filter((it) => (it.rawDescription ?? '').length >= 60);
  const sparse = batch.filter((it) => (it.rawDescription ?? '').length < 60);

  await Promise.all(sparse.map(async (item) => {
    const key = `${CACHE_PREFIX}${item.titleHash}`;
    await setCachedJson(key, UNPARAPHRASED_MARKER, SUMMARY_TTL_S);
  }));

  if (withDesc.length === 0) {
    console.log(`[live-news:para] All ${batch.length} items had sparse descriptions — skipping LLM, marked unparaphrasable`);
    return;
  }

  const result = await callGemini({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(withDesc),
    // 6 000 token cap for batch of 8 = 750 tokens / item.
    // Paragraph output is ~250–350 tokens per item with Claude;
    // Gemini's pretty-printed JSON inflates this to ~400–500 tokens.
    // Bumped from 4 000 to leave headroom for occasional longer summaries
    // and prevent the truncation we saw on the first deploy.
    maxTokens: 6000,
    temperature: 0.3,
    // Reuse the optional separate-key pattern for billing-separation
    // parity with the Claude pipeline. Falls back to GEMINI_API_KEY if
    // the dedicated key isn't configured (it usually isn't, since
    // Gemini's costs are low enough that splitting billing matters less).
    apiKeyEnv: 'GEMINI_API_KEY_PARAPHRASE',
    jsonMode: true,
    caller: 'live-news:paraphrase', // TEMP (Helicone)
  });

  if (!result) {
    console.warn(`[live-news:para] LLM call returned null for batch of ${withDesc.length}`);
    return;
  }

  // Gemini's JSON mode is loose about output shape: it sometimes returns
  // the wrapped object we asked for (`{ results: [...] }`), other times
  // it returns the bare array (`[...]`) when the prompt was about a list.
  // Accept both.
  const parsed = extractJson(result.content);
  const results: LlmResultEntry[] | null =
    Array.isArray(parsed) ? (parsed as LlmResultEntry[])
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)
        ? (parsed as { results: LlmResultEntry[] }).results
        : null);
  if (!results) {
    console.warn(`[live-news:para] Failed to parse LLM JSON output:`, result.content.slice(0, 200));
    return;
  }

  const byId = new Map<string, LlmResultEntry>();
  for (const entry of results) {
    if (entry?.id) byId.set(entry.id, entry);
  }

  let written = 0;
  let unparaphrased = 0;

  await Promise.all(withDesc.map(async (item) => {
    const entry = byId.get(item.titleHash);
    const key = `${CACHE_PREFIX}${item.titleHash}`;
    const cached = entry ? toCachedSummary(entry) : null;
    if (cached) {
      await setCachedJson(key, cached, SUMMARY_TTL_S);
      written++;
    } else {
      // LLM returned null/garbage for this item — cache the negative so we
      // don't re-ask. iOS falls back to the source webpage.
      await setCachedJson(key, UNPARAPHRASED_MARKER, SUMMARY_TTL_S);
      unparaphrased++;
    }
  }));

  console.log(
    `[live-news:para] LLM paraphrased ${written}/${withDesc.length} items (${unparaphrased} unparaphrasable, ${sparse.length} sparse). ` +
    `Tokens: in=${result.inputTokens} out=${result.outputTokens}`,
  );
}

/**
 * Public: paraphrase all missing items, in batches.
 *
 * Caller fires-and-forgets so the iOS request returns immediately. Next
 * poll's BATCH GET picks up whatever finished.
 */
export async function paraphraseMissingSummaries(missing: LiveNewsItem[]): Promise<void> {
  if (missing.length === 0) return;

  const slice = missing.slice(0, MAX_PARAPHRASE_PER_REQUEST);
  if (slice.length < missing.length) {
    console.log(`[live-news:para] Capping batch at ${MAX_PARAPHRASE_PER_REQUEST}/${missing.length} items`);
  }

  for (let i = 0; i < slice.length; i += PARAPHRASE_BATCH_SIZE) {
    const batch = slice.slice(i, i + PARAPHRASE_BATCH_SIZE);
    try {
      await paraphraseBatch(batch);
    } catch (err) {
      console.warn('[live-news:para] batch failed:', err instanceof Error ? err.message : err);
    }
  }
}
