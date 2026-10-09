// Finds the show-stopper: a story that looked big but traces to one newsroom.
// Three patterns, each read straight off WorldMonitor's own counts:
//
//   echo     one publisher family filed it under many feeds/editions, and
//            nobody else carried it (corroboration.state === single-publisher).
//   cascade  several outlets carried it, but their headlines all hang the
//            claim on the same named origin ("... Reuters reports").
//   ungated  many outlets carried it, yet the insights seeder's independent
//            entity-corroboration gate never fired.
//   syndication  the same headline on several "different" sites that share
//            one owner (iHeart station pages, one content network's mastheads):
//            many URLs, one newsroom. Read from the GDELT articles in
//            get_news_intelligence.
//
// Candidates are ranked, never auto-published: the presenter opens the links
// and picks one with `find-reveal --pick N` before going on stage.

import { attributionCascade } from './text.mjs';

function labelCount(cluster) {
  const fromRoster = (cluster.publishers ?? []).reduce((n, p) => n + (p.labels?.length ?? 0), 0);
  return Math.max(fromRoster, cluster.sources?.length ?? 0);
}

export function echoCandidates(clusters) {
  return clusters
    .filter((c) => c.corroboration?.state === 'single-publisher' && (c.memberCount ?? 0) >= 3)
    .map((c) => ({
      pattern: 'echo',
      title: c.title,
      link: c.link,
      origin: c.publishers?.[0]?.name ?? c.primarySource,
      headlineCount: c.memberCount,
      labelCount: labelCount(c),
      publisherFamilies: 1,
      feedLabels: c.sources,
      firstSeen: c.firstSeen,
      lastUpdated: c.lastUpdated,
      seenIn: c.seenIn ?? null,
      memberTitles: c.memberTitles ?? null,
      score: (c.memberCount ?? 0) + 2 * labelCount(c),
      why: `${c.memberCount} headlines across ${labelCount(c)} feed label(s), all one publisher family.`,
    }));
}

export function cascadeCandidates(items) {
  const out = [];
  for (const s of items) {
    const titles = s.memberTitles ?? [];
    if (titles.length < 3) continue;
    const c = attributionCascade(titles);
    if (!c.origin || c.origin === '(unnamed sources)' || c.originCount < 3) continue;
    if (c.originCount / Math.max(1, c.attributed) < 0.6) continue;
    const outlets = s.uniqueSourceCount ?? s.distinctSourceCount ?? s.corroboration?.publishers ?? null;
    out.push({
      pattern: 'cascade',
      title: s.primaryTitle ?? s.title,
      link: s.primaryLink ?? s.link ?? null,
      origin: c.origin,
      headlineCount: titles.length,
      outlets,
      originCount: c.originCount,
      memberTitles: titles.slice(0, 15),
      firstSeen: s.firstSeen ?? s.pubDate ?? null,
      lastUpdated: s.lastUpdated ?? null,
      seenIn: s.seenIn ?? (s.snapshotAt ? 'archive' : 'live'),
      score: 3 * c.originCount + (outlets ?? 0),
      why: `${c.originCount} of ${titles.length} headlines attribute the claim to ${c.origin}.`,
    });
  }
  return out;
}

export function ungatedCandidates(stories) {
  return stories
    .filter((s) => (s.uniqueSourceCount ?? 0) >= 4 && s.entityCorroboration === false && (s.corroborationSourceCount ?? 0) === 0)
    // Several independent families already corroborate it: not a single-source story, whatever the entity gate says.
    .filter((s) => !(s.corroboration?.state === 'corroborated' && (s.corroboration.publishers ?? 0) >= 3))
    .map((s) => ({
      pattern: 'ungated',
      title: s.primaryTitle ?? s.title,
      link: s.primaryLink ?? null,
      origin: s.primarySource ?? null,
      headlineCount: s.sourceCount ?? s.memberTitles?.length ?? null,
      outlets: s.uniqueSourceCount,
      memberTitles: (s.memberTitles ?? []).slice(0, 15),
      firstSeen: s.pubDate ?? null,
      lastUpdated: s.lastUpdated ?? null,
      seenIn: s.snapshotAt ? 'archive' : 'live',
      score: s.uniqueSourceCount,
      why: `${s.uniqueSourceCount} outlets carried it; the independent entity-corroboration gate did not fire.`,
    }));
}

const SUFFIX = /\s+[|–—-]\s+[^|–—-]{2,60}$/;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Registrable-ish owner: kfbk.iheart.com -> iheart.com. Good enough for the families GDELT shows. */
function ownerOf(host) {
  const parts = host.split('.');
  const twoLevel = /\.(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(host);
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

/** A shared numeric article id in the path (content networks reuse it across mastheads). */
function articleId(url) {
  return url.match(/\/(\d{6,})\//)?.[1] ?? null;
}

export function syndicationCandidates(articles) {
  const groups = new Map();
  for (const a of articles ?? []) {
    const host = a.url && hostOf(a.url);
    if (!host || !a.title) continue;
    const key = a.title.replace(SUFFIX, '').trim().toLowerCase();
    if (key.length < 12) continue;
    const g = groups.get(key) ?? { title: a.title.replace(SUFFIX, '').trim(), items: [] };
    if (!g.items.some((i) => i.host === host)) g.items.push({ host, owner: ownerOf(host), id: articleId(a.url), url: a.url, title: a.title });
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.items.length < 3) continue;
    const owners = new Set(g.items.map((i) => i.owner));
    const ids = new Set(g.items.map((i) => i.id).filter(Boolean));
    const oneOwner = owners.size === 1 || (ids.size === 1 && g.items.every((i) => i.id));
    if (!oneOwner) continue;
    const owner = [...owners][0];
    out.push({
      pattern: 'syndication',
      title: g.title,
      link: g.items[0].url,
      origin: owner,
      headlineCount: g.items.length,
      outlets: g.items.length,
      feedLabels: g.items.map((i) => i.host),
      memberTitles: g.items.map((i) => i.title),
      links: g.items.map((i) => i.url),
      publisherFamilies: 1,
      seenIn: 'gdelt',
      score: 4 * g.items.length,
      why: `${g.items.length} different sites ran the identical headline; every one belongs to ${owner}.`,
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
  const allClusters = [...byId.values()];
  const candidates = [
    ...echoCandidates(allClusters),
    ...cascadeCandidates([...stories, ...allClusters.filter((c) => c.memberTitles?.length)]),
    ...ungatedCandidates(stories),
    ...syndicationCandidates(articles),
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
