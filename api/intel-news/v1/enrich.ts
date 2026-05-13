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

const ACCUMULATOR_TTL_S = 7 * 24 * 60 * 60;

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
const CONFLICT_ARCHIVE_TTL_S = 30 * 24 * 60 * 60;

// Live-news v3 (World News bucket) — populated by the search-news cron
// at `/api/live-news/v3/refresh-worldnews`. Enrichment fills
// summary + region + country (and location/locationName when the
// article happens to be locatable). The shape matches ConflictArchiveItem
// for writeback purposes — `location` is `{latitude, longitude} | null`.
const LIVE_NEWS_WN_KEY = 'live-news:wn:v1:digest';
const LIVE_NEWS_TTL_S = 7 * 24 * 60 * 60;

// Shared enrichment cache — keyed by sha256(link). Both pipelines read /
// write it, so a URL enriched once in either pipeline is reused by the
// other instead of re-paying the LLM call.
//
// Version bump: v1 → v2 invalidates all prior cached enrichments so the
// new 3-paragraph + locationName prompt re-enriches everything. Bumps
// total LLM cost ~$0.30 one-time as ~2800 existing items refresh.
const ENRICHMENT_CACHE_KEY = (link: string): string =>
  `enrichment-cache:v2:${createHash('sha256').update(link).digest('hex')}`;
const ENRICHMENT_CACHE_TTL_S = 30 * 24 * 60 * 60;

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
  origin: 'live-news' | 'gdelt' | 'worldnews';
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
    // The shared reader at server/_shared/redis.ts decompresses inline; this
    // inlined cron handler can't (no gunzip util here), so we surface a
    // diagnostic and skip the value. If you ever see this log, either turn
    // compression off for these keys or extend this helper.
    if (
      typeof parsed === 'object' && parsed !== null
      && '__wmgz' in parsed
    ) {
      console.warn(`[intel-news:enrich] "${key}" is gzip-encoded — enrich cannot decode (compression envelope unsupported here)`);
      return null;
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
      };
    })(),
    (async (): Promise<Bucket> => {
      // World News conflict archive (v2) — populated by the new 5-min
      // refresh cron. Same enrichment treatment as the GDELT bucket;
      // a separate bucket keeps round-robin scheduling fair across
      // pipelines (a flood from one source can't starve the other).
      const items = await redisGet<ConflictArchiveItem[]>(CONFLICT_ARCHIVE_WN_KEY);
      return {
        id: `${CONFLICT_BUCKET_ID}-wn`,
        items: Array.isArray(items) ? items : [],
        writebackKey: CONFLICT_ARCHIVE_WN_KEY,
        ttl: CONFLICT_ARCHIVE_TTL_S,
        kind: 'conflict',
      };
    })(),
    (async (): Promise<Bucket> => {
      // Live-news v3 (worldnews-fed). Same write-back shape as the
      // conflict buckets — `location` is `{latitude, longitude} | null`,
      // not separate lat/lng — but we don't gate enrichment on
      // `locationName` because not every general-news headline names a
      // precise place. Region + summary are the must-haves here.
      const items = await redisGet<ConflictArchiveItem[]>(LIVE_NEWS_WN_KEY);
      return {
        id: 'live-news-wn',
        items: Array.isArray(items) ? items : [],
        writebackKey: LIVE_NEWS_WN_KEY,
        ttl: LIVE_NEWS_TTL_S,
        kind: 'live-news',
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

      if (!summary || !region || summaryTooShort || conflictMissingLocation) {
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
        const payload = await enrichOne({
          title: item.title,
          source: item.source,
          link: item.link,
        });
        if (payload) {
          // Apply enrichment fields — different shape per bucket type.
          if (bucket.kind === 'intel') {
            const ni = item as IntelNewsItem;
            ni.summary = payload.summary;
            ni.region = payload.region;
            if (payload.country) ni.country = payload.country;
            if (payload.lat != null) ni.lat = payload.lat;
            if (payload.lng != null) ni.lng = payload.lng;
          } else {
            // conflict + live-news share the same writeback shape (location
            // is `{latitude, longitude} | null`, locationName drives the
            // iOS row label when present).
            const ci = item as ConflictArchiveItem;
            ci.summary = payload.summary;
            ci.region = payload.region;
            if (payload.country) ci.country = payload.country;
            if (payload.locationName) ci.locationName = payload.locationName;
            if (payload.lat != null && payload.lng != null) {
              ci.location = { latitude: payload.lat, longitude: payload.lng };
            }
            // Live-news items also carry an `isConflict` flag (iOS reads
            // it for the CONFLICT chip). The LLM's prompt only emits
            // `country` for kinetic/armed-conflict stories, so its
            // presence is the implicit signal — saves a separate prompt
            // field and re-enriching the cache.
            if (bucket.kind === 'live-news') {
              (item as { isConflict?: boolean | null }).isConflict = !!payload.country;
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
      } catch (err) {
        failed++;
        const stats = perTopic[bucket.id];
        if (stats) stats.failed++;
        console.warn(`[intel-news:enrich] item threw: ${(err as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runner()));

  // Derive conflict items from the live-news bucket and merge them into
  // the World News conflict archive. This is how the conflict archive
  // grows organically — no dedicated conflict-search cron needed, the
  // LLM's per-item classification (presence of `country`) is the signal.
  // Read-modify-write the archive once at the end of the run rather
  // than per-item to keep Redis ops down.
  const liveNewsBucket = buckets.find((b) => b.kind === 'live-news');
  if (liveNewsBucket) {
    const conflictItems: ConflictArchiveItem[] = [];
    for (const raw of liveNewsBucket.items) {
      const it = raw as Partial<ConflictArchiveItem> & {
        id?: number; isConflict?: boolean | null; sources?: unknown;
      };
      if (!it.isConflict) continue;
      // Promote into the ConflictArchiveItem shape. The live-news `id`
      // is a number (worldnewsapi article id) — the archive expects
      // string ids, so we prefix to keep it distinct from existing
      // titleHash/link-hash ids in the same store.
      conflictItems.push({
        id: typeof it.id === 'number' ? `wn-${it.id}` : String(it.id),
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
        // Re-cast sources — same shape on both interfaces.
        sources: Array.isArray(it.sources)
          ? (it.sources as ConflictArchiveItem['sources'])
          : null,
        origin: 'worldnews',
      });
    }

    if (conflictItems.length > 0) {
      const existing = (await redisGet<ConflictArchiveItem[]>(CONFLICT_ARCHIVE_WN_KEY)) ?? [];
      const byId = new Map<string, ConflictArchiveItem>();
      // Existing first, then new — new entries with fresher enrichment
      // overwrite the cached row.
      for (const e of existing) {
        if (e?.id) byId.set(e.id, e);
      }
      for (const c of conflictItems) {
        byId.set(c.id, c);
      }
      // 30-day retention window + 1000-item cap mirror v1/_store.ts.
      const cutoff = Date.now() - CONFLICT_ARCHIVE_TTL_S * 1000;
      const merged = Array.from(byId.values())
        .filter((c) => typeof c.publishedAt === 'number' && c.publishedAt >= cutoff)
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, 1000);
      await redisSet(CONFLICT_ARCHIVE_WN_KEY, merged, CONFLICT_ARCHIVE_TTL_S);
      console.log(
        `[intel-news:enrich] conflict-archive:wn merged ${conflictItems.length} ` +
        `(existed=${existing.length} after=${merged.length})`,
      );
    }
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
