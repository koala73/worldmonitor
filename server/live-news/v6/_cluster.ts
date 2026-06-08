/**
 * v6 clustering — Gemini embedding cosine + greedy clustering for RSS
 * items. Reuses the embed/cosine helpers from `_shared/embeddings.ts`,
 * but does NOT depend on the legacy LLM dedup logic. Produces clusters
 * ready to write to the v6 digest (longest description, first image,
 * sources[]).
 *
 * # Threshold
 *
 * 0.7 default — broader clusters bias per the product spec. Tune via
 * the const below if results need adjusting.
 */

import { embedBatch, float32ToBase64, base64ToFloat32 } from '../../_shared/embeddings';
import { getCachedJsonBatch, runRedisPipeline } from '../../_shared/redis';
import type { RawRssItem, GdeltItemLocation } from './_normalize';
import { fetchArticleBodyBatch } from './_article-fetcher';

/**
 * Default cosine threshold for two items to be considered the same
 * story. Override at runtime via `WM_V6_CLUSTER_THRESHOLD` (e.g. set
 * to `0.85` for tighter clusters or `0.78` for looser).
 *
 * Why 0.82: with `gemini-embedding-001` + `SEMANTIC_SIMILARITY` task
 * type at 768 dims, same-event news pairs typically cosine ~0.85-0.95,
 * tangentially-related ~0.65-0.80, unrelated ~0.50-0.70. 0.82 lands
 * just above the noise floor. The old 0.7 default was set for the
 * older `CLUSTERING` task type, which over-merged.
 */
const DEFAULT_THRESHOLD = 0.82;
function clusterThreshold(): number {
  const raw = process.env.WM_V6_CLUSTER_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_THRESHOLD;
}

/**
 * Cosine threshold for ATTACHING a GDELT item to an RSS cluster (stage 2).
 * Defaults to the main cluster threshold. GDELT vectors are built from
 * title + URL slug only, so they cosine a touch lower against an RSS centroid
 * (title + desc + body) — set `WM_V6_GDELT_ATTACH_THRESHOLD` (e.g. `0.78`) to
 * loosen attachment without a redeploy if corroboration looks thin.
 */
function gdeltAttachThreshold(base: number): number {
  const raw = process.env.WM_V6_GDELT_ATTACH_THRESHOLD;
  if (!raw) return base;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : base;
}

/** Cache prefix — bump whenever the embedder INPUT or model changes, so
 *  vectors built under different regimes never get compared:
 *    v2 — switched task type CLUSTERING → SEMANTIC_SIMILARITY
 *    v3 — embed input changed to title×2 + description×2 + body, and
 *         RSS items now embed fetched article-body text. A v2-cached
 *         vector (old `title — text` input) sits ~0.85 cosine from its
 *         v3 equivalent — enough to split a cluster at threshold 0.87.
 *    v4 — GDELT input gained the GKG entity/theme tail (title×2 + slug +
 *         entities), so GDELT vectors changed. The key now also carries
 *         the item ORIGIN (see `embedCacheKey`), which fixes a latent
 *         RSS/GDELT same-title collision — see that helper. */
const EMBED_CACHE_PREFIX = 'live-news:v6:embed:v4:';
const EMBED_TTL_S = 24 * 60 * 60;

/**
 * Embedding-cache key for an item. RSS and GDELT items can share a
 * `titleHash` (same headline, different pipeline) but their embed INPUT
 * differs — RSS embeds title+description+body, GDELT embeds title+slug+GKG
 * entities. Keying purely on `titleHash` let whichever origin embedded
 * first poison the other across runs (an RSS item inheriting a GDELT item's
 * thinner vector, or vice-versa). Folding the origin into the key gives the
 * two their own cache slots and their own in-memory vectors. */
function embedCacheKey(it: RawRssItem): string {
  return `${EMBED_CACHE_PREFIX}${it.origin}:${it.titleHash}`;
}
/**
 * Total budget for the text fed to the embedder. Sized to fit:
 *   • Title repeated twice         ~120-240 chars
 *   • Description repeated twice   ~100-400 chars (200 each, capped)
 *   • Article body                 ~100-200 chars (truncated to fit)
 *
 * The embedder accepts up to 2048 tokens (~8000 chars) so we're well
 * within the model limit. Bigger inputs don't materially improve
 * same-event discrimination at our threshold; this is the sweet spot
 * for headline-heavy news clustering.
 */
const MAX_INPUT_LEN = 800;
const PER_DESC_SLICE = 200;
const PER_BODY_SLICE = 200;

/**
 * Per-pipeline SET cap. With ~2000 fresh embeddings per refresh, firing
 * one HTTP POST per item saturated Upstash REST and surfaced as a
 * cascade of `[redis] setCachedJson failed: internal error` lines.
 * Batching SETs through `/pipeline` collapses ~2000 calls into ~20 and
 * keeps each request body under a few hundred KB.
 */
const EMBED_PIPELINE_CHUNK = 100;

/**
 * Unique-publisher count above which a cluster is flagged `isAlert: true`.
 * Override via `WM_V6_ALERT_MIN_SOURCES`. iOS renders a red "Alert" badge
 * next to the title when this fires — surfaces fast-spreading breaking
 * news without needing wire-service or rate-of-publication tracking.
 */
const DEFAULT_ALERT_MIN_SOURCES = 8;
function alertMinSources(): number {
  const raw = process.env.WM_V6_ALERT_MIN_SOURCES;
  if (!raw) return DEFAULT_ALERT_MIN_SOURCES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : DEFAULT_ALERT_MIN_SOURCES;
}

