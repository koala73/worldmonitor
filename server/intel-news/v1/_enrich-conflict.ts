/**
 * GDELT conflict-topic LLM enrichment — produces location + summary
 * for each conflict article so they reach feature parity with live-news
 * conflict items in the iOS conflict feed and map.
 *
 * # Why a separate file from `_enrich-combined.ts`
 *
 * The live-news enrichment is built around `LiveNewsItem` (which carries
 * a SHA-256 `titleHash` from the RSS pipeline) and asks the LLM to
 * classify `isConflict`. GDELT items don't have a titleHash, and we
 * already know they're conflict (they came from the conflict topic),
 * so reusing that pipeline would force adapter logic + a now-redundant
 * classification step. Smaller, dedicated file is clearer.
 *
 * # Cache layout
 *
 * `intel-news:enrich-conflict:v1:<idHash>` — one entry per item.
 * 30-day TTL — same as live-news enrichment. Item ids are derived from
 * a normalized-title SHA-256, so the same wire story gets the same id
 * across cycles even when GDELT serves slightly different timestamps.
 *
 * # Pipeline
 *
 * Read path: pre-fetch all cache entries via batch GET, attach to items
 *   that have a hit.
 * Write path: fire-and-forget LLM call for misses. Same Gemini-then-Claude
 *   fallback pattern as live-news. Results write back to cache for the
 *   next cycle to pick up.
 */

import { callGemini, callClaude } from '../../_shared/llm';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { IntelNewsItem } from './list-headlines';

const CACHE_PREFIX = 'intel-news:enrich-conflict:v1:';
const ENRICHMENT_TTL_S = 3 * 24 * 60 * 60;        // 3 days — project-wide max
const UNENRICHABLE_MARKER = '__WM_INTEL_CONFLICT_UNENRICHABLE__';
const MAX_BATCH_SIZE = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Cached enrichment payload — what we store per article. */
export interface ConflictEnrichment {
  summary: string;
  latitude: number;
  longitude: number;
  locationName: string;
  country: string;
  confidence: number;
}

