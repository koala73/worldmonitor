/**
 * World Brief generator — the hourly "AI World Brief" shown on top of the
 * conflict, live-news, and per-category feed sections.
 *
 * Reads the v6 RSS-clustering digest (`live-news:v6:digest`), ranks the
 * most-referenced clusters, and asks Gemini for an original-wording,
 * copyright-safe factual brief of each. Sections produced:
 *
 *   conflict   — clusters with `isConflict === true`, ranked by TOTAL source
 *                count (RSS + GDELT corroboration both count).
 *   liveNews   — all clusters, ranked by distinct RSS-publisher count only.
 *   categories — one section per intel topic (cyber, military, …): clusters
 *                whose enrich-LLM `topics[]` include that category, ranked
 *                by total source count.
 *
 * GDELT members deepen the ranking but never reach the LLM — only RSS
 * headlines + the RSS-supplied lede are sent for summarization, per the
 * pipeline rule that GDELT content never touches an LLM.
 */

import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { callGemini } from '../../_shared/llm';
import { type ClusteredItem } from '../../live-news/v6/_cluster';
import { resolveRegion, type RegionId } from '../../_shared/geo-regions';

/** v6 digest key — see server/live-news/v6/refresh.ts (DIGEST_KEY). */
const DIGEST_KEY = 'live-news:v6:digest';

export const WORLD_BRIEF_KEY = 'news:world-brief:v1';

/** Per-region brief Redis key — one payload per region, same shape as the
 *  global brief. The regional dispatcher writes these on its schedule. */
export const regionBriefKey = (regionId: RegionId): string =>
  `news:world-brief:region:${regionId}:v1`;

/** 25 h — long enough to survive ~a day of missed hourly crons. Staleness
 *  is surfaced to the user via `generatedAt` on the card. */
const WORLD_BRIEF_TTL_S = 25 * 60 * 60;

// ── Hourly snapshots ─────────────────────────────────────────────────────────
// Each generation also writes a time-stamped snapshot so the app can fetch the
// brief for a user's specific daily delivery hour (briefs are immutable per
// slot). An index (JSON array of available hour buckets) lets the reader
// resolve nearest-before without scanning. Both retained ~7 days.

/** 7-day retention for hourly snapshots + their index. */
const REGION_SNAPSHOT_TTL_S = 7 * 24 * 60 * 60;