/**
 * Map feed-name → user-facing publisher root.
 *
 * Why: we run ~10 BBC sub-feeds, 4 NYT sub-feeds, 5 Guardian sub-feeds
 * etc. Without normalization, a story covered by BBC once shows up in
 * `sources[]` 3 times if 3 BBC sub-feeds carry it — inflating the
 * cluster's source count and showing duplicate "BBC" rows to the user.
 *
 * Names not in the map pass through unchanged (safe default for newly
 * added feeds).
 */
const PUBLISHER_MAP: Record<string, string> = {
  // BBC family
  'BBC World': 'BBC', 'BBC International': 'BBC', 'BBC Africa': 'BBC',
  'BBC Asia': 'BBC', 'BBC Europe': 'BBC', 'BBC Latin America': 'BBC',
  'BBC Middle East': 'BBC', 'BBC US & Canada': 'BBC', 'BBC Australia': 'BBC',
  'BBC Business': 'BBC', 'BBC Technology': 'BBC', 'BBC Science': 'BBC',
  'BBC Health': 'BBC', 'BBC UK': 'BBC', 'BBC UK Politics': 'BBC',
  'BBC England': 'BBC', 'BBC Scotland': 'BBC', 'BBC Wales': 'BBC',
  'BBC Northern Ireland': 'BBC',
  // Deutsche Welle
  'DW (all English)': 'Deutsche Welle', 'DW Top Stories': 'Deutsche Welle',
  'DW World': 'Deutsche Welle',
  // Sky News
  'Sky News World': 'Sky News', 'Sky News UK': 'Sky News',
  'Sky News Politics': 'Sky News', 'Sky News Business': 'Sky News',
  // ABC News (US) — `abcnews.go.com`
  'ABC News (US)': 'ABC News', 'ABC News International': 'ABC News',
  'ABC Politics (US)': 'ABC News', 'ABC US Headlines': 'ABC News',
  // ABC News (AU) — `abc.net.au`, distinct broadcaster
  'ABC News (AU) Just In': 'ABC News (AU)',
  // CBS
  'CBS US': 'CBS News', 'CBS World': 'CBS News', 'CBS Politics': 'CBS News',
  // NBC
  'NBC World': 'NBC News',
  // PBS
  'PBS NewsHour': 'PBS', 'PBS Politics': 'PBS',
  // Guardian
  'The Guardian World': 'The Guardian', 'The Guardian International': 'The Guardian',
  'The Guardian UK': 'The Guardian', 'The Guardian Politics': 'The Guardian',
  'The Guardian Business': 'The Guardian', 'The Guardian Tech': 'The Guardian',
  'The Guardian Science': 'The Guardian', 'The Guardian Australia': 'The Guardian',
  // Independent
  'The Independent UK': 'The Independent', 'The Independent World': 'The Independent',
  'The Independent Politics': 'The Independent',
  // HuffPost
  'HuffPost US': 'HuffPost', 'HuffPost World': 'HuffPost',
  // LA Times
  'LA Times Local': 'LA Times', 'LA Times World': 'LA Times',
  // Global News
  'Global News World': 'Global News', 'Global News Canada': 'Global News',
  'Global News Politics': 'Global News',
  // NYT
  'NYT Homepage': 'New York Times', 'NYT US': 'New York Times',
  'NYT World': 'New York Times', 'NYT Politics': 'New York Times',
  'NYT Business': 'New York Times', 'NYT Technology': 'New York Times',
  'NYT Science': 'New York Times', 'NYT Health': 'New York Times',
  // WSJ
  'WSJ World': 'Wall Street Journal', 'WSJ US Business': 'Wall Street Journal',
  'WSJ Markets': 'Wall Street Journal', 'WSJ Tech': 'Wall Street Journal',
  // Atlantic
  'The Atlantic National': 'The Atlantic',
  // FT
  'FT World': 'Financial Times',
  // Daily Sabah (10 sub-feeds → one publisher)
  'Daily Sabah Home': 'Daily Sabah', 'Daily Sabah Türkiye': 'Daily Sabah',
  'Daily Sabah Politics': 'Daily Sabah', 'Daily Sabah World': 'Daily Sabah',
  'Daily Sabah Mid-East': 'Daily Sabah', 'Daily Sabah Europe': 'Daily Sabah',
  'Daily Sabah Americas': 'Daily Sabah', 'Daily Sabah Asia Pacific': 'Daily Sabah',
  'Daily Sabah Africa': 'Daily Sabah', 'Daily Sabah Business': 'Daily Sabah',
  // Straits Times
  'The Straits Times World': 'The Straits Times',
  'The Straits Times Asia': 'The Straits Times',
  'The Straits Times Singapore': 'The Straits Times',
  // RTHK
  'RTHK World': 'RTHK', 'RTHK Local': 'RTHK',
  // Korea Herald
  'Korea Herald All': 'Korea Herald', 'Korea Herald National': 'Korea Herald',
  'Korea Herald World': 'Korea Herald', 'Korea Herald Business': 'Korea Herald',
  // Bangkok Post
  'Bangkok Post Top Stories': 'Bangkok Post',
  'Bangkok Post Thailand': 'Bangkok Post',
  'Bangkok Post World': 'Bangkok Post',
  // Rappler
  'Rappler World': 'Rappler',
};

