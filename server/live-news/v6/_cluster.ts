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

import { embedBatch, cosineSim, float32ToBase64, base64ToFloat32 } from '../../_shared/embeddings';
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

/** Cache prefix — bump whenever the embedder INPUT or model changes, so
 *  vectors built under different regimes never get compared:
 *    v2 — switched task type CLUSTERING → SEMANTIC_SIMILARITY
 *    v3 — embed input changed to title×2 + description×2 + body, and
 *         RSS items now embed fetched article-body text. A v2-cached
 *         vector (old `title — text` input) sits ~0.85 cosine from its
 *         v3 equivalent — enough to split a cluster at threshold 0.87. */
const EMBED_CACHE_PREFIX = 'live-news:v6:embed:v3:';
const EMBED_TTL_S = 24 * 60 * 60;
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
    // The URL slug is the only extra signal. title×2 keeps the headline
    // weighting consistent with how RSS items are built, so a GDELT
    // headline and an RSS headline for the same event embed close.
    const slug = urlSlug(item.link);
    const parts: string[] = [];
    if (title) parts.push(title, title);
    if (slug) parts.push(slug);
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
 * Pick the cluster's wire `summary`. Default: the longest plaintext
 * description across all cluster members.
 *
 * BUT: if the canonical outlet's own description is at least 80% the
 * length of that maximum, we prefer the canonical's description — its
 * angle is more likely aligned with the canonical's title (the one we
 * actually show as the headline). Stops cases like cluster headline =
 * "Five Italians die during cave dive" while summary describes the
 * sole survivor's angle picked from a tabloid follow-up.
 */
function pickSummary(members: RawRssItem[], canonical: RawRssItem): string | null {
  let longest = '';
  for (const m of members) {
    const d = (m.description || '').trim();
    if (d.length > longest.length) longest = d;
  }
  if (longest.length === 0) return null;
  const canonDesc = (canonical.description || '').trim();
  if (canonDesc.length === 0) return longest;
  // Within 80% of longest → prefer canonical's for title-summary alignment.
  if (canonDesc.length >= longest.length * 0.8) return canonDesc;
  return longest;
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
  const cacheKeys = items.map((it) => `${EMBED_CACHE_PREFIX}${it.titleHash}`);
  const cached = await getCachedJsonBatch(cacheKeys);

  const embedByHash = new Map<string, Float32Array>();
  for (const it of items) {
    const raw = cached.get(`${EMBED_CACHE_PREFIX}${it.titleHash}`);
    if (typeof raw === 'string') {
      const v = base64ToFloat32(raw);
      if (v) embedByHash.set(it.titleHash, v);
    }
  }

  // ── 2. Embed misses ──
  const toEmbed = items.filter((it) => !embedByHash.has(it.titleHash));
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
      embedByHash.set(toEmbed[i]!.titleHash, v);
      commands.push([
        'SET',
        `${EMBED_CACHE_PREFIX}${toEmbed[i]!.titleHash}`,
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

  // ── 3. Online greedy clustering ──
  // Each cluster identified by its canonical's titleHash. Members map
  // tracks every item that landed in each cluster.
  const clusterOf = new Map<string, string>();       // item.titleHash → canonical hash
  const members = new Map<string, RawRssItem[]>();   // canonical → members
  // For comparison we store the running SUM of member embeddings per
  // cluster, not the first-seen item's vector. Cosine is scale-invariant
  // (cos(a, k·c) = cos(a, c)) so the sum compares the same as the
  // centroid without paying for a divide each membership add. As more
  // items join, the cluster vector drifts toward what those members
  // share — preventing a marginal early member from pulling in
  // tangentially-related items via cluster drift.
  const sumEmbedByCanonical = new Map<string, Float32Array>();

  // Process oldest-first so older stories accrete younger reports.
  const sorted = [...items].sort((a, b) => a.publishedAt - b.publishedAt);

  for (const it of sorted) {
    const e = embedByHash.get(it.titleHash);
    if (!e) {
      // Embedding failed — fall back to singleton.
      clusterOf.set(it.titleHash, it.titleHash);
      members.set(it.titleHash, [it]);
      continue;
    }

    let bestSim = -1;
    let bestCanonical: string | null = null;
    for (const [canonical, sumEmbed] of sumEmbedByCanonical) {
      const s = cosineSim(e, sumEmbed);
      if (s > bestSim) {
        bestSim = s;
        bestCanonical = canonical;
      }
    }

    if (bestSim >= threshold && bestCanonical) {
      clusterOf.set(it.titleHash, bestCanonical);
      members.get(bestCanonical)!.push(it);
      // Fold this item into the running cluster sum.
      const sum = sumEmbedByCanonical.get(bestCanonical)!;
      for (let k = 0; k < sum.length; k++) sum[k] = sum[k]! + e[k]!;
    } else {
      // New cluster — start the running sum with a copy of e (don't
      // mutate the cached embedding shared with embedByHash).
      clusterOf.set(it.titleHash, it.titleHash);
      members.set(it.titleHash, [it]);
      sumEmbedByCanonical.set(it.titleHash, new Float32Array(e));
    }
  }

  // ── 4. Post-process into wire shape ──
  const alertMin = alertMinSources();
  const clustered: ClusteredItem[] = [];
  for (const memberList of members.values()) {
    const rssMembers = memberList.filter((m) => m.origin === 'rss');
    // GDELT-only clusters have no trusted anchor and can never reach the
    // RSS-source gate — drop them so they don't consume digest slots.
    if (rssMembers.length === 0) continue;

    const canonical = pickCanonical(memberList);
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
