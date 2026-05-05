/**
 * Location enrichment for Live News items.
 *
 * The pipeline is intentionally **non-blocking**: the HTTP handler returns
 * the digest immediately, and enrichment runs in the background, writing
 * results into Redis. The next poll's BATCH GET picks up whatever finished.
 *
 * Cache layout:
 *   live-news:loc:v1:{titleHash} → {
 *     latitude, longitude, city, country, confidence, locationName
 *   }
 *
 * TTL: 30 days. Long enough that we effectively never re-enrich the same
 * headline; short enough that prompt/model upgrades roll over naturally.
 *
 * The LLM prompt instructs Claude to **always** produce a best-guess
 * location even when uncertain — confidence drops instead of returning
 * null. This matches the product brief: "we can push the model to come
 * up with some not accurate data, it would also work, doesn't hurt".
 */

import { callGemini } from '../../_shared/llm';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { LiveNewsItem } from './_normalize';

/** Persistent cache TTL for enriched locations — effectively forever. */
const LOCATION_TTL_S = 30 * 24 * 60 * 60; // 30 days
/** How many items to send to the LLM in one call. */
const ENRICH_BATCH_SIZE = 20;
/** Hard cap so a giant fan-out doesn't burn through tokens. */
const MAX_ENRICH_PER_REQUEST = 60;

const CACHE_PREFIX = 'live-news:loc:v1:';

interface CachedLocation {
  latitude: number;
  longitude: number;
  city: string | null;
  country: string | null;
  confidence: number;
  locationName: string | null;
}

/** Sentinel written when the LLM truly can't place a story (rare). */
const UNLOCATED_MARKER = '__WM_LIVE_NEWS_UNLOCATED__';

// ─────────────────────────────────────────────────────────────────────────────
// Read path: attach cached locations to items
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutates `items` in place: items whose hash has a cached location get
 * `location`/`locationName`/`country`/`confidence` populated. Returns the
 * sub-list that's still missing — those are the candidates for enrichment.
 */
export async function attachCachedLocations(items: LiveNewsItem[]): Promise<LiveNewsItem[]> {
  if (items.length === 0) return [];

  const keys = items.map((it) => `${CACHE_PREFIX}${it.titleHash}`);
  const cache = await getCachedJsonBatch(keys);

  const missing: LiveNewsItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const cached = cache.get(keys[i]!);
    if (cached === undefined) {
      missing.push(item);
      continue;
    }
    if (cached === UNLOCATED_MARKER) {
      // Negative cache — LLM previously couldn't locate. Skip without re-asking.
      continue;
    }
    const loc = cached as CachedLocation;
    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
      item.location = { latitude: loc.latitude, longitude: loc.longitude };
      item.locationName = loc.locationName ?? loc.city ?? null;
      item.country = loc.country ?? null;
      item.confidence = loc.confidence ?? 0.5;
    }
  }

  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path: LLM enrichment + Redis cache write
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a geographic location classifier for international news headlines.

For each headline you receive, identify where the news is HAPPENING (not where the outlet is based).

Rules:
- ALWAYS return a best-guess location, even when uncertain. Lower the confidence rather than returning null.
- Resolve indirect references: "the Kremlin" → Moscow, Russia; "Pentagon" → Arlington, VA, US; "the Élysée" → Paris, France.
- Disambiguate by context: "Springfield" can mean IL, MA, MO; "Sydney" is usually Australia but can be Nova Scotia.
- For multi-location stories (e.g. sanctions, summits, conflicts), pick the location most central to the news event itself — usually where the action is, not where it was announced from.
- For purely abstract/global stories (e.g. "Global inflation rises"), pick the country centroid most relevant to the headline, or fall back to a sensible regional centroid.
- Confidence: 0.9+ when a specific city is named, 0.6–0.8 for inferred city, 0.3–0.5 for country-level guess, 0.1–0.3 for very speculative.
- Set lat/lng to null ONLY if the headline has no geographic component at all (e.g. a tech-product review or generic op-ed). This should be rare.

Output format: a JSON object with a "results" array. Each entry must include:
- id: string (matches input)
- city: string or null
- country: ISO 3166-1 alpha-2 code (uppercase) or null
- locationName: human-readable label like "Kyiv, Ukraine" or "Beijing, China" — short, suitable for a map detail row
- lat: number or null
- lng: number or null
- confidence: number between 0 and 1