/** UTC hour bucket "YYYYMMDDHH" — the snapshot granularity. */
export function regionBriefHourBucket(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

/** Parse "YYYYMMDDHH" (UTC) → epoch ms. */
export function hourBucketToMs(bucket: string): number {
  return Date.UTC(
    Number(bucket.slice(0, 4)),
    Number(bucket.slice(4, 6)) - 1,
    Number(bucket.slice(6, 8)),
    Number(bucket.slice(8, 10)),
  );
}

/** Snapshot key for a region at a specific hour bucket. */
export const regionBriefSnapshotKey = (regionId: RegionId, bucket: string): string =>
  `news:world-brief:region:${regionId}:hour:${bucket}`;

/** Index key — JSON array of a region's available hour buckets (pruned to the
 *  retention window) so the reader can resolve nearest-before in one GET. */
export const regionBriefIndexKey = (regionId: RegionId): string =>
  `news:world-brief:region:${regionId}:index`;

/** Add `bucket` to a region's snapshot index and prune anything past retention. */
async function updateRegionSnapshotIndex(regionId: RegionId, bucket: string): Promise<void> {
  const existing = (await getCachedJson(regionBriefIndexKey(regionId))) as string[] | null;
  const buckets = new Set(Array.isArray(existing) ? existing : []);
  buckets.add(bucket);
  const cutoff = Date.now() - REGION_SNAPSHOT_TTL_S * 1000;
  const pruned = [...buckets].filter((b) => hourBucketToMs(b) >= cutoff).sort();
  // Index lives slightly longer than the snapshots it points at.
  await setCachedJson(regionBriefIndexKey(regionId), pruned, REGION_SNAPSHOT_TTL_S + 3600);
}

// Brief corroboration floors — all measured on TOTAL sources (RSS + GDELT).
// No distinct-RSS requirement: we AI-summarize any sufficiently multi-outlet
// story (the copyright rule cares about outlet count, not RSS-vs-GDELT).

/** Live-news brief floor — ≥ this many total sources. */
const LIVE_NEWS_MIN_TOTAL = Number(process.env.WM_LIVENEWS_BRIEF_MIN_TOTAL) || 3;
/** Conflict brief floor — ≥ this many total sources. */
const CONFLICT_MIN_TOTAL = Number(process.env.WM_CONFLICT_MIN_TOTAL_SOURCES) || 3;
/** Category brief floor — ≥ this many total sources (copyright corroboration). */
const CATEGORY_BRIEF_MIN_TOTAL = Number(process.env.WM_CATEGORY_BRIEF_MIN_TOTAL) || 2;

const TOP_N = 8;
const MAX_MEMBER_HEADLINES = 10;
const MAX_TEXT_LEN = 850;
/** Cap on the per-cluster "all sources" list surfaced to the reader. */
const MAX_SOURCE_REFS = 30;
/** Parallel section builds — 11 sections, one Gemini call each. Capped so
 *  the burst stays within Gemini rate limits. */
const SECTION_CONCURRENCY = 4;

/** The 9 GDELT intel categories — kept in sync with enrich.ts VALID_TOPICS. */
export const CATEGORY_IDS = [
  'cyber', 'military', 'nuclear', 'sanctions', 'intelligence',
  'maritime', 'business', 'scitech', 'entertainment',
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export type BriefThreatLevel = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'MODERATE';
const THREAT_ORDER: BriefThreatLevel[] = ['MODERATE', 'ELEVATED', 'HIGH', 'CRITICAL'];

/** A single outlet covering a cluster — surfaced as a tappable resource
 *  in the detail view's "all sources" list. */
export interface WorldBriefSourceRef {
  name: string;
  url: string;
}

export interface WorldBriefCluster {
  /** v6 cluster id (canonical titleHash) — lets iOS deep-link to the feed. */
  id: string;
  /** Original-wording neutral headline (not copied from any outlet). */
  headline: string;
  /** Factual core: who / what / when / where. */
  whatHappened: string;
  /** One sentence on significance / wider implications. */
  whyItMatters: string;
  /** 2–4 free-form uppercase topical tags. */
  tags: string[];
  threatLevel: BriefThreatLevel;
  /** Ranking metric: total sources for conflict/category, RSS publishers
   *  for live-news. */
  sourceCount: number;
  /** Every outlet covering this story — RSS first, deduped by URL, capped.
   *  Surfaced as the tappable "all sources" list in the detail view. */
  sources: WorldBriefSourceRef[];
  link: string;
  imageUrl: string | null;
  locationName: string | null;
  publishedAt: number;
}

export interface WorldBriefSection {
  /** 1–2 sentence synthesis across all clusters in this section. */
  overview: string;
  threatLevel: BriefThreatLevel;
  clusters: WorldBriefCluster[];
}

export interface WorldBriefPayload {
  generatedAt: number;
  conflict: WorldBriefSection | null;
  liveNews: WorldBriefSection | null;
  /** One section per intel category. A null value means generation failed
   *  (LKG then restores the prior); an empty-clusters section means the
   *  category genuinely had nothing to brief this cycle. */
  categories: Record<string, WorldBriefSection | null>;
}

type BriefMode = 'conflict' | 'live-news' | CategoryId;

interface PickedCluster {
  cluster: ClusteredItem;
  /** Mode-appropriate source count used both for ranking and display. */
  score: number;
  /** Up to 10 RSS member headlines — the only content sent to the LLM. */
  rssHeadlines: string[];
}

// ── Ranking ────────────────────────────────────────────────────────────────

/** Up to MAX_MEMBER_HEADLINES member titles for the LLM — RSS members first;
 *  if the cluster has no usable RSS titles, fall back to any (GDELT) source
 *  titles so RSS-light clusters still get real input to summarize. */
function memberHeadlines(c: ClusteredItem): string[] {
  const pick = (rssOnly: boolean) =>
    c.sources
      .filter((s) => !rssOnly || s.origin === 'rss')
      .map((s) => s.title)
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .slice(0, MAX_MEMBER_HEADLINES);
  const rss = pick(true);
  return rss.length > 0 ? rss : pick(false);
}

/** Light URL normalisation for exact-duplicate detection — drops the
 *  fragment and trailing slashes and lowercases. */
function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '');
}

