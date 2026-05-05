/**
 * Combined enrichment — summary + location in a single LLM call.
 *
 * Replaces the old two-call pipeline (`_enrich.ts` + `_paraphrase.ts`).
 * Why:
 *   - One call halves total LLM calls vs the split design
 *   - Eliminates the cross-pipeline dependency where a missing country
 *     from location enrichment cascaded into "stuck unknowns" in dedup
 *   - Single cache namespace = simpler debugging
 *
 * Two-tier provider strategy:
 *   1. Try Gemini Flash Lite first (cheap, fast)
 *   2. For items that FAIL validation (bad country, null lat/lng,
 *      malformed summary), retry ONLY those items via Claude Haiku
 *   3. Items that fail BOTH providers get `UNENRICHABLE_MARKER` cached
 *      for 30 days — never retried, never re-cost
 *
 * This pattern was a deliberate user request: "if the output doesn't
 * match our expectations, use Claude. If still not working, forget
 * about that news, never work on it again."
 */

import { callGemini, callClaude } from '../../_shared/llm';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { LiveNewsItem } from './_normalize';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Cache prefix kept at v1 deliberately — bumping it would invalidate every
// cached enrichment in production and force a re-enrichment storm that
// degrades the old iOS app for ~1-2 min after deploy. The new `isConflict`
// field is additive: old cache entries decode it as `false` (see attach
// step below), new fresh enrichments include it. Items naturally migrate
// to having the flag as they're re-enriched on their normal TTL cycle.
const CACHE_PREFIX = 'live-news:enrichment:v1:';
const ENRICHMENT_TTL_S = 30 * 24 * 60 * 60; // 30 days
const ENRICH_BATCH_SIZE = 8;
const MAX_ENRICH_PER_REQUEST = 40;

/** Sentinel — both LLMs failed; never re-attempt within 30 days. */
const UNENRICHABLE_MARKER = '__WM_LIVE_NEWS_UNENRICHABLE__';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CombinedEnrichment {
  summary: string;
  latitude: number;
  longitude: number;
  locationName: string;
  country: string;       // ISO 3166-1 alpha-2 (uppercase)
  confidence: number;    // 0..1
  /**
   * True when the story describes an active armed-conflict event —
   * airstrike, ground combat, missile/drone strike, ceasefire, casualty
   * report, etc. Used by iOS to:
   *   1. Surface the item under the CONFLICT chip in the feed.
   *   2. Pin it on the map's conflict layer (lat/lng come from the
   *      same enrichment call, so no separate location step is needed).
   */
  isConflict: boolean;
}

