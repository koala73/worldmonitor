/**
 * `GET /api/intel-news/v1/enrich` — AI-summary + region enrichment cron.
 *
 * Two enrichment paths in the same handler:
 *
 *   1. **Per-topic accumulators** — every 15 min, find items missing
 *      summary/region across the 9 non-conflict topics and enrich them.
 *
 *   2. **Conflict-archive (GDELT bucket)** — same enrichment but for items
 *      `refresh.ts` writes to `conflict:archive:v1:gdelt`. Conflict items
 *      additionally extract country + lat/lng for the iOS map pin.
 *
 * Single LLM call returns:
 *   { summary, region, country?, lat?, lng? }
 *
 * # Shared enrichment cache
 *
 * `enrichment-cache:v1:<sha256(link)>` — 30-day TTL. Before the LLM call,
 * we check this cache and reuse a prior result if the same URL has already
 * been enriched. Saves cost when the same article appears in multiple
 * pipelines (e.g. live-news + GDELT both index the same Reuters story).
 *
 * # Self-contained
 *
 * Same "no relative imports" pattern as refresh.ts. Redis, LLM calls,
 * HTML→text extraction, conflict-archive read/write are all inlined.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';

export const config = {
  // Pro-plan ceiling. Cron normally only fires ~150 enrichments per call
  // (one batch's newly-added items); 280 s of budget gives the worker pool
  // plenty of room. Manual catch-up runs after a backfill (~14 k items)
  // need many calls to drain the queue.
  maxDuration: 300,
};

// ─────────────────────────────────────────────────────────────────────────────
// Topics — must match refresh.ts so accumulator keys line up.
// ─────────────────────────────────────────────────────────────────────────────

// `conflict` is intentionally absent — conflict items live in the
// conflict-archive (gdelt key), not the per-topic accumulator. See the
// dedicated processing path below.
const TOPIC_IDS = [
  'cyber', 'military', 'nuclear', 'sanctions', 'intelligence',
  'maritime', 'business', 'scitech', 'entertainment',
] as const;

const accumulatorKey = (id: string): string => `intel-news:topic:v6:${id}:accumulator`;

const ACCUMULATOR_TTL_S = 3 * 24 * 60 * 60; // 3-day project max

// Conflict-archive (GDELT bucket) — must match the keys in
// `server/conflict-archive/v1/_store.ts`. iOS reads this archive's
// merged contents for the CONFLICT chip + map pins.
const CONFLICT_ARCHIVE_GDELT_KEY = 'conflict:archive:v1:gdelt';
// Conflict-archive (World News bucket) — populated by the v2 refresh
// cron at `/api/conflict-archive/v2/refresh-worldnews`. Same item
// shape as the GDELT bucket plus `origin: 'worldnews'`. Enrichment
// fills summary/region/country/locationName/lat/lng so iOS can pin
// these on the map alongside the GDELT-sourced conflict items.
const CONFLICT_ARCHIVE_WN_KEY = 'conflict:archive:wn:v1';
const CONFLICT_ARCHIVE_TTL_S = 3 * 24 * 60 * 60; // 3-day project max

// Live-news v3 (World News bucket) — populated by the search-news cron
// at `/api/live-news/v3/refresh-worldnews`. Enrichment fills
// summary + region + country (and location/locationName when the
// article happens to be locatable). The shape matches ConflictArchiveItem
// for writeback purposes — `location` is `{latitude, longitude} | null`.
const LIVE_NEWS_WN_KEY = 'live-news:wn:v1:digest';
const LIVE_NEWS_TTL_S = 3 * 24 * 60 * 60; // 3-day project max

// Live-news v4 + conflict-archive v3 (Webz.io buckets) — same writeback
// shape as the worldnews buckets above, but their items carry string
// ids (Webz uuids) instead of numbers and the upstream is licensed
// under different terms. License-wise we never substitute an LLM
// summary for the API's own.
const LIVE_NEWS_WEBZ_KEY = 'live-news:webz:v1:digest';
const CONFLICT_ARCHIVE_WEBZ_KEY = 'conflict:archive:webz:v1';

// Live-news v6 (RSS + Gemini embeddings — self-hosted clustering).
// Wire `summary` is the longest plaintext RSS description across
// cluster members, set at refresh time. We never substitute an LLM
// summary on top of that — skipSummary=true, identical contract
// to the licensed-feed buckets above. The location-only LLM pass
// still runs to fill region / country / locationName / lat / lng /
// isConflict for the map + CONFLICT chip.
const LIVE_NEWS_RSE_KEY = 'live-news:v6:digest';
const CONFLICT_ARCHIVE_RSE_KEY = 'conflict:archive:rse:v1';

// Live-news v5 + conflict-archive v4 (Newscatcher buckets). Same shape
// as webz/worldnews; ids are Newscatcher cluster_ids. Newscatcher ships
// `nlp.summary` as part of its licensed payload — we keep that, the
// enrich cron only fills region/country/locationName/lat/lng.
const LIVE_NEWS_NC_KEY = 'live-news:nc:v1:digest';
const CONFLICT_ARCHIVE_NC_KEY = 'conflict:archive:nc:v1';

// Shared enrichment cache — keyed by sha256(link). Both pipelines read /
// write it, so a URL enriched once in either pipeline is reused by the
// other instead of re-paying the LLM call.
//
// Version bump: v1 → v2 invalidates all prior cached enrichments so the
// new 3-paragraph + locationName prompt re-enriches everything. Bumps
// total LLM cost ~$0.30 one-time as ~2800 existing items refresh.
const ENRICHMENT_CACHE_KEY = (link: string): string =>
  `enrichment-cache:v2:${createHash('sha256').update(link).digest('hex')}`;
const ENRICHMENT_CACHE_TTL_S = 3 * 24 * 60 * 60; // 3-day project max

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

const ARTICLE_FETCH_TIMEOUT_MS = 5_000;
const LLM_TIMEOUT_MS = 25_000;
// Concurrency picked to roughly maximize throughput without overloading
// downstream rate limits:
//   • Gemini Flash Lite paid tier: thousands of requests/min — at 40
//     concurrent × ~3-4 s avg = ~10-13 RPS = ~700 RPM, well below limits
//   • Article fetches: spread across many distinct domains
//   • Vercel function memory: 40 in-flight × ~10 KB = ~400 KB — negligible
const CONCURRENCY = 40;

// Soft ceiling — leaves ~20 s for the final Redis writes and JSON response
// under the 300 s `maxDuration`. Past this point new tasks are skipped
// (left in the accumulator for the next enrich pass).
const BUDGET_MS = 280_000;

const ARTICLE_BODY_MAX_CHARS = 6_000;
// 3-paragraph minimum (200-400 words → 1200-2400 chars). 600 floor allows
// for a short LLM that still produced 3 short paragraphs without rejecting
// the response. 4000 ceiling allows for 5 long paragraphs without
// rejecting (rare but valid for complex stories).
const SUMMARY_MIN_LEN = 600;
const SUMMARY_MAX_LEN = 4_000;

// ─────────────────────────────────────────────────────────────────────────────
// Region taxonomy — must match iOS `FeedRegion` rawValue strings.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_REGIONS = new Set<string>([
  'us', 'canada', 'latin_america', 'europe', 'middle_east',
  'africa', 'asia', 'oceania',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes — must match refresh.ts / list-headlines.ts.
// ─────────────────────────────────────────────────────────────────────────────

interface IntelNewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  topic: string;
  tone: number | null;
  sources?: Array<{ source: string; title: string; link: string; publishedAt: number }>;
  summary?: string;
  region?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

// Shape of `conflict:archive:v1:gdelt` entries — must match
// `server/conflict-archive/v1/_store.ts`'s `ConflictArchiveItem`.
interface ConflictArchiveItem {
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  summary: string | null;
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  country: string | null;
  region?: string | null;
  sources: Array<{ source: string; title: string; link: string; publishedAt: number }> | null;
  origin: 'live-news' | 'gdelt' | 'worldnews' | 'webz' | 'newscatcher' | 'rse';
}

// LLM-returned structured payload. Stored verbatim in the shared
// enrichment cache so downstream pipelines can reuse it.
interface EnrichmentPayload {
  summary: string;
  region: string;
  country?: string;
  /** City or named location for the incident, e.g. "Tel Aviv", "Khartoum",
   *  "Donetsk Oblast". Conflict items only — used as the typeLabel in
   *  the iOS feed row (the "TEL AVIV" header above the headline). */
  locationName?: string;
  lat?: number;
  lng?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash Redis REST helpers
