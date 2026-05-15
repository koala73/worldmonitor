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
import { getCachedJson, getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { LiveNewsItem } from './_normalize';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Cache prefix kept at v1 — instead of bumping the version (which would
// invalidate every cached enrichment and cause a re-enrichment storm), we
// detect "stale short-summary" entries via length check at read time and
// re-enrich them gradually as items come back through the pipeline. New
// `region` field is similarly additive: old entries decode it as `null`
// and we re-derive from country when populating.
const CACHE_PREFIX = 'live-news:enrichment:v1:';
const ENRICHMENT_TTL_S = 3 * 24 * 60 * 60; // 3 days — project-wide max retention
const ENRICH_BATCH_SIZE = 8;
const MAX_ENRICH_PER_REQUEST = 40;

// Minimum summary length to consider a cache entry valid. Items below this
// were enriched under the older "1-3 paragraph" prompt — they get treated
// as cache-misses and re-enriched against the new "AT LEAST 3 paragraph"
// prompt. Existing valid entries (already 3 paragraphs) pass through.
const SUMMARY_MIN_LEN = 600;
const SUMMARY_MAX_LEN = 4_000;

// Shared enrichment cache — keyed by sha256(link). Same key format as
// intel-news's enrich.ts, so a URL enriched by either pipeline benefits
// the other (RSS feeds and GDELT often surface the same article).
// Version v2 matches intel-news; bumping is coordinated across pipelines.
//
// Uses Web Crypto (`globalThis.crypto.subtle`) instead of Node's
// `crypto.createHash` because this module is transitively imported by
// Edge functions (Vercel Edge doesn't expose Node built-ins). Same
// SHA-256 output as `createHash('sha256').update(link).digest('hex')`,
// just async — call sites already run inside async functions, so the
// `await` is free.
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sharedCacheKey(link: string): Promise<string> {
  return `enrichment-cache:v2:${await sha256Hex(link)}`;
}

const SHARED_CACHE_TTL_S = 3 * 24 * 60 * 60; // 3-day project max

/** Shape of values stored in the shared cross-pipeline cache. Same as the
 *  intel-news EnrichmentPayload — both pipelines must read/write this
 *  shape for cross-pipeline reuse to work. */
interface SharedEnrichmentPayload {
  summary: string;
  region: string;
  country?: string;
  locationName?: string;
  lat?: number;
  lng?: number;
}

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
  /**
   * 8-region taxonomy code (`"us"`, `"middle_east"`, etc.) derived from
   * `country` via `regionForCountry()`. iOS prefers this over the country-
   * code fallback for chip-filtering. Optional for backwards compat with
   * cache entries written before this field was added.
   */
  region?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Country → 8-region mapping. Mirrors the iOS FeedRegion taxonomy so the
// region rawValue we ship matches what iOS expects in `FeedRegion(rawValue:)`.
// ─────────────────────────────────────────────────────────────────────────────

const LATIN_AMERICA_SET = new Set<string>([
  // Mexico + Central America
  'MX', 'GT', 'BZ', 'SV', 'HN', 'NI', 'CR', 'PA',
  // Caribbean
  'CU', 'DO', 'HT', 'JM', 'PR', 'TT', 'BS', 'BB',
  // South America
  'BR', 'AR', 'CL', 'PE', 'CO', 'VE', 'EC', 'BO', 'PY', 'UY', 'GY', 'SR',
]);

const MIDDLE_EAST_SET = new Set<string>([
  'TR', 'IL', 'PS', 'JO', 'LB', 'SY', 'IQ', 'IR',
  'SA', 'AE', 'QA', 'BH', 'KW', 'OM', 'YE', 'EG',
]);

const EUROPE_SET = new Set<string>([
  'GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'LU',
  'AT', 'CH', 'DK', 'SE', 'NO', 'FI', 'IS', 'EE', 'LV', 'LT',
  'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'CY', 'MT', 'HR',
  'SI', 'RS', 'BA', 'AL', 'MK', 'ME', 'MD', 'UA', 'BY', 'RU',
  'GE', 'AM', 'AZ',
]);

const ASIA_SET = new Set<string>([
  'CN', 'JP', 'KR', 'KP', 'TW', 'HK', 'MO',
  'IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MV',
  'MM', 'TH', 'VN', 'LA', 'KH', 'MY', 'SG', 'ID', 'PH', 'BN', 'TL',
  'MN', 'KZ', 'UZ', 'KG', 'TJ', 'TM', 'AF',
]);

const AFRICA_SET = new Set<string>([
  'DZ', 'TN', 'LY', 'MA', 'EH', 'SD', 'SS',
  'NG', 'GH', 'CI', 'SN', 'ML', 'BF', 'NE', 'TD', 'CM',
  'ET', 'ER', 'DJ', 'SO', 'KE', 'UG', 'TZ', 'RW', 'BI',
  'CG', 'CD', 'AO', 'ZM', 'ZW', 'MW', 'MZ', 'BW', 'NA',
  'ZA', 'LS', 'SZ', 'MG', 'MU',
]);

const OCEANIA_SET = new Set<string>([
  'AU', 'NZ', 'PG', 'FJ', 'SB', 'VU', 'NC', 'PF', 'WS', 'TO', 'KI', 'FM', 'MH', 'PW', 'NR', 'TV',
]);

/** Maps an ISO 3166-1 alpha-2 country code to the 8-region taxonomy
 *  rawValue iOS expects. Returns `null` for codes that don't map (e.g.
 *  "ZZ" global, "EU" generic, Antarctica) — iOS treats nil region the
 *  same as "no region tag" and the item only surfaces under ALL. */
function regionForCountry(country: string): string | null {
  const code = country.trim().toUpperCase();
  if (code === 'US') return 'us';
  if (code === 'CA') return 'canada';
  if (LATIN_AMERICA_SET.has(code)) return 'latin_america';
  if (MIDDLE_EAST_SET.has(code))   return 'middle_east';
  if (EUROPE_SET.has(code))        return 'europe';
  if (AFRICA_SET.has(code))        return 'africa';
  if (ASIA_SET.has(code))          return 'asia';
  if (OCEANIA_SET.has(code))       return 'oceania';
  return null;
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
  // Summary — must be 3 paragraphs minimum per the new prompt. Bumped from
  // 30/2500 → 600/4000 to enforce. Items below the floor either had a thin
  // source the LLM couldn't expand, or a bad LLM response — either way
  // they bounce to Claude fallback for retry.
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
  if (summary.length < SUMMARY_MIN_LEN || summary.length > SUMMARY_MAX_LEN) return null;

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

  // Region — derived server-side from the validated country code. iOS
  // prefers this rawValue over the country-code fallback when filtering.
  const region = regionForCountry(country) ?? undefined;

  return { summary, latitude: lat, longitude: lng, locationName, country, confidence, isConflict, region };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a news enrichment service. For each news item you receive, return a summary, a location, AND a conflict-classification flag in a single JSON response.

# 1. Summary (the "summary" field)

Plain English. The reader should grasp the story at a glance, with low effort, and walk away with real context.

Length: AT LEAST 3 paragraphs. 200-400 words total. Each paragraph 2-4 sentences. Do not produce a single-paragraph summary even if the source is thin — use neutral background context (drawn from common knowledge about the named entities) to round out the story to 3 paragraphs.

Structure:
- Paragraph 1: the key event (who, what, where, when) and the substance — how it happened, who is affected, what numbers / parties / timeline matter.
- Paragraph 2: the broader context — why this matters, the relevant background that makes the event legible. Always include this paragraph.
- Paragraph 3: consequences, reactions, or what's next. Always include this paragraph.

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
 *
 * Cache lookup order (short-circuits on first hit):
 *   1. **Shared cross-pipeline cache** (`enrichment-cache:v2:<sha256(link)>`)
 *      — populated by intel-news enrichment. If hit, we can skip the LLM
 *      call entirely and reuse the work the other pipeline already paid for.
 *      The shared cache lacks `isConflict` and `confidence`, so we conservatively
 *      default isConflict to false (the live-news pipeline classifies
 *      conflict, intel-news doesn't, so a shared-cache hit can't tell us
 *      definitively — items the user wants in CONFLICT will get re-enriched
 *      next pass via the live-news cache miss path).
 *   2. **Live-news titleHash cache** (`live-news:enrichment:v1:<titleHash>`)
 *      — populated by live-news's own enrichment runs. Has the full shape
 *      including isConflict.
 *
 * Items below `SUMMARY_MIN_LEN` are treated as cache-miss to force re-enrich
 * under the new "AT LEAST 3 paragraphs" prompt — gradual migration without
 * a cache-version bump that would invalidate everything at once.
 */
export async function attachCachedEnrichment(items: LiveNewsItem[]): Promise<LiveNewsItem[]> {
  if (items.length === 0) return [];

  // Issue both cache reads in parallel. Shared-cache keys are computed
  // up front (they're async because we use Web Crypto SHA-256 for Edge
  // compatibility — see `sharedCacheKey` above).
  const ownKeys = items.map((it) => `${CACHE_PREFIX}${it.titleHash}`);
  const sharedKeys = await Promise.all(items.map((it) => sharedCacheKey(it.link)));

  const [ownCache, sharedHits] = await Promise.all([
    getCachedJsonBatch(ownKeys),
    Promise.all(sharedKeys.map((k) => getCachedJson(k) as Promise<SharedEnrichmentPayload | null>)),
  ]);

  const missing: LiveNewsItem[] = [];
  let attachedShared = 0;
  let attachedOwn = 0;
  let staleRefresh = 0;
  let negativeHits = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;

    // 1. Try shared cross-pipeline cache.
    const sharedHit = sharedHits[i];
    if (sharedHit && typeof sharedHit.summary === 'string' &&
        sharedHit.summary.length >= SUMMARY_MIN_LEN && sharedHit.region) {
      item.summary = sharedHit.summary;
      if (typeof sharedHit.lat === 'number' && typeof sharedHit.lng === 'number') {
        item.location = { latitude: sharedHit.lat, longitude: sharedHit.lng };
      }
      if (sharedHit.locationName) item.locationName = sharedHit.locationName;
      if (sharedHit.country) item.country = sharedHit.country;
      item.region = sharedHit.region;
      // Shared cache doesn't carry isConflict — leave existing value or
      // default to false. Items that should be in CONFLICT chip will get
      // their isConflict bit set when live-news re-enriches them naturally.
      if (typeof item.isConflict !== 'boolean') item.isConflict = false;
      attachedShared++;
      continue;
    }

    // 2. Fall through to live-news titleHash cache.
    const cached = ownCache.get(ownKeys[i]!);
    if (cached === undefined) {
      missing.push(item);
      continue;
    }
    if (cached === UNENRICHABLE_MARKER) {
      negativeHits++;
      continue;
    }
    const e = cached as CachedEnrichment;
    if (e && typeof e.summary === 'string' && typeof e.latitude === 'number') {
      // Stale-summary check — old prompt produced 1-2 paragraph summaries
      // (length < 600); treat those as cache-miss so they re-enrich into
      // the new format.
      if (e.summary.length < SUMMARY_MIN_LEN) {
        missing.push(item);
        staleRefresh++;
        continue;
      }
      item.summary = e.summary;
      item.location = { latitude: e.latitude, longitude: e.longitude };
      item.locationName = e.locationName;
      item.country = e.country;
      item.confidence = e.confidence;
      item.isConflict = typeof e.isConflict === 'boolean' ? e.isConflict : false;
      // Region — prefer cached region (newly added field), fall back to
      // deriving from country for legacy cache entries.
      item.region = e.region ?? regionForCountry(e.country) ?? undefined;
      attachedOwn++;
    }
  }

  console.log(
    `[live-news:enrich] attachCachedEnrichment: ${items.length} items, ` +
    `${attachedShared} from shared cache, ${attachedOwn} from own cache, ` +
    `${staleRefresh} stale (forced re-enrich), ` +
    `${negativeHits} negative, ${missing.length} missing.`,
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
    caller: 'live-news:enrich-combined', // TEMP (Helicone)
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
    caller: 'live-news:enrich-combined-fallback', // TEMP (Helicone)
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

  // Write results to Redis. Each successful enrichment writes to TWO
  // caches:
  //   • own (live-news:enrichment:v1:<titleHash>) — full live-news shape
  //     with isConflict + confidence; consumed by attachCachedEnrichment
  //     on the next live-news pass.
  //   • shared (enrichment-cache:v2:<sha256(link)>) — minimal payload
  //     consumed by intel-news's enrich.ts when GDELT picks up the same
  //     URL. Cross-pipeline cache hit eliminates the duplicate LLM call.
  let written = 0;
  let unenrichable = 0;

  await Promise.all(batch.map(async (item) => {
    const result = geminiResults.get(item.titleHash) ?? claudeResults.get(item.titleHash);
    const ownKey = `${CACHE_PREFIX}${item.titleHash}`;
    if (result) {
      const sharedPayload: SharedEnrichmentPayload = {
        summary: result.summary,
        region: result.region ?? regionForCountry(result.country) ?? 'us',
        country: result.country,
        locationName: result.locationName,
        lat: result.latitude,
        lng: result.longitude,
      };
      const sharedKey = await sharedCacheKey(item.link);
      await Promise.all([
        setCachedJson(ownKey, result, ENRICHMENT_TTL_S),
        setCachedJson(sharedKey, sharedPayload, SHARED_CACHE_TTL_S),
      ]);
      written++;
    } else {
      // Both providers failed — permanent skip on the OWN cache only.
      // Don't poison the shared cache with this; intel-news might still
      // succeed with a different prompt structure for the same article.
      await setCachedJson(ownKey, UNENRICHABLE_MARKER, ENRICHMENT_TTL_S);
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