/** Normalised set of every source URL in a cluster. */
function clusterUrlSet(c: ClusteredItem): Set<string> {
  const set = new Set<string>();
  for (const src of c.sources) {
    if (src && typeof src.link === 'string' && src.link) set.add(normalizeUrl(src.link));
  }
  return set;
}

/** Two clusters cover the same event when they share more than one exact
 *  source URL — a guard for when the embedder fails to merge a story. */
function sharesDuplicateSources(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let common = 0;
  for (const url of small) {
    if (large.has(url) && ++common > 1) return true;
  }
  return false;
}

/** Build the capped, URL-deduped "all sources" list for a cluster. */
function buildSourceRefs(c: ClusteredItem): WorldBriefSourceRef[] {
  const seen = new Set<string>();
  const refs: WorldBriefSourceRef[] = [];
  for (const src of c.sources) {
    if (!src || typeof src.link !== 'string' || !src.link) continue;
    const key = normalizeUrl(src.link);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ name: (src.source || '').trim() || 'Source', url: src.link });
    if (refs.length >= MAX_SOURCE_REFS) break;
  }
  return refs;
}

/**
 * Pick the top-N most-referenced clusters for a section.
 *
 *   conflict   — `isConflict` clusters, ≥ MIN_RSS_SOURCES gate, scored by
 *                total source count.
 *   live-news  — all clusters, ≥ MIN_RSS_SOURCES gate, scored by distinct
 *                RSS-publisher count.
 *   category   — clusters whose enrich-LLM `topics[]` include the category,
 *                gated by the category corroboration rule (≥2 outlets, ≥1
 *                RSS — see `isCategoryCorroborated`). Scored by total
 *                source count.
 *
 * Ranked clusters are then greedily de-duplicated: a candidate sharing more
 * than one exact source URL with an already-picked cluster is the same
 * event (the embedder failed to merge it) and is skipped.
 */
function pickClusters(clusters: ClusteredItem[], mode: BriefMode): PickedCluster[] {
  const ranked = clusters
    .filter((c) => {
      if (!c || !Array.isArray(c.sources)) return false;
      if (mode === 'conflict') {
        return c.isConflict === true && c.sources.length >= CONFLICT_MIN_TOTAL;
      }
      if (mode === 'live-news') {
        return c.sources.length >= LIVE_NEWS_MIN_TOTAL;
      }
      // Category: match the enrich LLM `topics` OR the GDELT-keyword
      // `categories` (a cluster's GDELT category may not be in topics —
      // counting both lifts recall). Same keys on both sides (cyber … scitech).
      const inCategory =
        (Array.isArray(c.topics) && c.topics.includes(mode)) ||
        (Array.isArray(c.categories) && c.categories.includes(mode));
      return inCategory && c.sources.length >= CATEGORY_BRIEF_MIN_TOTAL;
    })
    .map((c) => ({
      cluster: c,
      // Rank every section by total source count — "most sourced" first.
      score: c.sources.length,
      urls: clusterUrlSet(c),
    }))
    .sort((a, b) => b.score - a.score || b.cluster.publishedAt - a.cluster.publishedAt);

  const picked: PickedCluster[] = [];
  const pickedUrlSets: Set<string>[] = [];
  for (const r of ranked) {
    if (pickedUrlSets.some((set) => sharesDuplicateSources(r.urls, set))) continue;
    picked.push({
      cluster: r.cluster,
      score: r.score,
      rssHeadlines: memberHeadlines(r.cluster),
    });
    pickedUrlSets.push(r.urls);
    if (picked.length >= TOP_N) break;
  }
  return picked;
}

// ── LLM prompt ───────────────────────────────────────────────────────────────

/** Editorial desk persona per section — sets the LLM's framing. */
const DESK_LABEL: Record<BriefMode, string> = {
  'conflict': 'a geopolitical conflict-monitoring intelligence desk',
  'live-news': 'a world-news intelligence desk',
  'cyber': 'a cybersecurity intelligence desk',
  'military': 'a defense and military-affairs desk',
  'nuclear': 'a nuclear-affairs and non-proliferation desk',
  'sanctions': 'a sanctions and trade-policy desk',
  'intelligence': 'an intelligence and espionage-affairs desk',
  'maritime': 'a maritime and naval-affairs desk',
  'business': 'a business and economics desk',
  'scitech': 'a science and technology desk',
  'entertainment': 'an entertainment and culture desk',
};