Return JSON ONLY. No prose, no markdown, no code fences.`;

interface LlmResultEntry {
  id: string;
  city?: string | null;
  country?: string | null;
  locationName?: string | null;
  lat?: number | null;
  lng?: number | null;
  confidence?: number;
}

function buildPrompt(items: LiveNewsItem[]): string {
  const headlines = items.map((it) => ({
    id: it.titleHash,
    title: it.title,
    source: it.source,
  }));
  return `Classify the location of these ${items.length} headlines:\n\n${JSON.stringify(headlines, null, 2)}`;
}

/**
 * Tolerant JSON parser — Claude is good about JSON-only outputs, but on the
 * off chance it wraps in code fences or adds a leading/trailing word, we
 * extract the first balanced `{...}` block.
 */
function extractJson(text: string): unknown | null {
  // Fast path
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Strip code fences
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  // Find first balanced JSON object
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

/**
 * Coerce a value that should be numeric. Gemini sometimes returns lat/lng
 * as strings (`"40.7128"`) despite the prompt asking for numbers — Claude
 * was strict about types, Gemini is loose. Accept both shapes.
 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Validate + clamp a single LLM result entry into our cache shape. */
function toCachedLocation(entry: LlmResultEntry): CachedLocation | null {
  const lat = toFiniteNumber(entry.lat);
  const lng = toFiniteNumber(entry.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const confRaw = toFiniteNumber(entry.confidence);
  const confidence = confRaw !== null ? Math.min(1, Math.max(0, confRaw)) : 0.5;
  return {
    latitude: lat,
    longitude: lng,
    city: entry.city ?? null,
    country: entry.country ?? null,
    confidence,
    locationName: entry.locationName ?? entry.city ?? null,
  };
}

async function enrichBatch(batch: LiveNewsItem[]): Promise<void> {
  if (batch.length === 0) return;

  const result = await callGemini({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(batch),
    // 8 000 token cap for batch of 20 = 400 tokens / item.
    // Each item emits ~150 tokens with Gemini's pretty-printed JSON
    // (longer than Claude's output for the same prompt — Gemini's
    // tokenizer counts whitespace more aggressively). 2 500 was the
    // previous Claude-tuned cap; raising it eliminates the
    // "Failed to parse" truncation we hit after the model swap.
    maxTokens: 8000,
    temperature: 0.2,
    // Gemini's JSON mode guarantees a syntactically valid response,
    // eliminating the "wrapped in code fences" failure mode.
    jsonMode: true,
  });

  if (!result) {
    console.warn(`[live-news:enrich] LLM call returned null for batch of ${batch.length}`);
    return;
  }

  // Gemini's JSON mode is loose about output shape — accept both the
  // wrapped object (`{ results: [...] }`) and the bare array (`[...]`).
  // See `_paraphrase.ts` for the same fix and the war story behind it.
  const parsed = extractJson(result.content);
  const results: LlmResultEntry[] | null =
    Array.isArray(parsed) ? (parsed as LlmResultEntry[])
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)
        ? (parsed as { results: LlmResultEntry[] }).results
        : null);
  if (!results) {
    console.warn(`[live-news:enrich] Failed to parse LLM JSON output:`, result.content.slice(0, 200));
    return;
  }

  // Build id → entry map for O(1) lookup
  const byId = new Map<string, LlmResultEntry>();
  for (const entry of results) {
    if (entry?.id) byId.set(entry.id, entry);
  }

  let written = 0;
  let unlocated = 0;

  // Write each item's result to Redis (parallel, fire-and-forget per item)
  await Promise.all(batch.map(async (item) => {
    const entry = byId.get(item.titleHash);
    if (!entry) return;
    const cached = toCachedLocation(entry);
    const key = `${CACHE_PREFIX}${item.titleHash}`;
    if (cached) {
      await setCachedJson(key, cached, LOCATION_TTL_S);
      written++;
    } else {
      // Genuine no-location case (rare). Cache the negative marker so we
      // don't ask again — the prompt rules out most stories from this branch.
      await setCachedJson(key, UNLOCATED_MARKER, LOCATION_TTL_S);
      unlocated++;
    }
  }));

  console.log(
    `[live-news:enrich] LLM enriched ${written}/${batch.length} items (${unlocated} unlocated). ` +
    `Tokens: in=${result.inputTokens} out=${result.outputTokens}`,
  );

  // Diagnostic: if EVERY item failed validation despite Gemini producing
  // output, dump the first parsed entry so we can see what shape it
  // actually returned. Catches regressions where Gemini emits new field
  // types (string lat/lng, alpha-3 country codes, etc.) that we'd
  // otherwise silently negative-cache forever.
  if (written === 0 && batch.length > 0 && results.length > 0) {
    const sample = results[0];
    console.warn(
      `[live-news:enrich] zero successes — sample entry shape:`,
      JSON.stringify(sample).slice(0, 400),
    );
  }
}

/**
 * Public: enrich all missing items, in batches.
 *
 * Caller decides whether to await this (synchronous block) or fire-and-forget
 * (background fill). The handler uses the latter so the iOS request returns
 * immediately and the next 30 s poll picks up the fresh locations.
 */
export async function enrichMissingLocations(missing: LiveNewsItem[]): Promise<void> {
  if (missing.length === 0) return;

  const slice = missing.slice(0, MAX_ENRICH_PER_REQUEST);
  if (slice.length < missing.length) {
    console.log(`[live-news:enrich] Capping batch at ${MAX_ENRICH_PER_REQUEST}/${missing.length} items`);
  }

  for (let i = 0; i < slice.length; i += ENRICH_BATCH_SIZE) {
    const batch = slice.slice(i, i + ENRICH_BATCH_SIZE);
    try {
      await enrichBatch(batch);
    } catch (err) {
      console.warn('[live-news:enrich] batch failed:', err instanceof Error ? err.message : err);
    }
  }
}
