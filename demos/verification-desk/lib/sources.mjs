// Where the desk reads from. LiveSource calls WorldMonitor's MCP tools,
// ArchiveSource replays snapshots taken by scripts/snapshot.mjs (the MCP news
// tools only see the live digest window, so "last week" needs an archive).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { dig } from './mcp-client.mjs';
import { overlapScore } from './text.mjs';

export const FULL_CATEGORIES = [
  'politics', 'us', 'europe', 'middleeast', 'tech', 'ai', 'finance', 'commodities', 'gov',
  'africa', 'latam', 'asia', 'energy', 'thinktanks', 'crisis', 'layoffs', 'intel',
];

const USER_AGENT = 'Mozilla/5.0 (compatible; WorldMonitor-VerificationDesk/1.0; +https://worldmonitor.app)';

/** Normalises a get_news_clusters row into the shape the desk uses. */
export function normalizeCluster(c, extra = {}) {
  return {
    id: c.id,
    title: c.title,
    link: c.link ?? null,
    primarySource: c.primarySource ?? null,
    memberCount: c.memberCount ?? null,
    distinctSourceCount: c.distinctSourceCount ?? null,
    sources: c.sources ?? [],
    publishers: (c.publishers ?? []).map((p) => ({ name: p.name, tier: p.tier ?? null, labels: p.labels ?? [], ...(p.risk ? { risk: p.risk } : {}), ...(p.stateAffiliated ? { stateAffiliated: p.stateAffiliated } : {}) })),
    publishersUnlisted: c.publishersUnlisted ?? 0,
    sourceProvenance: (c.sourceProvenance ?? []).map((p) => ({ source: p.source, tier: p.tier ?? null, risk: p.risk ?? null, type: p.type ?? null, stateAffiliated: p.stateAffiliated ?? null })),
    corroboration: c.corroboration ?? { state: 'unknown', publishers: null },
    topKeywords: c.topKeywords ?? [],
    firstSeen: c.firstSeen ?? null,
    lastUpdated: c.lastUpdated ?? null,
    credibilityScore: c.credibilityScore ?? null,
    memberTitles: c.memberTitles ?? null,
    ...extra,
  };
}

/** A get_news_intelligence top story in the cluster shape the desk grades. */
export function storyAsCluster(st) {
  return normalizeCluster({
    id: `story:${st.primaryTitle}`,
    title: st.primaryTitle,
    link: st.primaryLink ?? null,
    primarySource: st.primarySource ?? null,
    memberCount: st.sourceCount ?? null,
    distinctSourceCount: st.uniqueSourceCount ?? null,
    sources: st.sources ?? [],
    publishers: st.publishers ?? [],
    publishersUnlisted: st.publishersUnlisted ?? 0,
    corroboration: st.corroboration ?? (st.corroborationCount ? { state: 'unknown', publishers: st.corroborationCount } : undefined),
    firstSeen: typeof st.pubDate === 'number' ? new Date(st.pubDate).toISOString() : st.pubDate ?? null,
    lastUpdated: st.lastUpdated ?? null,
    credibilityScore: st.credibilityScore,
    memberTitles: st.memberTitles ?? null,
  }, { seenIn: 'story', credibilityScore: st.credibilityScore ?? null, entityCorroboration: st.entityCorroboration ?? null, corroborationSourceCount: st.corroborationSourceCount ?? null });
}

/** GDELT article rows ({title, url}) from a get_news_intelligence payload. */
export function gdeltArticlesFrom(payload) {
  const topics = dig(payload, 'topics');
  if (!Array.isArray(topics)) return [];
  return topics.flatMap((t) => (t.articles ?? []).map((a) => ({ title: a.title, url: a.url, source: a.source ?? null, date: a.date ?? null })));
}

/** Collects every market-shaped object ({title, yesPrice}) inside a payload. */
export function collectMarkets(payload) {
  const out = [];
  const stack = [payload];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.title === 'string' && typeof node.yesPrice === 'number') {
      out.push({ title: node.title, yesPrice: node.yesPrice, source: node.source ?? null, volume: node.volume ?? null, url: node.url ?? null, endDate: node.endDate ?? null });
      continue;
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
  }
  return out;
}

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', '#39': "'", apos: "'" };