function systemPrompt(mode: BriefMode): string {
  const desk = DESK_LABEL[mode];
  return `You are the editor of ${desk}. You receive several news stories. Each story is a cluster of headlines from multiple independent outlets covering the SAME event, plus a short lede.

For EACH story, write an original, neutral, factual brief. This is critical:
- Do NOT copy or lightly reword any sentence from the supplied headlines or lede. Identify the underlying factual claims and restate them entirely in your own words.
- Report only facts corroborated by the supplied material. Specific figures, named people and organizations, dates, and places that recur across the sources ARE safe to include — facts are not copyrightable — but never reproduce a source's distinctive phrasing. Never speculate or add outside information.
- Stay neutral: no loaded adjectives, no editorializing; attribute contested or one-sided claims.

For each story produce:
- "headline": a concise, original, neutral headline — max 12 words.
- "whatHappened": 2-3 sentences laying out the core facts WITH their key specifics — who and what, when and where, the concrete figures, names, or scale involved, and the immediate factual context (what it follows, responds to, or changes). Substantive but tight — make a reader who only skims this actually understand the event.
- "whyItMatters": 1-2 sentences on the grounded significance — what it changes, who it affects, or what it signals — stated as established fact, NOT prediction or opinion. (e.g. "the third strike on the port this month" or "the largest single-day move since 2022" is fine; "this could trigger a wider war" is not.)
- "tags": 2 to 4 short UPPERCASE topical tags, e.g. "MISSILE STRIKE", "CEASEFIRE TALKS", "SANCTIONS", "ELECTION".
- "threatLevel": one of "CRITICAL", "HIGH", "ELEVATED", "MODERATE" — how severe or escalatory the event is${mode === 'conflict' ? '' : ' (for non-conflict news, judge overall significance instead)'}.

Also produce:
- "overview": a 2-4 sentence SYNTHESIS of the section as a whole — draw the through-line connecting the most significant developments, or lead with the single most important one and why it matters. Do NOT list every story; surface the bigger picture a reader should take away. Skip routine or minor items.
- "overallThreatLevel": one of "CRITICAL", "HIGH", "ELEVATED", "MODERATE" — the highest level the overall situation warrants.

Respond with ONLY a JSON object of exactly this shape:
{"overview":"...","overallThreatLevel":"...","stories":[{"index":1,"headline":"...","whatHappened":"...","whyItMatters":"...","tags":["..."],"threatLevel":"..."}]}
The "index" must match the STORY number. Include exactly one entry per story.`;
}

function userPrompt(picked: PickedCluster[]): string {
  const today = new Date().toISOString().split('T')[0];
  const blocks = picked.map((p, i) => {
    const lede = (p.cluster.summary || '').trim() || '(no lede available)';
    const headlines = p.rssHeadlines.map((h) => `  - ${h}`).join('\n') || '  - (none)';
    return `STORY ${i + 1}:\nLede: ${lede}\nHeadlines from ${p.rssHeadlines.length} outlet(s):\n${headlines}`;
  });
  return `Today is ${today}.\n\nHere are ${picked.length} news stories to brief:\n\n${blocks.join('\n\n')}`;
}

// ── Parsing / sanitizing LLM output ──────────────────────────────────────────

interface LlmStory {
  index: number;
  headline?: string;
  whatHappened?: string;
  whyItMatters?: string;
  tags?: unknown;
  threatLevel?: string;
}
interface LlmResponse {
  overview?: string;
  overallThreatLevel?: string;
  stories?: LlmStory[];
}

function normalizeThreat(value: unknown): BriefThreatLevel {
  const v = String(value || '').trim().toUpperCase();
  if (v === 'CRITICAL' || v === 'HIGH' || v === 'ELEVATED' || v === 'MODERATE') return v;
  return 'MODERATE';
}