interface LlmResultEntry {
  id?: string;
  summary?: string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  locationName?: string | null;
  country?: string | null;
  confidence?: number | string | null;
  isConflict?: boolean | string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Country normalization — accept alpha-3 and common full names
// ─────────────────────────────────────────────────────────────────────────────

const ALPHA3_TO_ALPHA2: Record<string, string> = {
  USA: 'US', GBR: 'GB', RUS: 'RU', CHN: 'CN', JPN: 'JP', DEU: 'DE',
  FRA: 'FR', ITA: 'IT', ESP: 'ES', CAN: 'CA', AUS: 'AU', BRA: 'BR',
  IND: 'IN', MEX: 'MX', NLD: 'NL', BEL: 'BE', CHE: 'CH', SWE: 'SE',
  NOR: 'NO', DNK: 'DK', FIN: 'FI', POL: 'PL', UKR: 'UA', KAZ: 'KZ',
  TUR: 'TR', IRN: 'IR', IRQ: 'IQ', ISR: 'IL', PSE: 'PS', SYR: 'SY',
  LBN: 'LB', JOR: 'JO', SAU: 'SA', ARE: 'AE', QAT: 'QA', YEM: 'YE',
  EGY: 'EG', SDN: 'SD', LBY: 'LY', TUN: 'TN', DZA: 'DZ', MAR: 'MA',
  ETH: 'ET', SOM: 'SO', KEN: 'KE', NGA: 'NG', GHA: 'GH', ZAF: 'ZA',
  AFG: 'AF', PAK: 'PK', BGD: 'BD', LKA: 'LK', NPL: 'NP', MMR: 'MM',
  THA: 'TH', VNM: 'VN', PHL: 'PH', IDN: 'ID', MYS: 'MY', SGP: 'SG',
  KOR: 'KR', PRK: 'KP', TWN: 'TW', HKG: 'HK', MAC: 'MO',
  ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE', VEN: 'VE', CUB: 'CU',
  IRL: 'IE', PRT: 'PT', GRC: 'GR', ROU: 'RO', BGR: 'BG', HUN: 'HU',
  CZE: 'CZ', SVK: 'SK', AUT: 'AT', SVN: 'SI', HRV: 'HR', SRB: 'RS',
  BIH: 'BA', MKD: 'MK', ALB: 'AL', MDA: 'MD', BLR: 'BY', LTU: 'LT',
  LVA: 'LV', EST: 'EE', GEO: 'GE', ARM: 'AM', AZE: 'AZ',
};

const NAME_TO_ALPHA2: Record<string, string> = {
  'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', 'AMERICA': 'US',
  'UNITED KINGDOM': 'GB', 'BRITAIN': 'GB', 'GREAT BRITAIN': 'GB', 'ENGLAND': 'GB',
  'RUSSIA': 'RU', 'RUSSIAN FEDERATION': 'RU',
  'CHINA': 'CN', "PEOPLE'S REPUBLIC OF CHINA": 'CN',
  'GERMANY': 'DE', 'FRANCE': 'FR', 'ITALY': 'IT', 'SPAIN': 'ES',
  'JAPAN': 'JP', 'CANADA': 'CA', 'AUSTRALIA': 'AU', 'BRAZIL': 'BR',
  'INDIA': 'IN', 'MEXICO': 'MX', 'UKRAINE': 'UA',
  'NORTH KOREA': 'KP', 'SOUTH KOREA': 'KR', 'KOREA': 'KR',
  'IRAN': 'IR', 'IRAQ': 'IQ', 'ISRAEL': 'IL', 'PALESTINE': 'PS',
  'SAUDI ARABIA': 'SA', 'UNITED ARAB EMIRATES': 'AE', 'UAE': 'AE',
  'EUROPEAN UNION': 'EU', 'EU': 'EU',
  'TAIWAN': 'TW', 'HONG KONG': 'HK',
  'GLOBAL': 'ZZ', 'INTERNATIONAL': 'ZZ', 'WORLDWIDE': 'ZZ',
};

/** Returns a 2-letter alpha-2 code or null if input is unrecognizable. */
function normalizeCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s.length === 0) return null;
  // Already alpha-2 — accept any 2-letter code (we don't validate against full ISO list)
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) return s;
  // Alpha-3 → alpha-2
  if (s.length === 3 && ALPHA3_TO_ALPHA2[s]) return ALPHA3_TO_ALPHA2[s];
  // Full name → alpha-2
  if (NAME_TO_ALPHA2[s]) return NAME_TO_ALPHA2[s];
  // Common case-y typos: "United-States", trailing punctuation
  const cleaned = s.replace(/[^A-Z\s]/g, '').replace(/\s+/g, ' ').trim();
  if (NAME_TO_ALPHA2[cleaned]) return NAME_TO_ALPHA2[cleaned];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — gates whether a result is "good enough" or needs Claude fallback
// ─────────────────────────────────────────────────────────────────────────────

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Validate + normalize a raw LLM entry into our canonical cache shape.
 * Returns null if any required field is missing or malformed — that
 * triggers the Claude fallback for this specific item.
 */