function publisherOf(sourceName: string): string {
  return PUBLISHER_MAP[sourceName] ?? sourceName;
}

/**
 * Query-string parameters that publishers stick onto RSS-served URLs
 * for analytics. They have no user value and leak our pipeline
 * fingerprint. Stripped from every link before items go on the wire.
 *
 * Also handles any param starting with `utm_` (Google Analytics
 * convention) — that catches the long tail without us having to
 * enumerate `utm_source`, `utm_medium`, etc. individually.
 */
const TRACKING_PARAMS = new Set([
  'at_medium', 'at_campaign', 'at_source', 'at_link_type', 'at_format', 'at_ptr_type',
  'ns_mchannel', 'ns_campaign', 'ns_source', 'ito',
  'feature', 'feed', 'rss', 'src',
  'CMP', 'cmp', 'spm', 'ref', 'ref_src', 'ref_url',
]);

function stripTracking(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** Host aliases for cross-origin source dedup — same publisher, different
 *  domains. An RSS item and a GDELT item can be the literal same article
 *  served from sibling hosts (BBC's `.co.uk` vs `.com`). */
const HOST_ALIASES: Record<string, string> = {
  'bbc.co.uk': 'bbc.com',
  'news.bbc.co.uk': 'bbc.com',
  'edition.cnn.com': 'cnn.com',
};

/**
 * Normalize a URL to a stable identity key for cross-origin dedup.
 * Strips tracking params, lowercases host, drops `www.`, folds known
 * host aliases, strips `/amp` suffixes and trailing slashes. Two URLs
 * pointing at the same article collapse to the same key.
 */
function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(stripTracking(url));
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    host = HOST_ALIASES[host] ?? host;
    const path = u.pathname.toLowerCase().replace(/\/amp\/?$/, '').replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Lowercased host of a URL, with `www.` stripped and `HOST_ALIASES` folded
 * (so a single blacklist entry like `bbc.com` also covers `bbc.co.uk` via
 * the alias map, and `news.bbc.com` via suffix matching below). Returns ''
 * on an unparseable URL — those bypass the blacklist (no host = no match).
 */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    host = HOST_ALIASES[host] ?? host;
    return host;
  } catch {
    return '';
  }
}

/**
 * Publisher blacklist — comma-separated domains in `WM_V6_SOURCE_BLACKLIST`.
 * Empty / unset → no filtering.
 *
 * Matched against the article-URL host (post-`HOST_ALIASES` fold), with
 * suffix matching so `bbc.com` blocks `news.bbc.com` etc. Articles ABOUT a
 * blacklisted outlet published elsewhere are NOT blocked — we filter by
 * who PUBLISHED the article (the URL host), not by where the name appears.
 *
 * Applied at cluster post-processing time: generation and clustering see
 * every member, so cluster identity is unchanged, but the canonical,
 * summary, `sources[]`, and GDELT corroboration are picked from the
 * allowed set only. A cluster whose only RSS anchor is blacklisted gets
 * dropped (no allowed publisher → no story; option a per the discussion).
 */
function loadSourceBlacklist(): Set<string> {
  const raw = process.env.WM_V6_SOURCE_BLACKLIST;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^www\./, ''))
      .filter((s) => s.length > 0),
  );
}

/** True if `host` exactly matches a blacklist entry or is a subdomain of
 *  one — i.e. `news.bbc.com` matches a `bbc.com` entry, but `bbcfake.com`
 *  does not. Empty host / empty blacklist → false. */
function isHostBlacklisted(host: string, blacklist: Set<string>): boolean {
  if (!host || blacklist.size === 0) return false;
  if (blacklist.has(host)) return true;
  for (const bad of blacklist) {
    if (host.endsWith('.' + bad)) return true;
  }
  return false;
}

/**
 * Extract the meaningful words from an article URL path — the slug.
 * GDELT clustering items have no description/body, so the slug is the
 * only signal beyond the headline. Drops the domain, splits path
 * segments on `-`/`_`, and discards pure-numeric and hash-like ID
 * tokens (`c62e0p7rd2ro`).
 *   bbc.com/news/articles/russia-strike-kyiv-c62e0p7 → "russia strike kyiv"
 */
function urlSlug(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path
      .split('/')
      .filter(Boolean)
      .flatMap((seg) => seg.split(/[-_]/))
      .filter((w) => {
        if (w.length < 3) return false;
        if (/^\d+$/.test(w)) return false;            // pure number
        if (/\d/.test(w) && w.length >= 6) return false; // hash-like ID
        return /[a-z]/i.test(w);
      })
      .join(' ')
      .slice(0, 200);
  } catch {
    return '';
  }
}

/** Max GDELT sources displayed per cluster, below the RSS sources.
 *  A big story can be syndicated to 50+ GDELT outlets; we keep the
 *  freshest 15 so the wire payload stays bounded. */
const GDELT_SOURCES_DISPLAY_CAP = 15;

export interface ClusterSource {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  /** 'rss' = trusted RSS feed (counts toward the min-sources gate,
   *  sorts above GDELT). 'gdelt' = GDELT corroboration (never counts
   *  toward the gate, always listed below RSS). */
  origin: 'rss' | 'gdelt';
}

/**
 * A clustered story ready to be written to the v6 digest. The wire
 * shape matches the iOS `NewsItem` decoder (with some fields populated
 * later by the enrichment cron).
 */