function maxThreat(levels: BriefThreatLevel[]): BriefThreatLevel {
  return levels.reduce<BriefThreatLevel>(
    (acc, l) => (THREAT_ORDER.indexOf(l) > THREAT_ORDER.indexOf(acc) ? l : acc),
    'MODERATE',
  );
}

function clampText(value: unknown, fallback = ''): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return (s || fallback).slice(0, MAX_TEXT_LEN);
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toUpperCase().slice(0, 30);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
    if (out.length >= 4) break;
  }
  return out;
}

function parseLlmResponse(content: string): LlmResponse | null {
  try {
    const parsed = JSON.parse(content) as LlmResponse;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // jsonMode normally guarantees valid JSON; treat anything else as failure.
  }
  return null;
}

// ── Section build ────────────────────────────────────────────────────────────

/**
 * Build one brief section.
 *   • 0 clusters → an empty section (clusters: []) — a valid "nothing to
 *     brief" state, NOT a failure.
 *   • LLM call / parse failure → null — the caller then carries forward the
 *     prior section (last-known-good).
 * A partial LLM response is tolerated: clusters the model omitted fall back
 * to the raw cluster title/lede.
 */
async function buildSection(
  clusters: ClusteredItem[],
  mode: BriefMode,
): Promise<WorldBriefSection | null> {
  const picked = pickClusters(clusters, mode);
  if (picked.length === 0) {
    console.warn(`[world-brief] mode=${mode} no clusters — empty section`);
    return { overview: '', threatLevel: 'MODERATE', clusters: [] };
  }

  const result = await callGemini({
    system: systemPrompt(mode),
    prompt: userPrompt(picked),
    model: 'gemini-2.5-flash',
    jsonMode: true,
    // gemini-2.5-flash "thinking" draws down the output-token budget; left
    // unbounded, an 8-cluster JSON payload can truncate into invalid JSON.
    // The eachlabs OpenAI-compatible router exposes no thinking toggle, so
    // we can't disable it here — instead give the response a generous
    // max_tokens budget to absorb any thinking overhead.
    maxTokens: 12000,
    temperature: 0.3,
    // 60 s, not 30 s: since Gemini calls route through the eachlabs OpenAI-
    // compatible router (vs direct to Google), the round-trip got slower and
    // a 30 s budget aborted 2–3 of the 11 sections per run — each then fell
    // back to last-known-good. The refresh function has maxDuration=300 s and
    // uses ~60 s total, so even worst-case (4-concurrency, ~3 waves × 60 s) has
    // ample headroom. Lets slow-but-valid calls finish instead of going stale.
    timeoutMs: 60_000,
  });

  if (!result) {
    console.warn(`[world-brief] mode=${mode} Gemini call failed`);
    return null;
  }

  const parsed = parseLlmResponse(result.content);
  if (!parsed) {
    console.warn(
      `[world-brief] mode=${mode} unparseable LLM response ` +
        `(len=${result.content.length} tail=${JSON.stringify(result.content.slice(-120))})`,
    );
    return null;
  }

  const storyByIndex = new Map<number, LlmStory>();
  for (const s of parsed.stories ?? []) {
    const idx = Number(s?.index);
    if (Number.isFinite(idx)) storyByIndex.set(idx, s);
  }

  const briefClusters: WorldBriefCluster[] = picked.map((p, i) => {
    const story = storyByIndex.get(i + 1);
    return {
      id: p.cluster.id,
      headline: clampText(story?.headline, p.cluster.title),
      whatHappened: clampText(story?.whatHappened, p.cluster.summary || ''),
      whyItMatters: clampText(story?.whyItMatters),
      tags: sanitizeTags(story?.tags),
      threatLevel: normalizeThreat(story?.threatLevel),
      sourceCount: p.score,
      sources: buildSourceRefs(p.cluster),
      link: p.cluster.link,
      imageUrl: p.cluster.imageUrl ?? null,
      locationName: p.cluster.locationName ?? null,
      publishedAt: p.cluster.publishedAt,
    };
  });

  const sectionThreat = parsed.overallThreatLevel
    ? normalizeThreat(parsed.overallThreatLevel)
    : maxThreat(briefClusters.map((c) => c.threatLevel));

  return {
    overview: clampText(parsed.overview),
    threatLevel: sectionThreat,
    clusters: briefClusters,
  };
}