// Plain text for figure checks only; it is never rendered as HTML.
function stripHtml(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // One pass, so "&amp;lt;" stays "&lt;" (no double unescaping).
    .replace(/&(nbsp|amp|quot|#39|apos);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchArticleText(url, { timeoutMs = 5000, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) return null;
    const text = stripHtml(await res.text());
    return text.length > 200 ? text.slice(0, 60_000) : null;
  } catch {
    return null;
  }
}

export class LiveSource {
  constructor(mcp, { ttlMs = 15 * 60_000 } = {}) {
    this.mcp = mcp;
    this.kind = 'live';
    this.ttlMs = ttlMs;
    this.snapshots = new Map();
  }

  async searchClusters(terms) {
    const results = await Promise.allSettled(
      // At most three search calls per headline: the daily MCP allowance is shared with the whole show.
      terms.slice(0, 3).map((query) => this.mcp.callTool('get_news_clusters', { query, limit: 25 })),
    );
    const byId = new Map();
    let generatedAt = null;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      generatedAt ??= r.value.generatedAt ?? null;
      for (const c of r.value.clusters ?? []) byId.set(c.id, normalizeCluster(c, { seenIn: 'live' }));
    }
    const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message);
    return { clusters: [...byId.values()], generatedAt, failures };
  }

  // get_news_intelligence and get_prediction_markets are read as whole
  // snapshots, at most once per TTL, and matched locally: one panel
  // allocation per refresh instead of one per shouted headline, and a grade
  // on stage costs no extra round trip.
  async snapshot(name, load, { force = false } = {}) {
    const hit = this.snapshots.get(name);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await load();
    this.snapshots.set(name, { at: Date.now(), value });
    return value;
  }

  /** Member headlines and seeder corroboration for one story, from get_news_intelligence. */
  async storyDetail(cluster) {
    try {
      const stories = await this.intelligenceStories();
      let best = null;
      for (const s of stories) {
        const score = overlapScore(cluster.title, `${s.primaryTitle} ${(s.memberTitles ?? []).join(' ')}`);
        if (!best || score > best.score) best = { score, story: s };
      }
      if (!best || best.score < 0.5) return null;
      const s = best.story;
      return {
        memberTitles: s.memberTitles ?? [],
        uniqueSourceCount: s.uniqueSourceCount ?? null,
        corroborationSourceCount: s.corroborationSourceCount ?? null,
        entityCorroboration: s.entityCorroboration ?? null,
        pubDate: s.pubDate ?? null,
      };
    } catch {
      return null;
    }
  }

  async markets(terms) {
    const all = await this.snapshot('markets', async () => collectMarkets(await this.mcp.callTool('get_prediction_markets', { limit: 0 })));
    const lower = terms.map((t) => t.toLowerCase());
    return all.filter((m) => lower.some((t) => m.title.toLowerCase().includes(t)));
  }

  articleText(url) {
    return fetchArticleText(url);
  }

  async brief() {
    const b = await this.mcp.callTool('get_world_brief', {});
    return { headlines: b.headlines ?? [], topStories: b.topStories ?? [], brief: b.brief ?? b.summary ?? '', generatedAt: b.generatedAt ?? null, stale: b.stale ?? false };
  }

  async allClusters() {
    const results = await Promise.allSettled([
      this.mcp.callTool('get_news_clusters', { limit: 25 }),

    ]);
    const byId = new Map();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const c of r.value.clusters ?? []) byId.set(c.id, normalizeCluster(c, { seenIn: 'live' }));
    }
    return [...byId.values()];
  }

  async intelligenceStories() {
    try {
      return (await this.intelligencePayload()).stories;
    } catch {
      return [];
    }
  }

  intelligencePayload({ force = false } = {}) {
    return this.snapshot('intelligence', async () => {
      const payload = await this.mcp.callTool('get_news_intelligence', { limit: 0 });
      return { stories: dig(payload, 'topStories') ?? [], articles: gdeltArticlesFrom(payload) };
    }, { force });
  }

  async gdeltArticles() {
    try {
      return (await this.intelligencePayload()).articles;
    } catch {
      return [];
    }
  }

  /**
   * Today's board: WorldMonitor's top stories plus the newest clusters. Two
   * calls, cached for the TTL; `force` (the presenter's refresh) fetches both again.
   */
  async boardClusters({ force = false } = {}) {
    const [payload, newest] = await Promise.all([
      this.intelligencePayload({ force }).catch(() => ({ stories: [] })),
      this.snapshot('board-clusters', async () => (await this.mcp.callTool('get_news_clusters', { limit: 25 })).clusters ?? [], { force }),
    ]);
    const clusters = [...payload.stories.map(storyAsCluster), ...newest.map((c) => normalizeCluster(c, { seenIn: 'live' }))];
    return { clusters, asOf: new Date(this.snapshots.get('board-clusters')?.at ?? Date.now()).toISOString() };
  }

  /** Fetch both snapshots before the show so the first grade is instant. */
  warm() {
    return Promise.allSettled([this.intelligenceStories(), this.markets([])]);
  }
}