export interface ClusteredItem {
  /** Identity = canonical's titleHash. Used as Redis dedup key. */
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  /** Longest plaintext RSS description across every cluster member.
   *  This is the v6 wire `summary` — no LLM rewriting, no licensing
   *  concern, just outlet-supplied content. */
  summary: string | null;
  /** First image URL found across cluster members (RSS-supplied). */
  imageUrl: string | null;
  /** Photo credit for `imageUrl`, when the feed that supplied the image
   *  also carried a separate `<media:credit>` / `<media:copyright>`.
   *  null when the feed gave no distinct image attribution. */
  imageCredit: string | null;
  /** Every outlet covering this story, canonical first. Deduped by
   *  publisher root (so multi-feed BBC/Sky/NYT show once each). iOS
   *  renders this as the "Also covered by N outlets" affordance. */
  sources: ClusterSource[];
  /** True when unique-publisher count crosses WM_V6_ALERT_MIN_SOURCES
   *  threshold (default 8). iOS shows a red "Alert" badge next to
   *  the title. */
  isAlert: boolean;
  titleHash: string;
  // Enrichment-only fields — filled by the location-only LLM cron
  // (intel-news enrich.ts) on its next pass. Start null.
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  country: string | null;
  region?: string;
  isConflict: boolean | null;
  /** GDELT-keyword recall hint — the union of every GDELT category member's
   *  `gdeltCategories`. NOT the feed-membership signal (see `topics`); kept
   *  as an internal signal and a debugging comparison against the LLM tags. */
  categories: string[];
  /** Multi-label intel-topic classification set by the enrich LLM — the
   *  signal that drives the v6 GDELT-category feeds (cyber / military / …).
   *  Starts undefined; the enrich cron fills it on its next pass. */
  topics?: string[];
  /** Prompt version the enrich LLM used for `topics` / `region` — lets a
   *  prompt-version bump re-classify already-tagged clusters. enrich-set. */
  enrichVersion?: number;
}

/**
 * Corroboration gate for the GDELT-category feeds (cyber / military /
 * nuclear / …). Default rule: a category cluster surfaces when ≥2 distinct
 * outlets carry the story and at least one is a trusted RSS feed.
 *
 * Exception for sparse categories: `cyber`, `maritime`, `nuclear`,
 * `sanctions`, `intelligence` may pass with a single RSS source so
 * region-split category briefs do not go empty while inflow is still
 * growing. (`intelligence` is the most starved of all — included here too.)
 *
 * The RSS-presence half is structurally always true (GDELT-only clusters
 * are dropped at cluster time, so every cluster has ≥1 RSS member); it's
 * checked explicitly anyway so the rule is self-evident and survives any
 * future change to that invariant.
 *
 * The conflict + live-news feeds run their own (stricter, RSS-only) gates
 * via separate endpoints and are unaffected by this one.
 */
const SINGLE_RSS_CATEGORY_TOPICS = new Set(['cyber', 'maritime', 'nuclear', 'sanctions', 'intelligence']);

export function isCategoryCorroborated(c: ClusteredItem): boolean {
  const sources = Array.isArray(c.sources) ? c.sources : [];
  const hasRss = sources.some((s) => s.origin === 'rss');
  if (!hasRss) return false;
  if (sources.length >= 2) return true;

  const topics = Array.isArray(c.topics) ? c.topics : [];
  return topics.some((topic) => SINGLE_RSS_CATEGORY_TOPICS.has(topic));
}

/**
 * Build the text the embedder ingests.
 *
 * # Layout
 *
 *   "<title>. <title>. <description>. <description>. <body>"
 *
 * Title and description are repeated because both are short and carry
 * disproportionate event-identity signal. With a 60-120 char title and
 * a 100-300 char description, single inclusion would let the body
 * (up to 200 chars) numerically dominate the embedder's view of the
 * item even though headline+lede are what define same-event identity
 * in news. Repetition biases the model toward those signals.
 *
 * # Body sourcing
 *
 *   1. `articleBody` — fetched from the publisher's article URL by
 *      `_article-fetcher.ts` for fresh embeds. Equalises signal across
 *      feeds with brief vs full RSS payloads.
 *   2. `item.body` — RSS `<content:encoded>` / `<content>` if shipped.
 *   3. nothing — title + description alone if both above are empty
 *      (or are identical to the description, in which case repeating
 *      would just inflate the duplicate).
 *
 * The user-facing wire `summary` does NOT come from this path — see
 * `pickSummary` for that. The fetched article body never reaches iOS.
 */
function inputTextFor(item: RawRssItem, articleBody?: string): string {
  const title = item.title.trim();

  if (item.origin === 'gdelt') {
    // GDELT items carry no description or body — never article-fetched.
    // Beyond the headline, the signals are the URL slug and the cleaned
    // GKG entity/theme tokens (`gdeltEntities`, built in the intel-news
    // cron from ALLNAMES + persons + orgs + top themes). title×2 keeps the
    // headline weighting consistent with how RSS items are built so a
    // GDELT headline and an RSS headline for the same event embed close;
    // the entities give the vector the named-actor/place signal an RSS
    // item gets from its description+body.
    const slug = urlSlug(item.link);
    const entities = (item.gdeltEntities || '').trim();
    const parts: string[] = [];
    if (title) parts.push(title, title);
    if (slug) parts.push(slug);
    if (entities) parts.push(entities);
    return parts.join('. ').slice(0, MAX_INPUT_LEN);
  }

  const desc = (item.description || '').trim().slice(0, PER_DESC_SLICE);

  // Skip body when it duplicates content we already have. `_normalize.ts`
  // falls back `body → description` when no rich tag exists, so body
  // can equal description on minimal feeds.
  const rawBody = (articleBody || item.body || '').trim();
  const bodyIsDuplicate = rawBody === desc || rawBody === title || rawBody === '';
  const body = bodyIsDuplicate ? '' : rawBody.slice(0, PER_BODY_SLICE);

  const parts: string[] = [];
  if (title) parts.push(title, title);
  if (desc) parts.push(desc, desc);
  if (body) parts.push(body);
  return parts.join('. ').slice(0, MAX_INPUT_LEN);
}

