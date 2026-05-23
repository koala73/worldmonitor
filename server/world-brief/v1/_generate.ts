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
import { isCategoryCorroborated, type ClusteredItem } from '../../live-news/v6/_cluster';

/** v6 digest key — see server/live-news/v6/refresh.ts (DIGEST_KEY). */
const DIGEST_KEY = 'live-news:v6:digest';

export const WORLD_BRIEF_KEY = 'news:world-brief:v1';

/** 25 h — long enough to survive ~a day of missed hourly crons. Staleness
 *  is surfaced to the user via `generatedAt` on the card. */
const WORLD_BRIEF_TTL_S = 25 * 60 * 60;

/** Distinct-RSS-publisher gate — matches the live-news/conflict read gate. */
const MIN_RSS_SOURCES = Number(process.env.WM_V6_MIN_SOURCES) || 3;

const TOP_N = 8;
const MAX_MEMBER_HEADLINES = 10;
const MAX_TEXT_LEN = 600;
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

function rssSourceCount(c: ClusteredItem): number {
  return c.sources.filter((s) => s.origin === 'rss').length;
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
        return c.isConflict === true && rssSourceCount(c) >= MIN_RSS_SOURCES;
      }
      if (mode === 'live-news') {
        return rssSourceCount(c) >= MIN_RSS_SOURCES;
      }
      return (
        Array.isArray(c.topics) && c.topics.includes(mode) && isCategoryCorroborated(c)
      );
    })
    .map((c) => ({
      cluster: c,
      // live-news ranks by distinct RSS publishers; conflict + categories
      // rank by total source count (RSS + GDELT corroboration).
      score: mode === 'live-news' ? rssSourceCount(c) : c.sources.length,
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
      rssHeadlines: r.cluster.sources
        .filter((s) => s.origin === 'rss')
        .slice(0, MAX_MEMBER_HEADLINES)
        .map((s) => s.title)
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0),
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
- Do NOT copy or lightly reword any sentence from the supplied headlines or lede. Identify the underlying factual claims — who, what, when, where — and restate them entirely in your own words.
- Report only facts corroborated by the supplied material. Never speculate or add outside information.
- Stay neutral: no loaded adjectives, no editorializing; attribute contested or one-sided claims.

For each story produce:
- "headline": a concise, original, neutral headline — max 12 words.
- "whatHappened": 1-2 sentences stating the core facts (who / what / when / where).
- "whyItMatters": one sentence on the significance or wider implications.
- "tags": 2 to 4 short UPPERCASE topical tags, e.g. "MISSILE STRIKE", "CEASEFIRE TALKS", "SANCTIONS", "ELECTION".
- "threatLevel": one of "CRITICAL", "HIGH", "ELEVATED", "MODERATE" — how severe or escalatory the event is${mode === 'conflict' ? '' : ' (for non-conflict news, judge overall significance instead)'}.

Also produce:
- "overview": a SHORT summary — 2 to 4 sentences, no more. Cover only the handful of developments of genuine significance; do NOT try to touch every story. Skip routine or minor items entirely.
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
    maxTokens: 8000,
    temperature: 0.3,
    timeoutMs: 30_000,
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

/**
 * Generate all brief sections from the current v6 digest — conflict,
 * live-news, and one per intel category. On a per-section LLM failure the
 * previous section is carried forward (last-known-good).
 */
export async function generateWorldBrief(): Promise<WorldBriefPayload> {
  const digest = (await getCachedJson(DIGEST_KEY, false, 5_000)) as ClusteredItem[] | null;
  const clusters = Array.isArray(digest) ? digest : [];
  console.log(`[world-brief] digest clusters=${clusters.length}`);

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
    const prev = (await getCachedJson(WORLD_BRIEF_KEY, false, 3_000)) as WorldBriefPayload | null;
    if (prev) {
      if (!payload.conflict && prev.conflict) {
        payload.conflict = prev.conflict;
        console.log('[world-brief] conflict section preserved (LKG)');
      }
      if (!payload.liveNews && prev.liveNews) {
        payload.liveNews = prev.liveNews;
        console.log('[world-brief] liveNews section preserved (LKG)');
      }
      for (const id of CATEGORY_IDS) {
        const prevCat = prev.categories?.[id];
        if (!payload.categories[id] && prevCat) {
          payload.categories[id] = prevCat;
          console.log(`[world-brief] ${id} section preserved (LKG)`);
        }
      }
    }
  }

  return payload;
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