function validateEntry(entry: LlmResultEntry): CombinedEnrichment | null {
  // Summary — bumped to allow up to 3 paragraphs (~2500 chars). Lower bound
  // dropped to 30 so genuinely-thin source material (one-sentence wires) can
  // still produce a valid short summary instead of forcing an LLM retry.
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
  if (summary.length < 30 || summary.length > 2500) return null;

  // Location coordinates
  const lat = toFiniteNumber(entry.lat);
  const lng = toFiniteNumber(entry.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  // Country
  const country = normalizeCountry(entry.country);
  if (!country) return null;

  // Location name
  const locationName = typeof entry.locationName === 'string' ? entry.locationName.trim() : '';
  if (locationName.length === 0) return null;

  // Confidence (looser — coerce, clamp, default if missing)
  const confRaw = toFiniteNumber(entry.confidence);
  const confidence = confRaw !== null ? Math.min(1, Math.max(0, confRaw)) : 0.5;

  // isConflict — accept boolean, plus a few common stringly-typed forms
  // that LLMs sometimes emit instead of strict JSON booleans.
  const isConflict = (() => {
    const raw = entry.isConflict;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const s = raw.trim().toLowerCase();
      return s === 'true' || s === 'yes' || s === '1';
    }
    return false; // missing or null → default to non-conflict
  })();

  return { summary, latitude: lat, longitude: lng, locationName, country, confidence, isConflict };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a news enrichment service. For each news item you receive, return a summary, a location, AND a conflict-classification flag in a single JSON response.

# 1. Summary (the "summary" field)

Plain English. The reader should grasp the story at a glance, with low effort, and walk away with real context.

Length: 1 to 3 paragraphs. Match the depth of the source — thin wire stories get 1 short paragraph; substantial stories get 2 to 3 paragraphs. Do not pad. Maximum ~400 words total.

Structure:
- Paragraph 1: the key event (who, what, where, when) and the substance — how it happened, who is affected, what numbers / parties / timeline matter.
- Paragraph 2 (when warranted): the broader context — why this matters, the relevant background that makes the event legible.
- Paragraph 3 (when warranted): consequences or what's next — only if the source supports it.

Use blank lines (\\n\\n) between paragraphs in the output string.

Language:
- Plain English. Use everyday words instead of formal or technical ones:
    "agreed" not "concurred", "talks" not "negotiations" when interchangeable,
    "stopped" not "discontinued", "started" not "commenced".
- Short sentences. Active voice. Past or present tense, never future.
- No filler ("It is important to note that..."), no rhetorical questions.
- No source attribution ("According to Reuters..."), no quoted headlines.

Sourcing:
- Use ONLY facts in the input title and description.
- You MAY add neutral background context drawn from common knowledge about named entities (countries, companies, public figures, ongoing conflicts) when it helps the reader understand the event.

# 2. Location (the "lat", "lng", "locationName", "country", "confidence" fields)

Where the news is HAPPENING (not where the outlet is based).

Rules:
- ALWAYS return a best-guess location, even when uncertain. Lower the confidence rather than skipping.
- Resolve indirect references: "the Kremlin" → Moscow, "Pentagon" → Arlington VA, "Wall Street" → New York.
- "country" MUST be a 2-letter ISO 3166-1 alpha-2 code in UPPERCASE (e.g., "US", "RU", "UA", "DE", "CN"). Never alpha-3 ("USA"). Never full names ("United States"). Never null.
- For genuinely-global stories without a clear focal country: use "ZZ" for country and the country centroid most relevant to the headline.
- For European Union stories with no specific member state: use "EU".
- Confidence: 0.9+ when a specific city is named, 0.6–0.8 for inferred city, 0.3–0.5 for country-level guess, 0.1–0.3 for very speculative.

# 3. Conflict classification (the "isConflict" field)

Set "isConflict": true when the story describes an active armed-conflict event happening on the ground. Use a strict definition — the goal is to keep the conflict feed signal-heavy.

Conflict TRUE examples:
- Airstrike, missile strike, drone strike, artillery shelling
- Ground combat, firefight, ambush, raid, infantry assault
- Military offensive, troop movements into hostile territory
- Casualty reports, bombing aftermath, hostages, war crimes
- Ceasefire announcements, prisoner exchanges (active conflict context)
- Civilian deaths from active fighting

Conflict FALSE examples:
- Diplomatic statements with no kinetic event ("Iran condemns…", "Russia warns…")
- Political analysis, op-eds, retrospectives
- Defense procurement, military exercises (no actual combat), force posture
- Legal proceedings (war crimes trials are FALSE; war crimes happening today are TRUE)
- Civil unrest / protests — those are not armed conflict
- Cyber operations, sanctions, intelligence — those have their own categories

When in doubt, prefer FALSE. We'd rather miss a borderline item than flood the conflict feed with diplomatic chatter.

# Output format

A JSON object with a "results" array, one entry per input id, exactly:

{
  "results": [
    {
      "id": "<input id>",
      "summary": "<1 to 3 paragraph plain-English summary, paragraphs separated by \\n\\n>",
      "lat": <number>,
      "lng": <number>,
      "locationName": "<human-readable, e.g. 'Kyiv, Ukraine'>",
      "country": "<2-letter alpha-2 code>",
      "confidence": <number 0..1>,
      "isConflict": <boolean — true only when the story describes an active armed-conflict event>
    }
  ]
}

Return JSON ONLY. No prose outside the JSON, no markdown fences, no code fences.`;

function buildPrompt(items: LiveNewsItem[]): string {
  const inputs = items.map((it) => ({
    id: it.titleHash,
    title: it.title,
    source: it.source,
    description: it.rawDescription ?? '',
  }));
  return `Enrich these ${items.length} news items:\n\n${JSON.stringify(inputs)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON parsing — accepts wrapped object OR bare array (Gemini's quirk)
// ─────────────────────────────────────────────────────────────────────────────

function extractJson(text: string): unknown | null {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  // Find first balanced object or array
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = stripped.indexOf(open);
    const end = stripped.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try { return JSON.parse(stripped.slice(start, end + 1)); } catch { /* try next */ }
    }
  }
  return null;
}

function extractResultsArray(parsed: unknown): LlmResultEntry[] | null {
  if (Array.isArray(parsed)) return parsed as LlmResultEntry[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)) {
    return (parsed as { results: LlmResultEntry[] }).results;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path: attach cached enrichment to items
// ─────────────────────────────────────────────────────────────────────────────

interface CachedEnrichment extends CombinedEnrichment {} // alias for clarity

/**
 * Reads cache for every item; mutates each item with cached enrichment
 * fields if available. Returns the items still missing enrichment.
 */
export async function attachCachedEnrichment(items: LiveNewsItem[]): Promise<LiveNewsItem[]> {
  if (items.length === 0) return [];

  const keys = items.map((it) => `${CACHE_PREFIX}${it.titleHash}`);
  const cache = await getCachedJsonBatch(keys);

  const missing: LiveNewsItem[] = [];
  let attached = 0;
  let negativeHits = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const cached = cache.get(keys[i]!);
    if (cached === undefined) {
      missing.push(item);
      continue;
    }
    if (cached === UNENRICHABLE_MARKER) {
      // Both LLMs declined this item before — never retry.
      negativeHits++;
      continue;
    }
    const e = cached as CachedEnrichment;
    if (e && typeof e.summary === 'string' && typeof e.latitude === 'number') {
      item.summary = e.summary;
      item.location = { latitude: e.latitude, longitude: e.longitude };
      item.locationName = e.locationName;
      item.country = e.country;
      item.confidence = e.confidence;
      // isConflict is new in cache v2 — defaults to false if missing,
      // not null, because cached entries that pre-date the field came
      // from a prompt that didn't classify (so no info, treat as non-conflict).
      item.isConflict = typeof e.isConflict === 'boolean' ? e.isConflict : false;
      attached++;
    }
  }

  console.log(
    `[live-news:enrich] attachCachedEnrichment: ${items.length} items, ` +
    `${attached} attached, ${negativeHits} negative, ${missing.length} missing. ` +
    `cache.size=${cache.size}`,
  );

  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path: enrich missing items via Gemini, fall back to Claude
// ─────────────────────────────────────────────────────────────────────────────

async function callGeminiBatch(batch: LiveNewsItem[]): Promise<Map<string, CombinedEnrichment>> {
  const result = await callGemini({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(batch),
    // 8 items × ~600 tokens output = ~4 800 tokens with the longer
    // 1-3 paragraph summaries. 12 000 cap leaves headroom for Gemini's
    // pretty-printed JSON formatting on busy news days.
    maxTokens: 12000,
    temperature: 0.2,
    jsonMode: true,
    apiKeyEnv: 'GEMINI_API_KEY_ENRICHMENT', // optional separate billing key
  });

  if (!result) return new Map();

  const parsed = extractJson(result.content);
  const results = extractResultsArray(parsed);
  if (!results) {
    console.warn(`[live-news:enrich] Gemini parse failure:`, result.content.slice(0, 200));
    return new Map();
  }

  const out = new Map<string, CombinedEnrichment>();
  for (const entry of results) {
    if (!entry?.id) continue;
    const validated = validateEntry(entry);
    if (validated) out.set(entry.id, validated);
  }

  console.log(
    `[live-news:enrich] Gemini: ${out.size}/${batch.length} valid · ` +
    `tokens in=${result.inputTokens} out=${result.outputTokens}`,
  );
  return out;
}

async function callClaudeFallback(items: LiveNewsItem[]): Promise<Map<string, CombinedEnrichment>> {
  if (items.length === 0) return new Map();

  const result = await callClaude({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(items),
    // Bumped from 4 000 → 8 000 to absorb the longer 1-3 paragraph summaries.
    maxTokens: 8000,
    temperature: 0.2,
    apiKeyEnv: 'ANTHROPIC_API_KEY_PARAPHRASE',
  });

  if (!result) {
    console.warn(`[live-news:enrich] Claude fallback returned null for ${items.length} items`);
    return new Map();
  }

  const parsed = extractJson(result.content);
  const results = extractResultsArray(parsed);
  if (!results) {
    console.warn(`[live-news:enrich] Claude fallback parse failure:`, result.content.slice(0, 200));
    return new Map();
  }

  const out = new Map<string, CombinedEnrichment>();
  for (const entry of results) {
    if (!entry?.id) continue;
    const validated = validateEntry(entry);
    if (validated) out.set(entry.id, validated);
  }

  console.log(
    `[live-news:enrich] Claude fallback: ${out.size}/${items.length} valid · ` +
    `tokens in=${result.inputTokens} out=${result.outputTokens}`,
  );
  return out;
}

async function enrichBatch(batch: LiveNewsItem[]): Promise<void> {
  if (batch.length === 0) return;

  // Tier 1: Gemini Flash Lite
  const geminiResults = await callGeminiBatch(batch);

  // Identify items that failed Gemini validation
  const failedItems = batch.filter((item) => !geminiResults.has(item.titleHash));

  // Tier 2: Claude Haiku fallback for ONLY the failures
  let claudeResults = new Map<string, CombinedEnrichment>();
  if (failedItems.length > 0) {
    console.log(`[live-news:enrich] ${failedItems.length} items failed Gemini validation — retrying with Claude`);
    claudeResults = await callClaudeFallback(failedItems);
  }

  // Write results to Redis
  let written = 0;
  let unenrichable = 0;

  await Promise.all(batch.map(async (item) => {
    const result = geminiResults.get(item.titleHash) ?? claudeResults.get(item.titleHash);
    const key = `${CACHE_PREFIX}${item.titleHash}`;
    if (result) {
      await setCachedJson(key, result, ENRICHMENT_TTL_S);
      written++;
    } else {
      // Both providers failed — permanent skip
      await setCachedJson(key, UNENRICHABLE_MARKER, ENRICHMENT_TTL_S);
      unenrichable++;
    }
  }));

  console.log(
    `[live-news:enrich] batch done: ${written}/${batch.length} enriched ` +
    `(${unenrichable} marked unenrichable). Tier breakdown: Gemini=${geminiResults.size}, Claude=${claudeResults.size}`,
  );
}

/**
 * Public: enrich all missing items in batches, with Gemini-then-Claude
 * provider chain. Caller fires-and-forgets via `keepAlive`.
 */
export async function enrichMissingAsync(missing: LiveNewsItem[]): Promise<void> {
  if (missing.length === 0) return;

  const slice = missing.slice(0, MAX_ENRICH_PER_REQUEST);
  if (slice.length < missing.length) {
    console.log(`[live-news:enrich] capping at ${MAX_ENRICH_PER_REQUEST}/${missing.length} items per request`);
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
