// Today's board: what WorldMonitor is tracking right now, split by its own
// coverage verdict. The desk only groups clusters that are one event (the
// digest can split an event across many one-outlet clusters, which would put
// a well-covered story in the "thin" column several times); WorldMonitor
// grades every group (lib/wm.mjs).

import { overlapScore, tokenize } from './text.mjs';
import { coverage, credibilityBand, ratePublishers, sourceCredibility } from './wm.mjs';

const GROUP_THRESHOLD = 0.4;
const MIN_SHARED_WORDS = 3;

function sameEvent(a, b) {
  const shared = new Set(tokenize(a)).size && [...new Set(tokenize(a))].filter((t) => new Set(tokenize(b)).has(t)).length;
  return shared >= MIN_SHARED_WORDS && Math.max(overlapScore(a, b), overlapScore(b, a)) >= GROUP_THRESHOLD;
}

/**
 * Single-linkage grouping: a cluster joins every group holding a headline of
 * the same event, and groups it bridges merge. Same-event needs three shared
 * content words and 40% overlap, so unrelated "Trump" stories stay apart.
 */
export function groupClusters(clusters) {
  let groups = [];
  for (const c of clusters) {
    if (!c?.title) continue;
    const hits = groups.filter((g) => g.members.some((m) => sameEvent(m.title, c.title)));
    if (!hits.length) {
      groups.push({ lead: c, members: [c] });
      continue;
    }
    const merged = { lead: hits[0].lead, members: [...hits.flatMap((g) => g.members), c] };
    groups = [...groups.filter((g) => !hits.includes(g)), merged];
  }
  return groups;
}

/** WorldMonitor's grade for one group of clusters. */
export function gradeGroup(group) {
  const all = group.members;
  const labels = [...new Set(all.flatMap((c) => [...(c.sources ?? []), ...(c.publishers ?? []).flatMap((p) => p.labels ?? [])]))];
  const reported = Math.max(0, ...all.map((c) => c.corroboration?.publishers ?? 0)) || null;
  const { verdict, roster } = coverage(labels, reported);
  const rated = ratePublishers(roster, verdict.publishers ?? 1);
  // The lead cluster's own WorldMonitor credibility when it stands alone; otherwise
  // the same formula over the group, led by the best-rated source.
  const own = all.length === 1 && Number.isFinite(group.lead.credibilityScore) ? group.lead.credibilityScore : null;
  const score = own ?? (rated[0] ? sourceCredibility(rated[0].labels[0] ?? rated[0].name, verdict.publishers ?? 1) : null);
  // The best-covered member's headline leads.
  const lead = [...all].sort((a, b) => (b.corroboration?.publishers ?? 0) - (a.corroboration?.publishers ?? 0))[0];
  return {
    title: lead.title,
    link: lead.link ?? null,
    state: verdict.state,
    publishers: verdict.publishers,
    clusters: all.length,
    credibility: score == null ? null : Math.round(score),
    band: score == null ? null : credibilityBand(score),
    top: rated.slice(0, 3).map((r) => ({ name: r.name, tier: r.tier, stateAffiliated: r.stateAffiliated })),
    stateAffiliated: [...new Set(rated.filter((r) => r.stateAffiliated).map((r) => r.stateAffiliated))],
    firstSeen: all.map((c) => c.firstSeen).filter(Boolean).sort()[0] ?? null,
    lastUpdated: all.map((c) => c.lastUpdated).filter(Boolean).sort().at(-1) ?? null,
    // Newsroom stories before blogs and press releases in the thin column.
    newsroom: rated.some((r) => r.tier && r.tier <= 2) || rated.some((r) => r.stateAffiliated),
    order: group.order,
  };
}

/**
 * @param {object[]} clusters WorldMonitor clusters, in WorldMonitor's own order
 * @param {{limit?: number}} [opts]
 */
export function buildBoard(clusters, { limit = 5, asOf = null } = {}) {
  const groups = groupClusters(clusters).map((g, order) => ({ ...g, order }));
  const graded = groups.map(gradeGroup);
  const corroborated = graded
    .filter((s) => s.state === 'corroborated')
    .sort((a, b) => b.publishers - a.publishers || (b.credibility ?? 0) - (a.credibility ?? 0));
  const thin = graded
    .filter((s) => s.state !== 'corroborated')
    .sort((a, b) => Number(b.newsroom) - Number(a.newsroom) || a.order - b.order);
  const count = (state) => graded.filter((s) => s.state === state).length;
  return {
    asOf,
    totals: {
      stories: graded.length,
      corroborated: count('corroborated'),
      singlePublisher: count('single-publisher'),
      lowTierOnly: count('tier4-only'),
      unknown: count('unknown'),
      clusters: clusters.length,
    },
    supported: corroborated.slice(0, limit),
    thin: thin.slice(0, limit),
  };
}