/**
 * Pick the cluster's canonical from its members. Rule:
 *   1. GDELT items are excluded — the cluster headline / link / source /
 *      image must come from a trusted RSS outlet, never GDELT.
 *   2. Lowest sourcePriority wins (1 = wires, beats 4 = analysis).
 *   3. Among same-priority, newest publishedAt wins.
 *
 * Only ever called on clusters with ≥1 RSS member (GDELT-only clusters
 * are skipped before this point), so the RSS filter is always non-empty.
 */
function pickCanonical(members: RawRssItem[]): RawRssItem {
  const rss = members.filter((m) => m.origin === 'rss');
  const pool = rss.length > 0 ? rss : members;
  return [...pool].sort((a, b) => {
    if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
    return b.publishedAt - a.publishedAt;
  })[0]!;
}

/**
 * Pick the cluster's incident location from its GDELT members' GKG-parsed
 * coordinates. Returns the **mode** — the lat/lng (rounded to ~1 km) that
 * the most GDELT members agree on. GKG lists every place an article
 * mentions; the mode across members converges on the actual incident
 * location rather than a tangentially-named city.
 *
 * Returns null when the cluster has no GDELT member with a location —
 * the enrich cron then LLM-geocodes from the RSS members instead.
 */
function pickGdeltLocation(members: RawRssItem[]): GdeltItemLocation | null {
  const counts = new Map<string, { loc: GdeltItemLocation; n: number }>();
  for (const m of members) {
    if (m.origin !== 'gdelt' || !m.gdeltLocation) continue;
    const loc = m.gdeltLocation;
    const key = `${loc.latitude.toFixed(2)},${loc.longitude.toFixed(2)}`;
    const e = counts.get(key);
    if (e) e.n++;
    else counts.set(key, { loc, n: 1 });
  }
  let best: { loc: GdeltItemLocation; n: number } | null = null;
  for (const e of counts.values()) {
    if (!best || e.n > best.n) best = e;
  }
  return best?.loc ?? null;
}

/**
 * Trailing truncation markers RSS publishers append to a cut-off lede —
 * a "Continue reading" CTA, a bare/bracketed ellipsis, or stray
 * arrow/separator glyphs. Port of the iOS `FeedItem.cleanedSummary`
 * patterns so the server and client agree on what "truncated" means.
 */
const SUMMARY_CTA_PATTERN =
  /[\s.…»›→▶|–—-]*[[(]?\s*(continue reading|keep reading|read more|read on|read the full (story|article)|read full (story|article)|view (full )?coverage|full story)\s*[\])]?\s*$/i;
const SUMMARY_TAIL_PATTERNS: RegExp[] = [
  /\s*[[(]\s*(…|\.{2,})\s*[\])]\s*$/i, // bracketed: [...]  […]
  /\s*(…|\.{3,})\s*$/i,                // bare ellipsis
  /[\s»›→▶|–—-]+$/i,                    // leftover separators
];

/**
 * Strip trailing truncation markers off a description — port of the iOS
 * `FeedItem.cleanedSummary`. Only the END of the string is touched; the
 * 6-pass loop catches stacked markers ("… [Continue reading]"). Returns
 * the original trimmed text when stripping would empty it.
 */
function cleanSummaryText(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 6; i++) {
    const before = s;
    for (const pattern of [SUMMARY_CTA_PATTERN, ...SUMMARY_TAIL_PATTERNS]) {
      s = s.replace(pattern, '');
    }
    s = s.trim();
    if (s === before) break;
  }
  return s.length === 0 ? raw.trim() : s;
}

/**
 * Pick the cluster's wire `summary` from its members' RSS descriptions.
 *
 * A clustered story carries one description per outlet that covered it,
 * and many RSS feeds ship a TRUNCATED lede — cut off with "…", "[…]" or
 * a "Continue reading" CTA. Because the cluster gives us several
 * descriptions of the SAME story, we just pick a better one:
 *
 *   1. Split candidates into "clean" (full lede) and "truncated" (ends
 *      with a cut-off marker — see `cleanSummaryText`).
 *   2. Prefer a clean lede; among clean ones the longest wins — BUT if
 *      the canonical outlet's own clean description is within 80% of
 *      that length, keep the canonical's: its angle aligns with the
 *      headline we actually show (stops e.g. headline "Five Italians die
 *      in cave dive" paired with a follow-up's sole-survivor summary).
 *   3. If every outlet truncated its lede, fall back to the one with the
 *      most content, strip the "Continue reading" CTA / stray separators,
 *      and end it with a single ellipsis — an honest "cut off here"
 *      signal, without the CTA noise.
 */