/** Snapshots written by scripts/snapshot.mjs, newest wins per cluster id. */
export class ArchiveSource {
  constructor(dirs, { days = 7 } = {}) {
    this.dirs = Array.isArray(dirs) ? dirs : [dirs];
    this.days = days;
    this.kind = 'archive';
    this.cache = null;
  }

  // Re-read when snapshot:loop adds a file, and every 10 minutes so the
  // seven-day window moves on while the desk runs.
  async load() {
    let files = [];
    for (const dir of this.dirs) {
      try {
        files.push(...(await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(f)).map((f) => path.join(dir, f)));
      } catch {
        // directory not created yet
      }
    }
    files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const signature = files.join('|');
    if (this.cache && this.cache.signature === signature && Date.now() - this.cache.loadedAt < 10 * 60_000) return this.cache;
    const cutoff = Date.now() - this.days * 86_400_000;
    let latest = null;
    const clusters = new Map();
    const stories = new Map();
    const briefs = [];
    const articles = new Map();
    for (const f of files) {
      let snap;
      try {
        snap = JSON.parse(await readFile(f, 'utf8'));
      } catch {
        continue;
      }
      const at = Date.parse(snap.takenAt);
      if (!Number.isFinite(at) || at < cutoff) continue;
      if (!latest || snap.takenAt > latest) latest = snap.takenAt;
      for (const c of snap.clusters ?? []) {
        const prev = clusters.get(c.id);
        clusters.set(c.id, {
          ...normalizeCluster(c, { seenIn: 'archive', snapshotAt: snap.takenAt }),
          // keep the earliest firstSeen and the widest publisher count across snapshots
          firstSeen: prev?.firstSeen && prev.firstSeen < c.firstSeen ? prev.firstSeen : c.firstSeen,
          snapshots: (prev?.snapshots ?? 0) + 1,
        });
      }
      for (const s of snap.intelligenceStories ?? []) stories.set(s.primaryTitle, { ...s, snapshotAt: snap.takenAt });
      if (snap.brief) briefs.push({ ...snap.brief, takenAt: snap.takenAt });
      for (const a of snap.gdeltArticles ?? []) articles.set(a.url, a);
    }
    this.cache = { clusters: [...clusters.values()], stories: [...stories.values()], briefs, articles: [...articles.values()], files: files.length, latest, signature, loadedAt: Date.now() };
    return this.cache;
  }

  async searchClusters(terms) {
    const { clusters } = await this.load();
    const lower = terms.map((t) => t.toLowerCase());
    const hits = clusters.filter((c) => {
      const hay = `${c.title} ${(c.memberTitles ?? []).join(' ')}`.toLowerCase();
      return lower.some((t) => hay.includes(t));
    });
    return { clusters: hits, generatedAt: null, failures: [] };
  }

  async storyDetail(cluster) {
    const { stories } = await this.load();
    let best = null;
    for (const s of stories) {
      const score = overlapScore(cluster.title, `${s.primaryTitle} ${(s.memberTitles ?? []).join(' ')}`);
      if (!best || score > best.score) best = { score, s };
    }
    if (!best || best.score < 0.5) return null;
    return {
      memberTitles: best.s.memberTitles ?? [],
      uniqueSourceCount: best.s.uniqueSourceCount ?? null,
      corroborationSourceCount: best.s.corroborationSourceCount ?? null,
      entityCorroboration: best.s.entityCorroboration ?? null,
      pubDate: best.s.pubDate ?? null,
    };
  }

  async allClusters() {
    return (await this.load()).clusters;
  }