// ── Public entry points ──────────────────────────────────────────────────────

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** Read the current v6 digest (empty array on miss/bad shape). */
async function readDigest(): Promise<ClusteredItem[]> {
  const digest = (await getCachedJson(DIGEST_KEY, false, 5_000)) as ClusteredItem[] | null;
  return Array.isArray(digest) ? digest : [];
}

/**
 * One-shot diagnostic (logged once per global-brief cron): how the digest's
 * `country` field resolves, to decide the regional-coverage fix —
 *   • null            → no country at all (→ LLM backfill target)
 *   • unresolvedNonNull→ country set but not in geo-regions (→ alias-table gap)
 *   • resolved        → maps to a region
 * The country histogram surfaces mis-tagging: if US/GB dominate while the
 * active conflict theatres (UA/RU/IL/PS) are tiny, cross-border stories are
 * likely tagged to one (wrong) country (→ multi-country fix).
 */
function logDigestCountryStats(clusters: ClusteredItem[]): void {
  let nullCountry = 0;
  let resolved = 0;
  let unresolvedNonNull = 0;
  const byCountry = new Map<string, number>();
  for (const c of clusters) {
    const country = c.country?.trim();
    if (!country) { nullCountry++; continue; }
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1);
    if (resolveRegion(country)) resolved++;
    else unresolvedNonNull++;
  }
  const top = [...byCountry.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([c, n]) => `${c}:${n}`)
    .join(' ');
  console.log(
    `[world-brief:country-stats] total=${clusters.length} null=${nullCountry} ` +
      `resolved=${resolved} unresolvedNonNull=${unresolvedNonNull} | top: ${top}`,
  );
}

/**
 * Build a full brief payload (conflict + live-news + 9 categories) from a
 * given cluster set, with per-section last-known-good fallback against
 * `lkgKey`. Shared by the GLOBAL brief (all clusters) and each REGIONAL
 * brief (clusters filtered to one region) so both run identical logic.
 */
async function buildBriefPayload(
  clusters: ClusteredItem[],
  lkgKey: string,
  label: string,
): Promise<WorldBriefPayload> {
  const modes: BriefMode[] = ['conflict', 'live-news', ...CATEGORY_IDS];
  const built = await mapWithConcurrency(
    modes,
    SECTION_CONCURRENCY,
    (mode) => buildSection(clusters, mode),
  );
  const sectionByMode = new Map<BriefMode, WorldBriefSection | null>();
  modes.forEach((m, i) => sectionByMode.set(m, built[i] ?? null));

  const payload: WorldBriefPayload = {
    generatedAt: Date.now(),
    conflict: sectionByMode.get('conflict') ?? null,
    liveNews: sectionByMode.get('live-news') ?? null,
    categories: Object.fromEntries(
      CATEGORY_IDS.map((id) => [id, sectionByMode.get(id) ?? null]),
    ),
  };

  // LKG: a null section means generation failed — restore the prior one.
  const anyFailed = payload.conflict === null || payload.liveNews === null
    || CATEGORY_IDS.some((id) => payload.categories[id] === null);
  if (anyFailed) {
    const prev = (await getCachedJson(lkgKey, false, 3_000)) as WorldBriefPayload | null;
    if (prev) {
      if (!payload.conflict && prev.conflict) {
        payload.conflict = prev.conflict;
        console.log(`${label} conflict section preserved (LKG)`);
      }
      if (!payload.liveNews && prev.liveNews) {
        payload.liveNews = prev.liveNews;
        console.log(`${label} liveNews section preserved (LKG)`);
      }
      for (const id of CATEGORY_IDS) {
        const prevCat = prev.categories?.[id];
        if (!payload.categories[id] && prevCat) {
          payload.categories[id] = prevCat;
          console.log(`${label} ${id} section preserved (LKG)`);
        }
      }
    }
  }

  return payload;
}

/**
 * Generate all GLOBAL brief sections from the current v6 digest — conflict,
 * live-news, and one per intel category. On a per-section LLM failure the
 * previous section is carried forward (last-known-good).
 */
export async function generateWorldBrief(): Promise<WorldBriefPayload> {
  const clusters = await readDigest();
  console.log(`[world-brief] digest clusters=${clusters.length}`);
  logDigestCountryStats(clusters);
  return buildBriefPayload(clusters, WORLD_BRIEF_KEY, '[world-brief]');
}