interface LlmResultEntry {
  id?: string;
  summary?: string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  locationName?: string | null;
  country?: string | null;
  confidence?: number | string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Item ID — stable hash of normalized title
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a stable id for a GDELT item from its title. Uses Web Crypto
 * (available in Vercel Edge runtime). Deterministic — same title always
 * gives same id, even across cycles when GDELT timestamps drift slightly.
 */
export async function intelItemId(title: string): Promise<string> {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function validateEntry(entry: LlmResultEntry): ConflictEnrichment | null {
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
  if (summary.length < 30 || summary.length > 2500) return null;

  const lat = toFiniteNumber(entry.lat);
  const lng = toFiniteNumber(entry.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const country = typeof entry.country === 'string' ? entry.country.trim().toUpperCase() : '';
  if (country.length === 0 || country.length > 3) return null;

  const locationName = typeof entry.locationName === 'string' ? entry.locationName.trim() : '';
  if (locationName.length === 0) return null;

  const confRaw = toFiniteNumber(entry.confidence);
  const confidence = confRaw !== null ? Math.min(1, Math.max(0, confRaw)) : 0.5;

  return { summary, latitude: lat, longitude: lng, locationName, country, confidence };
}

function extractJson(text: string): unknown | null {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  return null;
}

function extractResultsArray(parsed: unknown): LlmResultEntry[] | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { results?: unknown };
  if (!Array.isArray(obj.results)) return null;
  return obj.results as LlmResultEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM prompt — focused on location + summary, no classification step
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a news enrichment service for armed-conflict articles. For each item return a 1-2 paragraph plain-English summary AND a location best-guess.

Summary (the "summary" field):
- 1 to 2 paragraphs, plain English, ~150-250 words total.
- Paragraph 1: who, what, where, when of the conflict event.
- Paragraph 2 (optional): broader context — why this matters, recent escalation pattern, casualties.
- Use blank line (\\n\\n) between paragraphs.
- Active voice, short sentences. No filler. No source attribution.
- Use ONLY facts implied by the title. You MAY add neutral background drawn from common knowledge about named entities (countries, factions, ongoing conflicts).

Location (the "lat", "lng", "locationName", "country", "confidence" fields):
- Where the event is HAPPENING — not the outlet's home city.
- ALWAYS return a best-guess location. Lower confidence rather than skipping.
- "country" MUST be a 2-letter ISO 3166-1 alpha-2 code in UPPERCASE.
- For genuinely-global stories: use "ZZ" + the most relevant country centroid.
- Confidence: 0.9+ for named city, 0.6-0.8 for inferred city, 0.3-0.5 country-level, 0.1-0.3 speculative.

Output format:
{
  "results": [
    {
      "id": "<input id>",
      "summary": "<1-2 paragraph summary>",
      "lat": <number>,
      "lng": <number>,
      "locationName": "<e.g. 'Gaza City, Palestine'>",
      "country": "<2-letter alpha-2>",
      "confidence": <0..1>
    }
  ]
}

Return JSON ONLY. No prose, no markdown fences.`;

interface PromptInput {
  id: string;
  title: string;
  source: string;
}

function buildPrompt(inputs: PromptInput[]): string {
  return `Enrich these ${inputs.length} conflict articles:\n\n${JSON.stringify(inputs)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM calls
// ─────────────────────────────────────────────────────────────────────────────

async function callGeminiBatch(inputs: PromptInput[]): Promise<Map<string, ConflictEnrichment>> {
  const result = await callGemini({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(inputs),
    maxTokens: 6000,
    temperature: 0.2,
    jsonMode: true,
    apiKeyEnv: 'GEMINI_API_KEY_ENRICHMENT',
    caller: 'intel-news:enrich-conflict', // TEMP (Helicone)
  });
  if (!result) return new Map();

  const parsed = extractJson(result.content);
  const results = extractResultsArray(parsed);
  if (!results) {
    console.warn(`[intel-news:conflict-enrich] Gemini parse failure:`, result.content.slice(0, 200));
    return new Map();
  }

  const out = new Map<string, ConflictEnrichment>();
  for (const entry of results) {
    if (!entry?.id) continue;
    const v = validateEntry(entry);
    if (v) out.set(entry.id, v);
  }
  console.log(
    `[intel-news:conflict-enrich] Gemini: ${out.size}/${inputs.length} valid · ` +
    `tokens in=${result.inputTokens} out=${result.outputTokens}`,
  );
  return out;
}

async function callClaudeFallback(inputs: PromptInput[]): Promise<Map<string, ConflictEnrichment>> {
  if (inputs.length === 0) return new Map();
  const result = await callClaude({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(inputs),
    maxTokens: 4000,
    temperature: 0.2,
    apiKeyEnv: 'ANTHROPIC_API_KEY_PARAPHRASE',
    caller: 'intel-news:enrich-conflict-fallback', // TEMP (Helicone)
  });
  if (!result) return new Map();

  const parsed = extractJson(result.content);
  const results = extractResultsArray(parsed);
  if (!results) return new Map();

  const out = new Map<string, ConflictEnrichment>();
  for (const entry of results) {
    if (!entry?.id) continue;
    const v = validateEntry(entry);
    if (v) out.set(entry.id, v);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public read-path: attach cached enrichment to items
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutates each item with cached enrichment (`enrichment` field added).
 * Returns the items still missing — call enrichGdeltConflictAsync on them
 * fire-and-forget to populate cache for the next cycle.
 */
export async function attachGdeltEnrichment(
  items: Array<IntelNewsItem & { id?: string; enrichment?: ConflictEnrichment | null }>,
): Promise<Array<IntelNewsItem & { id: string }>> {
  if (items.length === 0) return [];

  // Compute stable ids for every item
  await Promise.all(items.map(async (it) => {
    if (!it.id) it.id = await intelItemId(it.title);
  }));

  const ids = items.map((it) => it.id!) as string[];
  const keys = ids.map((id) => `${CACHE_PREFIX}${id}`);
  const cache = await getCachedJsonBatch(keys);

  const missing: Array<IntelNewsItem & { id: string }> = [];
  let attached = 0;
  let negativeHits = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const cached = cache.get(keys[i]!);
    if (cached === undefined) {
      missing.push(item as IntelNewsItem & { id: string });
      continue;
    }
    if (cached === UNENRICHABLE_MARKER) {
      negativeHits++;
      continue;
    }
    const e = cached as ConflictEnrichment;
    if (e && typeof e.summary === 'string' && typeof e.latitude === 'number') {
      item.enrichment = e;
      attached++;
    }
  }

  console.log(
    `[intel-news:conflict-enrich] attach: ${items.length} items, ` +
    `${attached} attached, ${negativeHits} negative, ${missing.length} missing`,
  );

  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public write-path: fire-and-forget enrich missing items
// ─────────────────────────────────────────────────────────────────────────────

export async function enrichGdeltConflictAsync(
  items: Array<IntelNewsItem & { id: string }>,
): Promise<void> {
  if (items.length === 0) return;

  // Slice to a max batch — keeps per-call token budget bounded.
  const batches: Array<Array<IntelNewsItem & { id: string }>> = [];
  for (let i = 0; i < items.length; i += MAX_BATCH_SIZE) {
    batches.push(items.slice(i, i + MAX_BATCH_SIZE));
  }

  for (const batch of batches) {
    const inputs: PromptInput[] = batch.map((it) => ({
      id: it.id,
      title: it.title,
      source: it.source,
    }));

    const geminiResults = await callGeminiBatch(inputs);
    const failedItems = batch.filter((it) => !geminiResults.has(it.id));

    let claudeResults = new Map<string, ConflictEnrichment>();
    if (failedItems.length > 0) {
      const failedInputs: PromptInput[] = failedItems.map((it) => ({
        id: it.id,
        title: it.title,
        source: it.source,
      }));
      claudeResults = await callClaudeFallback(failedInputs);
    }

    let written = 0;
    let unenrichable = 0;

    await Promise.all(batch.map(async (item) => {
      const result = geminiResults.get(item.id) ?? claudeResults.get(item.id);
      const key = `${CACHE_PREFIX}${item.id}`;
      if (result) {
        await setCachedJson(key, result, ENRICHMENT_TTL_S);
        written++;
      } else {
        // Both LLMs failed — mark unenrichable so we don't retry every cycle.
        await setCachedJson(key, UNENRICHABLE_MARKER, ENRICHMENT_TTL_S);
        unenrichable++;
      }
    }));

    console.log(
      `[intel-news:conflict-enrich] batch done: ${written} written, ${unenrichable} unenrichable`,
    );
  }
}