  async intelligenceStories() {
    return (await this.load()).stories;
  }

  async gdeltArticles() {
    return (await this.load()).articles;
  }

  /** The board from the archive: its top stories, then its clusters, as of the newest snapshot. */
  async boardClusters() {
    const { clusters, stories, latest } = await this.load();
    return { clusters: [...stories.map(storyAsCluster), ...clusters], asOf: latest };
  }
}

/** Live first, archive behind it: a headline from five days ago is still findable. */
export class CombinedSource {
  constructor(live, archive, { noNetwork = false } = {}) {
    this.live = live;
    this.archive = archive;
    this.noNetwork = noNetwork;
    this.kind = live ? (archive ? 'live+archive' : 'live') : 'archive';
  }

  async searchClusters(terms) {
    const [l, a, stories] = await Promise.all([
      this.live ? this.live.searchClusters(terms) : { clusters: [], failures: [] },
      this.archive ? this.archive.searchClusters(terms) : { clusters: [], failures: [] },
      // WorldMonitor's top stories are on the board too, so they must be findable.
      this.intelligenceStories().catch(() => []),
    ]);
    const lower = terms.map((t) => t.toLowerCase());
    for (const st of stories) {
      const hay = `${st.primaryTitle} ${(st.memberTitles ?? []).join(' ')}`.toLowerCase();
      if (lower.some((t) => hay.includes(t))) a.clusters.push(storyAsCluster(st));
    }
    const byId = new Map(a.clusters.map((c) => [c.id, c]));
    for (const c of l.clusters) {
      const old = byId.get(c.id);
      byId.set(c.id, old?.firstSeen && old.firstSeen < c.firstSeen ? { ...c, firstSeen: old.firstSeen } : c);
    }
    return { clusters: [...byId.values()], generatedAt: l.generatedAt ?? null, failures: [...(l.failures ?? [])] };
  }

  async storyDetail(cluster, term) {
    if (cluster.memberTitles?.length) return { memberTitles: cluster.memberTitles, entityCorroboration: cluster.entityCorroboration ?? null, corroborationSourceCount: cluster.corroborationSourceCount ?? null };
    return (this.live && cluster.seenIn === 'live' ? await this.live.storyDetail(cluster, term) : null)
      ?? (this.archive ? await this.archive.storyDetail(cluster, term) : null);
  }

  markets(terms) {
    return this.live ? this.live.markets(terms) : Promise.resolve([]);
  }

  articleText(url) {
    // Offline rehearsal makes no network calls: figures are checked against headlines only.
    return this.noNetwork ? Promise.resolve(null) : fetchArticleText(url);
  }

  async brief() {
    if (this.live) return this.live.brief();
    const { briefs } = await this.archive.load();
    return briefs.at(-1) ?? { headlines: [], topStories: [] };
  }

  async allClusters() {
    const [l, a] = await Promise.all([this.live?.allClusters() ?? [], this.archive?.allClusters() ?? []]);
    const byId = new Map(a.map((c) => [c.id, c]));
    for (const c of l) byId.set(c.id, c);
    return [...byId.values()];
  }

  async intelligenceStories() {
    const [l, a] = await Promise.all([this.live?.intelligenceStories() ?? [], this.archive?.intelligenceStories() ?? []]);
    const byTitle = new Map(a.map((s) => [s.primaryTitle, s]));
    for (const s of l) byTitle.set(s.primaryTitle, s);
    return [...byTitle.values()];
  }

  async weekClusters() {
    return this.archive ? (await this.archive.load()).clusters : [];
  }

  /** Live when connected; the archive only when WorldMonitor cannot be reached or there is no key. */
  async boardClusters({ force = false } = {}) {
    if (this.live) {
      try {
        const live = await this.live.boardClusters({ force });
        if (live.clusters.length) return { ...live, from: 'live' };
      } catch {
        // fall through to the archive
      }
    }
    const archived = this.archive ? await this.archive.boardClusters() : { clusters: [], asOf: null };
    return { ...archived, from: 'archive' };
  }

  async gdeltArticles() {
    const [l, a] = await Promise.all([this.live?.gdeltArticles() ?? [], this.archive?.gdeltArticles() ?? []]);
    return [...new Map([...a, ...l].map((x) => [x.url, x])).values()];
  }
}