// ─────────────────────────────────────────────────────────────────────────────

function getRedisCreds(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Read a JSON value from Upstash, handling both representations the REST
 * API may return: a string (which needs `JSON.parse`) or an already-parsed
 * object/array (when Upstash inferred the body's `application/json` type
 * at write time). We previously assumed the string form unconditionally,
 * which silently returned `null` for any key whose write happened to
 * round-trip as an object — that's why the new live-news + conflict-wn
 * buckets read as empty even though the keys had data.
 *
 * Also recognises the gzip envelope (`{ __wmgz: 1, d: <base64> }`) emitted
 * by `setCachedJson` when `WM_REDIS_COMPRESSION=1` is set. We don't have
 * gunzip wired up in this Node cron (matches the rest of the inlined
 * pattern), so we just bail out gracefully if we see one — the next
 * enrich tick re-reads after refresh has overwritten with a smaller
 * (uncompressed) payload, or the user disables compression for this key
 * family.
 */
async function redisGet<T>(key: string): Promise<T | null> {
  const creds = getRedisCreds();
  if (!creds) return null;
  try {
    const resp = await fetch(`${creds.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result: unknown };
    const raw = data.result;
    if (raw === undefined || raw === null) return null;

    let parsed: unknown;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { return null; }
    } else {
      parsed = raw;
    }

    // Gzip envelope — written when WM_REDIS_COMPRESSION=1 and payload > 1 KB.
    // Same logic as server/_shared/redis.ts's decodeFromStorage. We inline
    // it here because this cron is self-contained (Node runtime, no relative
    // imports). DecompressionStream is a Web Streams API available in
    // Node 18+ / Vercel Node runtime.
    if (
      typeof parsed === 'object' && parsed !== null
      && '__wmgz' in parsed
      && typeof (parsed as { d?: unknown }).d === 'string'
    ) {
      try {
        const b64 = (parsed as unknown as { d: string }).d;
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const stream = new Response(new Blob([bytes as BlobPart]))
          .body!.pipeThrough(new DecompressionStream('gzip'));
        const inner = await new Response(stream).text();
        return JSON.parse(inner) as T;
      } catch (err) {
        console.warn(`[intel-news:enrich] gzip decode failed for "${key}":`, err instanceof Error ? err.message : err);
        return null;
      }
    }

    return parsed as T;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const creds = getRedisCreds();
  if (!creds) return;
  try {
    const resp = await fetch(`${creds.url}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[intel-news:enrich] redis SET failed for "${key}":`, body.slice(0, 150));
    }
  } catch (err) {
    console.warn(`[intel-news:enrich] redis SET threw for "${key}":`, (err as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML → plain text — minimal regex extractor.
// ─────────────────────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchArticleBody(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitorBot/1.0; +https://worldmonitor.news)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('html')) return null;
    const html = await resp.text();
    const text = htmlToText(html);
    if (text.length < 100) return null;
    return text.slice(0, ARTICLE_BODY_MAX_CHARS);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM calls — Gemini Flash primary with JSON mode, Claude Haiku fallback.
//
// TEMP (Helicone): hardcoded proxy routing for the half-day cost-debug
// session. This file uses its own fetch (rather than _shared/llm.ts) because
// it runs in the Node.js runtime and has different module constraints. To
// revert: delete the HELICONE_* constants and the URL/header swaps below;
// rotate the key in helicone.ai/developer.
// ─────────────────────────────────────────────────────────────────────────────

const HELICONE_API_KEY = 'sk-helicone-ztvsi6a-azoevlq-rob3yty-5aj2cca';
const HELICONE_ENABLED = HELICONE_API_KEY.length > 0;
const HELICONE_CALLER = 'intel-news:enrich-cron';

async function callGeminiJSON(system: string, prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = 'gemini-2.5-flash-lite';
  const apiBase = HELICONE_ENABLED
    ? 'https://gateway.helicone.ai/v1beta'
    : 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${apiBase}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(HELICONE_ENABLED ? {
          'Helicone-Auth': `Bearer ${HELICONE_API_KEY}`,
          'Helicone-Target-URL': 'https://generativelanguage.googleapis.com',
          'Helicone-Property-Caller': HELICONE_CALLER,
        } : {}),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        system_instruction: { parts: [{ text: system }] },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2_000,
          // Forces a syntactically valid JSON response — eliminates the
          // "wrapped in code fences" failure mode of free-form prompts.
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '').join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

async function callClaudeJSON(system: string, prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const url = HELICONE_ENABLED
    ? 'https://anthropic.helicone.ai/v1/messages'
    : 'https://api.anthropic.com/v1/messages';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(HELICONE_ENABLED ? {
          'Helicone-Auth': `Bearer ${HELICONE_API_KEY}`,
          'Helicone-Property-Caller': HELICONE_CALLER,
        } : {}),
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2_000,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '').join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You enrich a news article for a world events tracking app. Always return ONE JSON object with these fields:

  - summary: AT LEAST 3 paragraphs of neutral, factual prose (200-400 words). Use double-newline paragraph breaks. Match the tone of major newswires (Reuters, AP, BBC). Each paragraph should be 2-4 sentences. Cover who/what/when/where/why and any relevant context, reactions, or implications. No bullet points, no markdown, no headers, no editorializing. Don't repeat the headline verbatim. If the source content is sparse, draw on what you know about the named people, places, and organizations to add context (clearly attributed if you do).

  - region: ONE of these exact strings — choose the world region the story is most associated with:
      "us"             — United States
      "canada"         — Canada
      "latin_america"  — Mexico, Central + South America, Caribbean
      "europe"         — UK, EU, Russia, Ukraine, Balkans, Caucasus
      "middle_east"    — Turkey, Israel, Arab states, Iran
      "africa"         — All African nations
      "asia"           — East/South/Southeast Asia, Central Asia
      "oceania"        — Australia, NZ, Pacific islands
    If genuinely global / unattributable, pick the region of the most prominent named entity. Always set this field.

  - country: ISO 3166-1 alpha-2 code of the primary country in the story. ONLY include this field for stories about armed conflict, military operations, terrorist attacks, civil unrest, or any kinetic event with a clear geographic incident location. For other stories (business, sports, entertainment, etc.), OMIT this field entirely.

  - locationName: short human-readable place name shown as the row header in the feed UI — typically a city ("Tel Aviv", "Kharkiv"), a region/oblast ("Donetsk Oblast", "Sinai"), or a country if no narrower place is named ("Sudan"). Title Case. Use the same location-naming convention major newswires use in their dateline. ONLY include for the same conflict/kinetic-event stories where you set "country". OMIT for non-conflict stories.

  - lat, lng: estimated coordinates (decimal degrees) of the incident. ONLY include for the same conflict/kinetic-event stories where you set "country". When the article names a specific city, use that city's coordinates. Otherwise, use the capital city of "country". OMIT for non-conflict stories.

If the article body is paywalled, garbled, or the source URL didn't return useful text, write a 3-paragraph summary using the headline + your knowledge of the topic. Still return region (best guess based on headline).

Return JSON ONLY. No prose, no markdown, no code fences.`;

function buildPrompt(item: { title: string; source: string; link: string }, body: string | null): string {
  const header = `Headline: ${item.title}\nSource: ${item.source}\n`;
  if (body) {
    return `${header}\nArticle text:\n${body}`;
  }
  return `${header}\n(Article body unavailable — base your summary and classification on the headline alone.)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse + validate the LLM's JSON output.
// ─────────────────────────────────────────────────────────────────────────────

function parseEnrichmentJSON(raw: string | null): EnrichmentPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    // Strip code fences and retry — Claude sometimes wraps despite system prompt.
    const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
    try { parsed = JSON.parse(stripped); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const region = typeof obj.region === 'string' ? obj.region.trim().toLowerCase() : '';

  if (summary.length < SUMMARY_MIN_LEN || summary.length > SUMMARY_MAX_LEN) return null;
  if (/^(I cannot|I can't|I'm sorry|I apologize|As an AI)/i.test(summary)) return null;
  if (!VALID_REGIONS.has(region)) return null;

  const result: EnrichmentPayload = { summary, region };

  // Country — accept only valid 2-char alpha codes.
  if (typeof obj.country === 'string') {
    const c = obj.country.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) result.country = c;
  }

  // locationName — short place string. Cap at 100 chars defensively in
  // case the LLM ignores the "short" instruction; trim whitespace.
  if (typeof obj.locationName === 'string') {
    const ln = obj.locationName.trim();
    if (ln.length > 0 && ln.length <= 100) result.locationName = ln;
  }

  // Coordinates — accept only when both are valid finite numbers in range.
  const lat = typeof obj.lat === 'number' ? obj.lat : Number.NaN;
  const lng = typeof obj.lng === 'number' ? obj.lng : Number.NaN;
  if (Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    result.lat = lat;
    result.lng = lng;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-item enrichment with shared cache.
// ─────────────────────────────────────────────────────────────────────────────

interface EnrichmentInput {
  title: string;
  source: string;
  link: string;
}

async function enrichOne(item: EnrichmentInput): Promise<EnrichmentPayload | null> {
  // Shared cache — same URL enriched in any pipeline reuses the result.
  const cacheKey = ENRICHMENT_CACHE_KEY(item.link);
  const cached = await redisGet<EnrichmentPayload>(cacheKey);
  if (cached && cached.summary && cached.region && VALID_REGIONS.has(cached.region)) {
    return cached;
  }

  // Cache miss — run the LLM call.
  const body = await fetchArticleBody(item.link);
  const prompt = buildPrompt(item, body);

  let raw = await callGeminiJSON(SYSTEM_PROMPT, prompt);
  let payload = parseEnrichmentJSON(raw);
  if (!payload) {
    raw = await callClaudeJSON(SYSTEM_PROMPT, prompt);
    payload = parseEnrichmentJSON(raw);
    if (!payload) return null;
  }

  // Persist to shared cache (fire-and-forget OK — write failure just means
  // the next caller redoes the work).
  await redisSet(cacheKey, payload, ENRICHMENT_CACHE_TTL_S);
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Location-only enrichment — for worldnews-sourced items where our license
// terms forbid generating a summary on top of the API's own. We never ask
// the LLM for one in the first place, which also saves ~80% of the output
// tokens per call.
// ─────────────────────────────────────────────────────────────────────────────

interface LocationOnlyPayload {
  region: string;
  /** True for armed-conflict / kinetic-event stories — drives the iOS
   *  CONFLICT chip and the conflict-archive copy. Explicit field (not
   *  inferred from "country exists") since this prompt always emits
   *  country when it can geolocate, regardless of conflict status. */
  isConflict: boolean;
  /** Multi-label intel-topic classification — zero or more of the 9
   *  non-conflict categories. Drives the v6 GDELT-category feeds
   *  (cyber / military / …). Empty array when none apply. */
  topics: string[];
  country?: string;
  locationName?: string;
  lat?: number;
  lng?: number;
}

/** The 9 non-conflict intel categories the location-only LLM may tag.
 *  Kept in sync with INTEL_TOPICS (minus `conflict`) in refresh.ts. */
const VALID_TOPICS = new Set([
  'cyber', 'military', 'nuclear', 'sanctions', 'intelligence',
  'maritime', 'business', 'scitech', 'entertainment',
]);

const LOCATION_ONLY_CACHE_KEY = (link: string): string =>
  `enrichment-loc:v2:${createHash('sha256').update(link).digest('hex')}`;
const LOCATION_ONLY_CACHE_TTL_S = 3 * 24 * 60 * 60; // 3-day project max

const LOCATION_ONLY_SYSTEM_PROMPT = `You classify a news article. Return ONE JSON object with these fields:

  - region: ONE of these exact strings — choose the world region the story is most associated with:
      "us"             — United States
      "canada"         — Canada
      "latin_america"  — Mexico, Central + South America, Caribbean
      "europe"         — UK, EU, Russia, Ukraine, Balkans, Caucasus
      "middle_east"    — Turkey, Israel, Arab states, Iran
      "africa"         — All African nations
      "asia"           — East/South/Southeast Asia, Central Asia
      "oceania"        — Australia, NZ, Pacific islands
    If genuinely global / unattributable, pick the region of the most prominent named entity. Always set this field.

  - isConflict: boolean. True ONLY if the story is about armed conflict, military operations, terrorist attacks, civil unrest, or any kinetic event with a clear geographic incident location. False for everything else (business, sports, politics, entertainment, weather, etc).

  - topics: an ARRAY of zero or more of these exact strings — every category the story is substantively about (a story may fit several, or none):
      "cyber"         — cyberattacks, data breaches, ransomware, hacking, cyber-espionage
      "military"      — armed forces, defense, weapons, military operations / exercises / deployments
      "nuclear"       — nuclear weapons, nuclear energy / power, uranium, IAEA, proliferation
      "sanctions"     — sanctions, embargoes, tariffs, trade restrictions, export controls
      "intelligence"  — espionage, spy agencies, surveillance programs, classified leaks, covert operations
      "maritime"      — naval forces, shipping, ports, piracy, sea lanes, maritime incidents
      "business"      — companies, markets, earnings, central banks, the economy, trade deals
      "scitech"       — science, technology, AI, space, health / medical research, innovation
      "entertainment" — film, TV, music, celebrities, gaming, awards, the sports business
    Be strict: include a category only when the story is genuinely about it, not when it is merely mentioned in passing. Return [] when none apply.

  - country: ISO 3166-1 alpha-2 code of the primary country in the story. ONLY include when isConflict=true. OMIT for non-conflict stories.

  - locationName: short human-readable place name shown as the row header in the feed UI — typically a city ("Tel Aviv", "Kharkiv"), a region/oblast ("Donetsk Oblast", "Sinai"), or a country if no narrower place is named ("Sudan"). Title Case. ONLY include when isConflict=true. OMIT otherwise.

  - lat, lng: estimated coordinates (decimal degrees) of the incident. ONLY include when isConflict=true. When the article names a specific city, use that city's coordinates. Otherwise, use the capital city of "country". OMIT for non-conflict stories.

DO NOT write a summary. DO NOT include any field besides those above. Return JSON ONLY. No prose, no markdown, no code fences.`;

function parseLocationOnlyJSON(raw: string | null): LocationOnlyPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
    try { parsed = JSON.parse(stripped); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const region = typeof obj.region === 'string' ? obj.region.trim().toLowerCase() : '';
  if (!VALID_REGIONS.has(region)) return null;

  const isConflict = obj.isConflict === true;

  const topics = Array.isArray(obj.topics)
    ? [...new Set(
        (obj.topics as unknown[])
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim().toLowerCase())
          .filter((t) => VALID_TOPICS.has(t)),
      )]
    : [];

  const result: LocationOnlyPayload = { region, isConflict, topics };

  if (typeof obj.country === 'string') {
    const c = obj.country.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) result.country = c;
  }

  if (typeof obj.locationName === 'string') {
    const ln = obj.locationName.trim();
    if (ln.length > 0 && ln.length <= 100) result.locationName = ln;
  }

  const lat = typeof obj.lat === 'number' ? obj.lat : Number.NaN;
  const lng = typeof obj.lng === 'number' ? obj.lng : Number.NaN;
  if (Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    result.lat = lat;
    result.lng = lng;
  }

  return result;
}

async function enrichOneLocationOnly(item: EnrichmentInput): Promise<LocationOnlyPayload | null> {
  // Separate cache namespace from the summary-bearing cache so the two
  // payload shapes never cross over. A 30-day TTL matches the summary
  // cache — location facts are about as stable as summaries.
  const cacheKey = LOCATION_ONLY_CACHE_KEY(item.link);
  const cached = await redisGet<LocationOnlyPayload>(cacheKey);
  if (cached && cached.region && VALID_REGIONS.has(cached.region)) {
    return cached;
  }

  const body = await fetchArticleBody(item.link);
  const prompt = buildPrompt(item, body);

  let raw = await callGeminiJSON(LOCATION_ONLY_SYSTEM_PROMPT, prompt);
  let payload = parseLocationOnlyJSON(raw);
  if (!payload) {
    raw = await callClaudeJSON(LOCATION_ONLY_SYSTEM_PROMPT, prompt);
    payload = parseLocationOnlyJSON(raw);
    if (!payload) return null;
  }

  await redisSet(cacheKey, payload, LOCATION_ONLY_CACHE_TTL_S);
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Title-only summary — for licensed buckets where we don't have a license to
// republish the article body (e.g. worldnewsapi). We send ONLY the headline
// to the LLM and ask for a 1-2 sentence neutral summary. The article body
// is never fetched in this path so it can't accidentally leak into the
// summary text. Coordinates / region / etc. come from the separate
// location-only call which is allowed to use the body (factual inference,
// not content reuse).
// ─────────────────────────────────────────────────────────────────────────────

interface TitleSummaryPayload {
  summary: string;
}


const TITLE_SUMMARY_CACHE_KEY = (link: string): string =>
  `enrichment-title-summary:v1:${createHash('sha256').update(link).digest('hex')}`;
const TITLE_SUMMARY_CACHE_TTL_S = 3 * 24 * 60 * 60; // 3-day project max

const TITLE_SUMMARY_MIN_LEN = 40;
const TITLE_SUMMARY_MAX_LEN = 500;

const TITLE_SUMMARY_SYSTEM_PROMPT = `You receive a news headline and the publishing outlet. Return ONE JSON object:

  - summary: a single neutral, factual sentence (or at most two short sentences) describing the story implied by the headline. Use ONLY information present in the headline itself. DO NOT speculate, invent details, or fabricate names, numbers, places, or quotes that aren't already in the headline. If the headline is too sparse to expand, return a slightly rephrased version of the headline written in plain newswire prose. No bullet points, no markdown, no headers, no editorializing, no opinions.

Return JSON ONLY. No prose, no markdown, no code fences.`;

function buildTitleOnlyPrompt(item: { title: string; source: string }): string {
  return `Headline: ${item.title}\nSource: ${item.source}\n`;
}

function parseTitleSummaryJSON(raw: string | null): TitleSummaryPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
    try { parsed = JSON.parse(stripped); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (summary.length < TITLE_SUMMARY_MIN_LEN) return null;
  if (summary.length > TITLE_SUMMARY_MAX_LEN) return { summary: summary.slice(0, TITLE_SUMMARY_MAX_LEN) };
  if (/^(I cannot|I can't|I'm sorry|I apologize|As an AI)/i.test(summary)) return null;
  return { summary };
}

async function enrichOneTitleSummary(item: EnrichmentInput): Promise<TitleSummaryPayload | null> {
  const cacheKey = TITLE_SUMMARY_CACHE_KEY(item.link);
  const cached = await redisGet<TitleSummaryPayload>(cacheKey);
  if (cached && cached.summary && cached.summary.length >= TITLE_SUMMARY_MIN_LEN) {
    return cached;
  }

  // NOTE: deliberately NO `fetchArticleBody` here. License terms only
  // permit us to use API-supplied fields (title, source) as input to a
  // summary the user will see.
  const prompt = buildTitleOnlyPrompt(item);

  let raw = await callGeminiJSON(TITLE_SUMMARY_SYSTEM_PROMPT, prompt);
  let payload = parseTitleSummaryJSON(raw);
  if (!payload) {
    raw = await callClaudeJSON(TITLE_SUMMARY_SYSTEM_PROMPT, prompt);
    payload = parseTitleSummaryJSON(raw);
    if (!payload) return null;
  }

  await redisSet(cacheKey, payload, TITLE_SUMMARY_CACHE_TTL_S);
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main enrichment loop — processes per-topic accumulators AND the
// conflict-archive (gdelt key) in a single concurrency pool.
// ─────────────────────────────────────────────────────────────────────────────

interface PerTopicStats {
  toEnrich: number;
  succeeded: number;
  failed: number;
}

interface EnrichResult {
  durationMs: number;
  totals: {
    topics: number;
    queued: number;
    succeeded: number;
    failed: number;
    skippedBudget: number;
  };
  perTopic: Record<string, PerTopicStats>;
}

// "Bucket" — a logical group of items the worker pool can process. Each
// bucket has its own array of items + a Redis writeback key. Conflict
// archive is a bucket alongside the per-topic ones.
const CONFLICT_BUCKET_ID = 'conflict' as const;

/**
 * Item-shape discriminator for write-back logic:
 *
 *   • `intel`     — IntelNewsItem. Separate `lat` / `lng` fields. Skipped
 *                   for missing locationName (not a required field here).
 *   • `conflict`  — ConflictArchiveItem. `location: {latitude, longitude}`
 *                   object. Requires `locationName` (drives iOS row label).
 *   • `live-news` — LiveNewsV3Item. Same writeback shape as conflict
 *                   (location object), but locationName is best-effort —
 *                   not every general-news headline has a precise place.
 */
type BucketKind = 'intel' | 'conflict' | 'live-news';

interface Bucket {
  id: string;
  items: Array<IntelNewsItem | ConflictArchiveItem>;
  writebackKey: string;
  ttl: number;
  kind: BucketKind;
  /**
   * When true, the standard LLM summary (body-derived, multi-paragraph)
   * is NOT generated/written. The item keeps whatever summary it
   * shipped with from the licensed upstream API (Webz / Newscatcher
   * both ship usable summaries themselves).
   *
   * Legacy RSS/GDELT buckets pre-date the license terms and keep
   * generating LLM summaries from the body.
   */
  skipSummary: boolean;
  /**
   * When true, an EXTRA title-only LLM call runs and its single-
   * sentence summary is written to the item. Used for worldnewsapi
   * buckets where the upstream does NOT supply a summary AND we don't
   * have a license to use the scraped article body — so the LLM gets
   * only the headline + outlet name as input. Coordinates / region
   * still come from the location-only call which IS allowed to read
   * the body (factual inference, not content reuse).
   */
  generateTitleSummary: boolean;
}

async function runEnrichment(): Promise<EnrichResult> {
  const start = Date.now();

  // Load all buckets in parallel: 9 per-topic accumulators + 1 conflict-archive.
  const buckets: Bucket[] = await Promise.all([
    ...TOPIC_IDS.map(async (tid): Promise<Bucket> => {
      const items = await redisGet<IntelNewsItem[]>(accumulatorKey(tid));
      return {
        id: tid,
        items: Array.isArray(items) ? items : [],
        writebackKey: accumulatorKey(tid),
        ttl: ACCUMULATOR_TTL_S,
        kind: 'intel',
        skipSummary: false,
        generateTitleSummary: false,
      };
    }),
    (async (): Promise<Bucket> => {
      const items = await redisGet<ConflictArchiveItem[]>(CONFLICT_ARCHIVE_GDELT_KEY);
      return {
        id: CONFLICT_BUCKET_ID,
        items: Array.isArray(items) ? items : [],
        writebackKey: CONFLICT_ARCHIVE_GDELT_KEY,
        ttl: CONFLICT_ARCHIVE_TTL_S,
        kind: 'conflict',
        skipSummary: false,
        generateTitleSummary: false,
      };
    })(),
    (async (): Promise<Bucket> => {
      // World News conflict archive (v2) — license forbids using the
      // scraped article body for the summary. Skip the body-based
      // summary AND run an extra title-only LLM call so we still ship
      // a short summary to iOS. Location/coords keep using the body
      // (that's allowed — factual inference).
      const items = await redisGet<ConflictArchiveItem[]>(CONFLICT_ARCHIVE_WN_KEY);
      return {
        id: `${CONFLICT_BUCKET_ID}-wn`,
        items: Array.isArray(items) ? items : [],
        writebackKey: CONFLICT_ARCHIVE_WN_KEY,
        ttl: CONFLICT_ARCHIVE_TTL_S,
        kind: 'conflict',
        skipSummary: true,
        generateTitleSummary: true,
      };
    })(),
    (async (): Promise<Bucket> => {
      // Live-news v3 (World News API) — same license constraint as the
      // wn conflict bucket. Title-only summary, body-based coords.
      const items = await redisGet<ConflictArchiveItem[]>(LIVE_NEWS_WN_KEY);
      return {
        id: 'live-news-wn',
        items: Array.isArray(items) ? items : [],
        writebackKey: LIVE_NEWS_WN_KEY,
        ttl: LIVE_NEWS_TTL_S,
        kind: 'live-news',
        skipSummary: true,
        generateTitleSummary: true,
      };
    })(),
    (async (): Promise<Bucket> => {
      // Live-news v4 (Webz.io) — Webz ships its own `summary` field
      // when present; we use it verbatim and skip LLM summary entirely.
      const items = await redisGet<ConflictArchiveItem[]>(LIVE_NEWS_WEBZ_KEY);
      return {
        id: 'live-news-webz',
        items: Array.isArray(items) ? items : [],
        writebackKey: LIVE_NEWS_WEBZ_KEY,
        ttl: LIVE_NEWS_TTL_S,
        kind: 'live-news',
        skipSummary: true,
        generateTitleSummary: false,
      };
    })(),
    (async (): Promise<Bucket> => {
      const items = await redisGet<ConflictArchiveItem[]>(CONFLICT_ARCHIVE_WEBZ_KEY);
      return {
        id: `${CONFLICT_BUCKET_ID}-webz`,
        items: Array.isArray(items) ? items : [],
        writebackKey: CONFLICT_ARCHIVE_WEBZ_KEY,
        ttl: CONFLICT_ARCHIVE_TTL_S,
        kind: 'conflict',
        skipSummary: true,
        generateTitleSummary: false,
      };
    })(),
    (async (): Promise<Bucket> => {
      // Live-news v5 (Newscatcher). Newscatcher's `nlp.summary` is part
      // of its licensed payload, so we keep it as-is.
      const items = await redisGet<ConflictArchiveItem[]>(LIVE_NEWS_NC_KEY);
      return {
        id: 'live-news-nc',
        items: Array.isArray(items) ? items : [],
        writebackKey: LIVE_NEWS_NC_KEY,
        ttl: LIVE_NEWS_TTL_S,
        kind: 'live-news',
        skipSummary: true,
        generateTitleSummary: false,
      };
    })(),
    (async (): Promise<Bucket> => {
      const items = await redisGet<ConflictArchiveItem[]>(CONFLICT_ARCHIVE_NC_KEY);
      return {
        id: `${CONFLICT_BUCKET_ID}-nc`,
        items: Array.isArray(items) ? items : [],
        writebackKey: CONFLICT_ARCHIVE_NC_KEY,
        ttl: CONFLICT_ARCHIVE_TTL_S,
        kind: 'conflict',
        skipSummary: true,
        generateTitleSummary: false,
      };
    })(),
    (async (): Promise<Bucket> => {
      // Live-news v6 (RSS + Gemini embeddings). Wire `summary` is
      // outlet-supplied content (longest RSS description from the
      // cluster), already set at refresh time. LLM only fills
      // location-related fields + isConflict for the map.
      const items = await redisGet<ConflictArchiveItem[]>(LIVE_NEWS_RSE_KEY);
      return {
        id: 'live-news-rse',
        items: Array.isArray(items) ? items : [],
        writebackKey: LIVE_NEWS_RSE_KEY,
        ttl: LIVE_NEWS_TTL_S,
        kind: 'live-news',
        skipSummary: true,
        generateTitleSummary: false,
      };
    })(),
  ]);

  // Build round-robin queue — one item per bucket per cursor tick. Items
  // within each bucket are already sorted newest-first by upstream
  // (refresh.ts for accumulators, store.ts for conflict-archive).
  interface QueueEntry { bucketIdx: number; itemIdx: number; }
  const queue: QueueEntry[] = [];
  const perTopic: Record<string, PerTopicStats> = {};

  // Per-bucket "needs enrichment" index lists. An item is considered
  // un-enriched if ANY of these are true:
  //   • no summary
  //   • no region tag
  //   • summary is shorter than the current 3-paragraph minimum (catches
  //     items enriched under older prompts; cache v2 ensures re-LLM)
  //   • conflict bucket only — no locationName (drives the iOS row header)
  const perBucketIndices: Array<{ bucketIdx: number; indices: number[] }> = [];
  buckets.forEach((bucket, bucketIdx) => {
    perTopic[bucket.id] = { toEnrich: 0, succeeded: 0, failed: 0 };
    const indices: number[] = [];
    for (let i = 0; i < bucket.items.length; i++) {
      const item = bucket.items[i];
      if (!item) continue;

      // ConflictArchiveItem and LiveNewsV3Item share the same summary/region
      // field positions; only `intel` (IntelNewsItem) is read differently.
      const summary = bucket.kind === 'intel'
        ? (item as IntelNewsItem).summary
        : (item as ConflictArchiveItem).summary;
      const region = bucket.kind === 'intel'
        ? (item as IntelNewsItem).region
        : (item as ConflictArchiveItem).region;
      const summaryTooShort = !!summary && summary.length < SUMMARY_MIN_LEN;
      // Only conflict items require locationName — live-news items don't
      // always have a precise place attached.
      const conflictMissingLocation = bucket.kind === 'conflict'
        && !(item as ConflictArchiveItem).locationName;

      // Decide whether this item still needs an LLM pass:
      //   • Full LLM buckets (intel, legacy conflict): queue if summary
      //     is missing/too-short OR region is missing OR (conflict)
      //     locationName is missing.
      //   • License-restricted buckets that use the API's summary
      //     (Webz / Newscatcher): summary state is irrelevant — queue
      //     only when region or (conflict) locationName is missing.
      //   • License-restricted buckets that use a title-only LLM
      //     summary (worldnews): queue when summary is missing (we own
      //     that field) OR region/locationName are missing.
      const needsTitleSummary = bucket.generateTitleSummary && !summary;
      const needsRegion = !region;
      const needsLocationName = conflictMissingLocation;
      const needsFullSummary = !bucket.skipSummary && (!summary || summaryTooShort);
      // v6 digest clusters also need the multi-label `topics` classification;
      // re-queue any that predate it (region set, topics absent).
      const needsTopics = bucket.kind === 'live-news'
        && !Array.isArray((item as { topics?: unknown }).topics);
      const needsEnrichment = needsTitleSummary || needsRegion || needsLocationName
        || needsFullSummary || needsTopics;

      if (needsEnrichment) {
        indices.push(i);
      }
    }
    perTopic[bucket.id]!.toEnrich = indices.length;
    if (indices.length > 0) perBucketIndices.push({ bucketIdx, indices });
  });

  // Round-robin interleave so every bucket gets proportional progress per run.
  let cursor2 = 0;
  while (perBucketIndices.some((q) => cursor2 < q.indices.length)) {
    for (const q of perBucketIndices) {
      if (cursor2 < q.indices.length) {
        const itemIdx = q.indices[cursor2];
        if (itemIdx !== undefined) queue.push({ bucketIdx: q.bucketIdx, itemIdx });
      }
    }
    cursor2++;
  }

  const queued = queue.length;
  console.log(
    `[intel-news:enrich] ${queued} items to enrich across ${buckets.length} buckets ` +
    `(concurrency=${CONCURRENCY}, budget=${BUDGET_MS}ms)`,
  );

  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedBudget = 0;

  async function runner(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= queue.length) return;
      if (Date.now() - start > BUDGET_MS) {
        skippedBudget++;
        continue;
      }
      const entry = queue[idx];
      if (!entry) continue;
      const bucket = buckets[entry.bucketIdx];
      if (!bucket) continue;
      const item = bucket.items[entry.itemIdx];
      if (!item) continue;

      try {
        const input: EnrichmentInput = {
          title: item.title,
          source: item.source,
          link: item.link,
        };

        // Dispatch on bucket.skipSummary so worldnews-fed items never get
        // sent through the summary-generating prompt. The two payload
        // shapes are intentionally disjoint on the `summary` field —
        // TypeScript guides each writeback branch to the right one.
        if (bucket.skipSummary) {
          // Always run the body-aware location-only call. When the
          // bucket also wants a title-only summary (worldnews path),
          // run it in parallel — the body is NEVER passed to that
          // second call, so the summary text can't leak unlicensed
          // article content.
          const [payload, titleSummary] = await Promise.all([
            enrichOneLocationOnly(input),
            bucket.generateTitleSummary ? enrichOneTitleSummary(input) : Promise.resolve(null),
          ]);

          if (payload) {
            // conflict + live-news writeback shape.
            const ci = item as ConflictArchiveItem;
            ci.region = payload.region;
            // Location: keep what's already set. v6 RSS-embedding clusters
            // with a GDELT member arrive with GKG-parsed coordinates +
            // place name already populated — those are real gazetteer
            // values and beat an LLM coordinate estimate. Only LLM-geocode
            // when no location exists yet (clusters with no GDELT member).
            if (!ci.location) {
              if (payload.country) ci.country = payload.country;
              if (payload.locationName) ci.locationName = payload.locationName;
              if (payload.lat != null && payload.lng != null) {
                ci.location = { latitude: payload.lat, longitude: payload.lng };
              }
            }
            // Title-only summary: only writes when this bucket's
            // generateTitleSummary flag is set (and the API didn't
            // already ship one — defensive guard so a Webz/Newscatcher
            // summary that happened to slip into a worldnews-shaped
            // item isn't clobbered).
            if (bucket.generateTitleSummary && titleSummary && !ci.summary) {
              ci.summary = titleSummary.summary;
            }
            // The explicit isConflict flag drives the iOS CONFLICT chip
            // and our copy-to-archive step in the post-runner block.
            if (bucket.kind === 'live-news') {
              (item as { isConflict?: boolean | null }).isConflict = payload.isConflict;
              (item as { topics?: string[] }).topics = payload.topics;
            }
            succeeded++;
            const stats = perTopic[bucket.id];
            if (stats) stats.succeeded++;
          } else {
            failed++;
            const stats = perTopic[bucket.id];
            if (stats) stats.failed++;
          }
        } else {
          const payload = await enrichOne(input);
          if (payload) {
            if (bucket.kind === 'intel') {
              const ni = item as IntelNewsItem;
              ni.summary = payload.summary;
              ni.region = payload.region;
              if (payload.country) ni.country = payload.country;
              if (payload.lat != null) ni.lat = payload.lat;
              if (payload.lng != null) ni.lng = payload.lng;
            } else {
              // Legacy conflict (GDELT) bucket — still LLM-generated summary
              // because that pipeline pre-dates the license terms.
              const ci = item as ConflictArchiveItem;
              ci.summary = payload.summary;
              ci.region = payload.region;
              if (payload.country) ci.country = payload.country;
              if (payload.locationName) ci.locationName = payload.locationName;
              if (payload.lat != null && payload.lng != null) {
                ci.location = { latitude: payload.lat, longitude: payload.lng };
              }
            }
            succeeded++;
            const stats = perTopic[bucket.id];
            if (stats) stats.succeeded++;
          } else {
            failed++;
            const stats = perTopic[bucket.id];
            if (stats) stats.failed++;
          }
        }
      } catch (err) {
        failed++;
        const stats = perTopic[bucket.id];
        if (stats) stats.failed++;
        console.warn(`[intel-news:enrich] item threw: ${(err as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runner()));

  // Drain each live-news bucket's isConflict items into its matching
  // conflict archive. The archive grows organically from live-news —
  // no dedicated conflict-search cron needed, the LLM's per-item
  // classification (`isConflict` flag set during the location-only
  // enrichment) is the signal.
  //
  // Each live-news bucket maps to exactly one conflict archive Redis
  // key so the two upstream sources (worldnews / webz) stay isolated.
  // Read-modify-write each target once at the end of the run.
  const LIVE_NEWS_TO_ARCHIVE: Record<string, { key: string; origin: ConflictArchiveItem['origin']; idPrefix: string }> = {
    'live-news-wn':   { key: CONFLICT_ARCHIVE_WN_KEY,   origin: 'worldnews',   idPrefix: 'wn-'   },
    'live-news-webz': { key: CONFLICT_ARCHIVE_WEBZ_KEY, origin: 'webz',        idPrefix: 'webz-' },
    'live-news-nc':   { key: CONFLICT_ARCHIVE_NC_KEY,   origin: 'newscatcher', idPrefix: 'nc-'   },
    'live-news-rse':  { key: CONFLICT_ARCHIVE_RSE_KEY,  origin: 'rse',         idPrefix: 'rse-'  },
  };

  for (const bucket of buckets.filter((b) => b.kind === 'live-news')) {
    const target = LIVE_NEWS_TO_ARCHIVE[bucket.id];
    if (!target) continue;

    const conflictItems: ConflictArchiveItem[] = [];
    for (const raw of bucket.items) {
      const it = raw as Partial<ConflictArchiveItem> & {
        id?: number | string; isConflict?: boolean | null; sources?: unknown;
        imageUrl?: string | null;
      };
      if (!it.isConflict) continue;
      // Live-news ids may be numbers (worldnews) or strings (webz uuids /
      // rse titleHashes). We prefix per source so ids stay distinct across
      // pipelines that ever shared a Redis key (defensive, even though
      // each pipeline lives in its own archive today).
      const idStr = typeof it.id === 'number' || typeof it.id === 'string'
        ? `${target.idPrefix}${it.id}`
        : `${target.idPrefix}unknown-${Date.now()}`;
      const archiveItem = {
        id: idStr,
        source: it.source ?? '',
        title: it.title ?? '',
        link: it.link ?? '',
        publishedAt: typeof it.publishedAt === 'number' ? it.publishedAt : Date.now(),
        isAlert: it.isAlert ?? false,
        summary: it.summary ?? null,
        location: it.location ?? null,
        locationName: it.locationName ?? null,
        country: it.country ?? null,
        region: it.region ?? null,
        sources: Array.isArray(it.sources)
          ? (it.sources as ConflictArchiveItem['sources'])
          : null,
        origin: target.origin,
      } as ConflictArchiveItem;
      // RSE-origin items carry an RSS-supplied imageUrl that's not part
      // of the legacy ConflictArchiveItem shape. Attach it without
      // widening the type — the v5 conflict-archive read endpoint
      // surfaces it back to iOS.
      if (it.imageUrl) {
        (archiveItem as ConflictArchiveItem & { imageUrl?: string | null }).imageUrl = it.imageUrl;
      }
      conflictItems.push(archiveItem);
    }

    if (conflictItems.length === 0) continue;

    const existing = (await redisGet<ConflictArchiveItem[]>(target.key)) ?? [];
    const byId = new Map<string, ConflictArchiveItem>();
    for (const e of existing) {
      if (e?.id) byId.set(e.id, e);
    }
    for (const c of conflictItems) {
      byId.set(c.id, c);
    }
    // 30-day retention + 1000-item cap (matches the legacy v1 store).
    const cutoff = Date.now() - CONFLICT_ARCHIVE_TTL_S * 1000;
    const merged = Array.from(byId.values())
      .filter((c) => typeof c.publishedAt === 'number' && c.publishedAt >= cutoff)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 1000);
    await redisSet(target.key, merged, CONFLICT_ARCHIVE_TTL_S);
    console.log(
      `[intel-news:enrich] ${target.key} merged ${conflictItems.length} ` +
      `(existed=${existing.length} after=${merged.length})`,
    );
  }

  // Write back buckets that gained any progress.
  await Promise.all(buckets.map(async (bucket) => {
    const stats = perTopic[bucket.id];
    if (!stats || stats.succeeded === 0) return;
    await redisSet(bucket.writebackKey, bucket.items, bucket.ttl);
  }));

  const durationMs = Date.now() - start;

  // Per-bucket log summary, only for buckets that did anything.
  for (const bucket of buckets) {
    const s = perTopic[bucket.id];
    if (!s || s.toEnrich === 0) continue;
    console.log(
      `[intel-news:enrich] ${bucket.id}: queued=${s.toEnrich} ✓${s.succeeded} ✗${s.failed}`,
    );
  }
  console.log(
    `[intel-news:enrich] done in ${durationMs}ms · ` +
    `${succeeded} succeeded, ${failed} failed, ${skippedBudget} budget-skipped of ${queued}`,
  );

  return {
    durationMs,
    totals: {
      topics: buckets.length,
      queued,
      succeeded,
      failed,
      skippedBudget,
    },
    perTopic,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth + handler
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = (req.headers.authorization ?? '') as string;
    if (auth === `Bearer ${secret}`) return true;
  }
  const ua = ((req.headers['user-agent'] ?? '') as string).toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!isAuthorized(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }));
    return;
  }

  try {
    const result = await runEnrichment();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[intel-news:enrich] handler failed:', err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}