/**
 * Generate the same brief sections for ONE region — the digest filtered to
 * clusters whose canonical country maps to `regionId` (resolveRegion). A
 * cluster with no resolvable country appears only in the GLOBAL brief, never
 * a regional one. Identical section logic to the global brief.
 */
export async function generateRegionalBrief(regionId: RegionId): Promise<WorldBriefPayload> {
  const all = await readDigest();
  const clusters = all.filter((c) => {
    // Multi-country: a cross-border story reaches every region any of its
    // involved countries map to. Fall back to the single `country` for
    // clusters not yet re-enriched with `countries`.
    const countries = c.countries?.length ? c.countries : (c.country ? [c.country] : []);
    return countries.some((co) => resolveRegion(co) === regionId);
  });
  console.log(`[world-brief:region:${regionId}] clusters=${clusters.length}/${all.length}`);
  return buildBriefPayload(clusters, regionBriefKey(regionId), `[world-brief:region:${regionId}]`);
}

export interface RefreshWorldBriefResult {
  status: 'ok' | 'empty';
  conflictClusters: number;
  liveNewsClusters: number;
  categoryClusters: number;
  generatedAt: string;
}

/** Cron entry point — generate the brief and write it to Redis. Idempotent. */
export async function refreshWorldBrief(): Promise<RefreshWorldBriefResult> {
  const startedAt = Date.now();
  const payload = await generateWorldBrief();
  await setCachedJson(WORLD_BRIEF_KEY, payload, WORLD_BRIEF_TTL_S);

  const conflictClusters = payload.conflict?.clusters.length ?? 0;
  const liveNewsClusters = payload.liveNews?.clusters.length ?? 0;
  const categoryClusters = CATEGORY_IDS.reduce(
    (sum, id) => sum + (payload.categories[id]?.clusters.length ?? 0),
    0,
  );
  const perCategory = CATEGORY_IDS
    .map((id) => `${id}=${payload.categories[id]?.clusters.length ?? 0}`)
    .join(' ');
  console.log(
    `[world-brief] DONE total=${Date.now() - startedAt}ms ` +
      `conflict=${conflictClusters} liveNews=${liveNewsClusters} ${perCategory}`,
  );

  return {
    status: conflictClusters + liveNewsClusters + categoryClusters > 0 ? 'ok' : 'empty',
    conflictClusters,
    liveNewsClusters,
    categoryClusters,
    generatedAt: new Date(payload.generatedAt).toISOString(),
  };
}

/**
 * Cron entry — generate ONE region's brief and write it to its Redis key.
 * Called by the region-major dispatcher for whichever regions are due.
 * Idempotent.
 */
export async function refreshRegionalBrief(regionId: RegionId): Promise<RefreshWorldBriefResult> {
  const startedAt = Date.now();
  const payload = await generateRegionalBrief(regionId);
  await setCachedJson(regionBriefKey(regionId), payload, WORLD_BRIEF_TTL_S);

  // Time-stamped snapshot (+ index) so the app can fetch the brief for a
  // user's specific delivery hour — briefs are immutable per slot.
  const bucket = regionBriefHourBucket(new Date());
  await setCachedJson(regionBriefSnapshotKey(regionId, bucket), payload, REGION_SNAPSHOT_TTL_S);
  await updateRegionSnapshotIndex(regionId, bucket);

  const conflictClusters = payload.conflict?.clusters.length ?? 0;
  const liveNewsClusters = payload.liveNews?.clusters.length ?? 0;
  const categoryClusters = CATEGORY_IDS.reduce(
    (sum, id) => sum + (payload.categories[id]?.clusters.length ?? 0),
    0,
  );
  console.log(
    `[world-brief:region:${regionId}] DONE total=${Date.now() - startedAt}ms ` +
      `conflict=${conflictClusters} liveNews=${liveNewsClusters} categories=${categoryClusters}`,
  );

  return {
    status: conflictClusters + liveNewsClusters + categoryClusters > 0 ? 'ok' : 'empty',
    conflictClusters,
    liveNewsClusters,
    categoryClusters,
    generatedAt: new Date(payload.generatedAt).toISOString(),
  };
}
