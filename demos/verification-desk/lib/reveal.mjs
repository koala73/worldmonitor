// Finds the show-stopper: a story that looked big but traces to one newsroom.
// The desk only groups candidates; WorldMonitor decides how many publishers
// stand behind each one:
//
//   syndication  the same headline on several open-web sites (GDELT rows in
//                get_news_intelligence). WorldMonitor's briefGroundingPublisherCount
//                folds labels, curated domains and registrable domains into
//                publishers: six iHeart station sites are one publisher.
//   echo         many headlines that assessCorroboration says are one publisher.
//   ungated      several outlets, but the insights seeder's entity-corroboration
//                gate never fired and WorldMonitor does not call it corroborated.
//
// Candidates are ranked, never auto-published: the presenter opens the links
// and picks one with `find-reveal --pick N` before going on stage.

import { briefGroundingGap, briefGroundingPublisherCount, coverage } from './wm.mjs';

const SUFFIX = /\s+[|–—-]\s+[^|–—-]{2,60}$/;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function syndicationCandidates(articles) {
  const groups = new Map();
  for (const a of articles ?? []) {
    const host = a.url && hostOf(a.url);
    if (!host || !a.title) continue;
    const title = a.title.replace(SUFFIX, '').trim();
    if (title.length < 12) continue;
    const key = title.toLowerCase();
    const g = groups.get(key) ?? { title, rows: [] };
    if (!g.rows.some((r) => hostOf(r.url) === host)) g.rows.push({ source: host, url: a.url, title: a.title });
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.rows.length < 3) continue;
    const publishers = briefGroundingPublisherCount(g.rows);
    if (publishers !== 1) continue;
    out.push({
      pattern: 'syndication',
      title: g.title,
      link: g.rows[0].url,
      origin: g.rows[0].url ? new URL(g.rows[0].url).hostname.split('.').slice(-2).join('.') : null,
      headlineCount: g.rows.length,
      outlets: g.rows.length,
      publishers,
      groundingGap: briefGroundingGap(g.rows),
      feedLabels: g.rows.map((r) => r.source),
      memberTitles: g.rows.map((r) => r.title),
      links: g.rows.map((r) => r.url),
      seenIn: 'gdelt',
      score: 4 * g.rows.length,
      why: `${g.rows.length} sites ran the identical headline; WorldMonitor counts them as ${publishers} publisher (${briefGroundingGap(g.rows) ?? 'grounded'}).`,
    });
  }
  return out;
}

export function echoCandidates(clusters) {
  const out = [];
  for (const c of clusters) {
    if ((c.memberCount ?? 0) < 3) continue;
    const { verdict, roster } = coverage([...(c.sources ?? [])], c.corroboration?.publishers ?? null);
    if (verdict.state !== 'single-publisher') continue;
    out.push({
      pattern: 'echo',
      title: c.title,
      link: c.link,
      origin: roster[0]?.name ?? c.primarySource,
      headlineCount: c.memberCount,
      outlets: c.sources?.length ?? 1,
      publishers: 1,
      feedLabels: c.sources,
      firstSeen: c.firstSeen,
      lastUpdated: c.lastUpdated,
      seenIn: c.seenIn ?? null,
      memberTitles: c.memberTitles ?? null,
      score: (c.memberCount ?? 0) + 2 * (c.sources?.length ?? 1),
      why: `${c.memberCount} headlines across ${c.sources?.length ?? 1} feed label(s); WorldMonitor: one publisher.`,
    });
  }
  return out;
}

export function ungatedCandidates(stories) {
  const out = [];
  for (const s of stories) {
    if ((s.uniqueSourceCount ?? 0) < 4 || s.entityCorroboration !== false || (s.corroborationSourceCount ?? 0) !== 0) continue;
    const { verdict } = coverage(s.sources ?? [], s.corroborationCount ?? null);
    if (verdict.state === 'corroborated') continue;
    out.push({
      pattern: 'ungated',
      title: s.primaryTitle ?? s.title,
      link: s.primaryLink ?? null,
      origin: s.primarySource ?? null,
      headlineCount: s.sourceCount ?? s.memberTitles?.length ?? null,
      outlets: s.uniqueSourceCount,
      memberTitles: (s.memberTitles ?? []).slice(0, 15),
      firstSeen: s.pubDate ?? null,
      seenIn: s.snapshotAt ? 'archive' : 'live',
      score: s.uniqueSourceCount,
      why: `${s.uniqueSourceCount} outlets; WorldMonitor's entity-corroboration gate did not fire and coverage is ${verdict.state}.`,
    });
  }
  return out;
}

export async function findRevealCandidates(source, { limit = 10 } = {}) {
  const [clusters, week, stories, articles] = await Promise.all([
    source.allClusters(),
    source.weekClusters ? source.weekClusters() : [],
    source.intelligenceStories(),
    source.gdeltArticles ? source.gdeltArticles() : [],
  ]);
  const byId = new Map([...week, ...clusters].map((c) => [c.id, c]));
  const candidates = [
    ...syndicationCandidates(articles),
    ...echoCandidates([...byId.values()]),
    ...ungatedCandidates(stories),
  ];
  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      const key = c.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