function pickSummary(members: RawRssItem[], canonical: RawRssItem): string | null {
  const candidates = members
    .map((m) => (m.description || '').trim())
    .filter((d) => d.length > 0)
    .map((raw) => {
      const cleaned = cleanSummaryText(raw);
      return { raw, cleaned, isClean: cleaned === raw };
    });
  if (candidates.length === 0) return null;

  const clean = candidates.filter((c) => c.isClean);
  if (clean.length > 0) {
    const longestClean = clean.reduce((a, b) => (b.raw.length > a.raw.length ? b : a));
    const canonDesc = (canonical.description || '').trim();
    if (
      canonDesc.length > 0 &&
      cleanSummaryText(canonDesc) === canonDesc &&
      canonDesc.length >= longestClean.raw.length * 0.8
    ) {
      return canonDesc;
    }
    return longestClean.raw;
  }

  // Every outlet's lede was truncated — there's no clean alternative.
  // Take whichever has the most content, drop the "Continue reading" CTA
  // / stray separators, and end it with a single ellipsis: an honest
  // truncation signal instead of the publisher's CTA noise.
  const best = candidates.reduce((a, b) => (b.cleaned.length > a.cleaned.length ? b : a));
  return `${best.cleaned}…`;
}

/** First non-null image across the cluster, with its photo credit (if
 *  any) from the SAME member — so the credit always describes the image
 *  we actually picked. Members are tried in the same canonical-first
 *  ordering so the canonical's image takes priority. */
function pickFirstImage(
  members: RawRssItem[],
  canonical: RawRssItem,
): { url: string | null; credit: string | null } {
  if (canonical.imageUrl) {
    return { url: canonical.imageUrl, credit: canonical.imageCredit };
  }
  for (const m of members) {
    if (m.imageUrl) return { url: m.imageUrl, credit: m.imageCredit };
  }
  return { url: null, credit: null };
}

/**
 * Main entry — embed all items, online-greedy-cluster them at THRESHOLD,
 * then post-process each cluster into the wire shape.
 *
 * Order of incoming items is preserved as the secondary "seen-first"
 * priority: when two items would cluster equally well with multiple
 * candidates, the first-seen wins. This is stable across cron runs.
 */
export async function clusterRssItems(items: RawRssItem[]): Promise<ClusteredItem[]> {
  if (items.length === 0) return [];

  const threshold = clusterThreshold();
  const thresholdSource = process.env.WM_V6_CLUSTER_THRESHOLD ? 'env' : 'default';
  console.log(`[live-news:v6:cluster] threshold=${threshold} (${thresholdSource}) items=${items.length}`);

  // ── 1. Load cached embeddings ──
  // Keyed by `embedCacheKey` (origin + titleHash), not titleHash alone, so an
  // RSS item and a GDELT item with the same headline keep separate vectors.
  const cacheKeys = items.map((it) => embedCacheKey(it));
  const cached = await getCachedJsonBatch(cacheKeys);

  const embedByKey = new Map<string, Float32Array>();
  for (const it of items) {
    const raw = cached.get(embedCacheKey(it));
    if (typeof raw === 'string') {
      const v = base64ToFloat32(raw);
      if (v) embedByKey.set(embedCacheKey(it), v);
    }
  }

  // ── 2. Embed misses ──
  const toEmbed = items.filter((it) => !embedByKey.has(embedCacheKey(it)));
  if (toEmbed.length > 0) {
    // Fetch the publisher's article HTML for the items we're about to
    // embed. Equalises cluster input across feeds with vastly different
    // RSS verbosity (BBC's 100-char ledes vs Intercept's 40 KB full
    // article bodies). Strictly clustering-only — the fetched text
    // never reaches the wire (see `pickSummary`). Embedding cache hits
    // are excluded above so we don't re-fetch articles whose embedding
    // we already have. GDELT items are never fetched — they cluster on
    // headline + URL slug only.
    const articleBodies = await fetchArticleBodyBatch(
      toEmbed.filter((it) => it.origin === 'rss'),
    );

    const fresh = await embedBatch(
      toEmbed.map((it) => inputTextFor(it, articleBodies.get(it.link))),
    );
    // Build pipelined SETs. Skip compression for embeddings —
    // base64-encoded Float32 is near-random data, gzip just adds overhead.
    // Values go straight as `JSON.stringify(base64)` so the GET path
    // (decodeFromStorage → JSON.parse) round-trips unchanged.
    const commands: Array<Array<string | number>> = [];
    for (let i = 0; i < toEmbed.length; i++) {
      const v = fresh[i];
      if (!v) continue;
      embedByKey.set(embedCacheKey(toEmbed[i]!), v);
      commands.push([
        'SET',
        embedCacheKey(toEmbed[i]!),
        JSON.stringify(float32ToBase64(v)),
        'EX',
        EMBED_TTL_S,
      ]);
    }
    const batches: Promise<unknown>[] = [];
    for (let i = 0; i < commands.length; i += EMBED_PIPELINE_CHUNK) {
      batches.push(runRedisPipeline(commands.slice(i, i + EMBED_PIPELINE_CHUNK)));
    }
    // Fire-and-forget — cache miss next run is a sub-cent re-embed.
    Promise.allSettled(batches).then(() => undefined);
  }

  // ── 3. Two-stage clustering — cluster RSS, then attach GDELT ──
  // Each cluster is identified by its starter item's `embedCacheKey`
  // (origin + titleHash). Members map tracks every item in each cluster.
  // (The output `ClusteredItem.id` is still the PICKED canonical's
  // titleHash — set in post-processing, independent of these keys.)
  const clusterOf = new Map<string, string>();       // item.titleHash → cluster key
  const members = new Map<string, RawRssItem[]>();   // canonical → members
  // For comparison we store the running SUM of member embeddings per
  // cluster, not the first-seen item's vector. Cosine is scale-invariant
  // (cos(a, k·c) = cos(a, c)) so the sum compares the same as the
  // centroid without paying for a divide each membership add. As more
  // items join, the cluster vector drifts toward what those members
  // share — preventing a marginal early member from pulling in
  // tangentially-related items via cluster drift.
  const sumEmbedByCanonical = new Map<string, Float32Array>();
  // ‖cluster sum‖, kept in sync with sumEmbedByCanonical. Caching the
  // magnitude turns each candidate comparison into a single dot-product
  // loop instead of three (dot + ‖a‖ + ‖b‖) — the inner loop runs
  // millions of times per refresh, so this ~3× speedup on the hot path
  // is what keeps the cluster phase inside its time budget.
  const sumNormByCanonical = new Map<string, number>();

  // ── ‖e‖ + nearest-centroid helpers (shared by both stages) ──
  const norm = (e: Float32Array): number => {
    let s = 0;
    for (let k = 0; k < e.length; k++) s += e[k]! * e[k]!;
    return Math.sqrt(s);
  };
  // Highest-cosine cluster for embedding `e` (‖e‖ = eNorm) among the current
  // centroids → [bestSim, bestKey]. Only the dot needs the inner loop; the
  // cached magnitudes keep each comparison to a single pass.
  const bestCluster = (e: Float32Array, eNorm: number): [number, string | null] => {
    let bestSim = -1;
    let bestKey: string | null = null;
    if (eNorm > 0) {
      for (const [k, sumEmbed] of sumEmbedByCanonical) {
        const sumNorm = sumNormByCanonical.get(k)!;
        if (sumNorm <= 0) continue;
        let dot = 0;
        const n = Math.min(e.length, sumEmbed.length);
        for (let i = 0; i < n; i++) dot += e[i]! * sumEmbed[i]!;
        const s = dot / (eNorm * sumNorm);
        if (s > bestSim) { bestSim = s; bestKey = k; }
      }
    }
    return [bestSim, bestKey];
  };

  // Split by origin, each oldest-first. Yield to the event loop every 128
  // items across BOTH stages — the CPU-heavy pass otherwise freezes Node and
  // starves the Redis keep-alive connections (the digest read/write that run
  // right after would then time out).
  const rssSorted = items
    .filter((it) => it.origin === 'rss')
    .sort((a, b) => a.publishedAt - b.publishedAt);
  const gdeltSorted = items
    .filter((it) => it.origin === 'gdelt')
    .sort((a, b) => a.publishedAt - b.publishedAt);
  let processed = 0;

  // ── Stage 1: greedy-cluster the trusted RSS items among themselves ──
  for (const it of rssSorted) {
    if (++processed % 128 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const key = embedCacheKey(it);
    const e = embedByKey.get(key);
    if (!e) {
      // Embedding failed — fall back to singleton.
      clusterOf.set(it.titleHash, key);
      members.set(key, [it]);
      continue;
    }
    const eNorm = norm(e);
    const [bestSim, bestKey] = bestCluster(e, eNorm);
    if (bestSim >= threshold && bestKey) {
      clusterOf.set(it.titleHash, bestKey);
      members.get(bestKey)!.push(it);
      // Fold into the running cluster sum + refresh its cached magnitude.
      const sum = sumEmbedByCanonical.get(bestKey)!;
      let sn = 0;
      for (let k = 0; k < sum.length; k++) { sum[k] = sum[k]! + e[k]!; sn += sum[k]! * sum[k]!; }
      sumNormByCanonical.set(bestKey, Math.sqrt(sn));
    } else {
      // New cluster — copy e so the cached embedding is never mutated.
      clusterOf.set(it.titleHash, key);
      members.set(key, [it]);
      sumEmbedByCanonical.set(key, new Float32Array(e));
      sumNormByCanonical.set(key, eNorm);
    }
  }
  const rssClusterCount = members.size;

  // ── Stage 2: attach each GDELT item to its nearest RSS centroid ──
  // GDELT is corroboration only: it never reshapes a cluster (the centroid is
  // NOT updated) and never starts one (a GDELT item that matches no RSS
  // cluster is simply dropped, not turned into a GDELT-only cluster). So GDELT
  // can't bridge two RSS stories, can't drift an RSS centroid with its weaker
  // title+slug vector, and we never build-then-discard GDELT-only clusters.
  const gdeltThreshold = gdeltAttachThreshold(threshold);
  let gdeltAttached = 0;
  for (const it of gdeltSorted) {
    if (++processed % 128 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const e = embedByKey.get(embedCacheKey(it));
    if (!e) continue;                         // no vector → can't place → drop
    const eNorm = norm(e);
    if (eNorm <= 0) continue;
    const [bestSim, bestKey] = bestCluster(e, eNorm);
    if (bestSim >= gdeltThreshold && bestKey) {
      clusterOf.set(it.titleHash, bestKey);
      members.get(bestKey)!.push(it);         // attach as corroboration only
      gdeltAttached++;
    }
  }
  console.log(
    `[live-news:v6:cluster] stage1_rss=${rssSorted.length}→${rssClusterCount}clusters ` +
    `stage2_gdelt=${gdeltAttached}/${gdeltSorted.length} attached`,
  );

  // ── 4. Post-process into wire shape ──
  const alertMin = alertMinSources();
  // Publisher blacklist (env-configured) — applied per-cluster below. See
  // `loadSourceBlacklist` for matching rules.
  const blacklist = loadSourceBlacklist();
  const clustered: ClusteredItem[] = [];
  for (const memberList of members.values()) {
    // Drop blacklisted outlets from the user-facing view of the cluster.
    // Generation + clustering ran against every member, so cluster
    // identity is unchanged — but the canonical, summary, image, and the
    // RSS sources list are picked from the allowed members only.
    const rssMembers = memberList.filter(
      (m) => m.origin === 'rss' && !isHostBlacklisted(hostOf(m.link), blacklist),
    );
    // GDELT-only clusters have no trusted anchor and can never reach the
    // RSS-source gate — drop them so they don't consume digest slots. The
    // same drop covers clusters whose only RSS anchor is blacklisted (no
    // allowed publisher → no story).
    if (rssMembers.length === 0) continue;

    const canonical = pickCanonical(rssMembers);
    // Summary + image come strictly from RSS members — never GDELT.
    const summary = pickSummary(rssMembers, canonical);
    const firstImg = pickFirstImage(rssMembers, canonical);

    // ── RSS sources: publisher-deduped, canonical's publisher first ──
    // Multi-feed outlets (BBC/Sky/NYT) collapse to one entry.
    const orderedRss = [canonical, ...rssMembers
      .filter((m) => m.link !== canonical.link)
      .sort((a, b) => b.publishedAt - a.publishedAt)];

    const byPublisher = new Map<string, ClusterSource>();
    for (const m of orderedRss) {
      const publisher = publisherOf(m.source);
      const existing = byPublisher.get(publisher);
      if (!existing || m.publishedAt > existing.publishedAt) {
        byPublisher.set(publisher, {
          source: publisher,
          title: m.title,
          link: stripTracking(m.link),
          publishedAt: m.publishedAt,
          origin: 'rss',
        });
      }
    }
    const canonicalPublisher = publisherOf(canonical.source);
    const canonicalSource = byPublisher.get(canonicalPublisher)!;
    byPublisher.delete(canonicalPublisher);
    const rssSources: ClusterSource[] = [
      canonicalSource,
      ...[...byPublisher.values()].sort((a, b) => b.publishedAt - a.publishedAt),
    ];

    // ── GDELT sources: flatten every GDELT member's gdeltSources, dedup
    //    by normalized URL against the RSS sources (RSS wins — the
    //    BBC-overlap fix) and against each other, cap at the display
    //    limit, list below the RSS sources. ──
    const rssUrlKeys = new Set(rssSources.map((s) => normalizeUrlForDedup(s.link)));
    const gdeltByUrl = new Map<string, ClusterSource>();
    for (const m of memberList) {
      if (m.origin !== 'gdelt' || !m.gdeltSources) continue;
      for (const g of m.gdeltSources) {
        // Same publisher blacklist as RSS — applied by article-URL host so
        // a GDELT corroboration entry pointing at a blocked outlet is
        // dropped, regardless of how GDELT spelled the source name.
        if (isHostBlacklisted(hostOf(g.link), blacklist)) continue;
        const key = normalizeUrlForDedup(g.link);
        if (rssUrlKeys.has(key) || gdeltByUrl.has(key)) continue;
        gdeltByUrl.set(key, {
          source: g.source,
          title: g.title,
          link: stripTracking(g.link),
          publishedAt: g.publishedAt,
          origin: 'gdelt',
        });
      }
    }
    const gdeltSources = [...gdeltByUrl.values()]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, GDELT_SOURCES_DISPLAY_CAP);

    const sources: ClusterSource[] = [...rssSources, ...gdeltSources];

    // Location: prefer GDELT's GKG-parsed coordinates (mode across GDELT
    // members). When the cluster has no GDELT member this stays null and
    // the enrich cron LLM-geocodes from the RSS members instead.
    const gdeltLoc = pickGdeltLocation(memberList);

    // Category tags — union of every GDELT member's keyword-matched topics.
    const categorySet = new Set<string>();
    for (const m of memberList) {
      if (m.origin === 'gdelt' && Array.isArray(m.gdeltCategories)) {
        for (const cat of m.gdeltCategories) categorySet.add(cat);
      }
    }

    clustered.push({
      // Identity = the PICKED canonical's titleHash, NOT the titleHash of
      // whichever item happened to start the cluster. The starter varies
      // with input order every refresh; the canonical (lowest priority,
      // newest) is stable. Using the starter made `mergeItems` (which
      // dedups by `id`) treat the same story as new each refresh, so the
      // 24h digest accumulated duplicate entries of one story.
      id: canonical.titleHash,
      source: canonicalPublisher,
      title: canonical.title,
      link: stripTracking(canonical.link),
      publishedAt: canonical.publishedAt,
      summary,
      imageUrl: firstImg.url,
      imageCredit: firstImg.credit,
      sources,
      // Alert fires on trusted-RSS publisher count only — GDELT
      // corroboration never inflates breaking-news status.
      isAlert: rssSources.length >= alertMin,
      titleHash: canonical.titleHash,
      location: gdeltLoc
        ? { latitude: gdeltLoc.latitude, longitude: gdeltLoc.longitude }
        : null,
      locationName: gdeltLoc?.locationName ?? null,
      country: gdeltLoc?.country ?? null,
      isConflict: null,
      categories: [...categorySet],
    });
  }

  // Sort newest-first
  clustered.sort((a, b) => b.publishedAt - a.publishedAt);

  return clustered;
}
