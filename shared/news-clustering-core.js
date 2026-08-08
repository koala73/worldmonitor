/**
 * News clustering core — the client's Jaccard clustering algorithm, moved
 * verbatim from src/services/analysis-core.ts (which re-exports from here)
 * so the server-side get_news_clusters MCP tool produces the same clusters
 * agents see in the dashboard (issue #5697).
 *
 * NOTE: shared/story-identity.js hosts the OTHER shared similarity
 * implementation (cosine over token vectors, used by the server digest dedup
 * and seeders). This module deliberately mirrors the CLIENT's clustering so
 * MCP output matches the UI; do not merge the two without deciding which
 * similarity definition wins product-wide.
 *
 * effectivePubDateMs also lives here (moved from src/services/feed-date.ts,
 * re-exported there) because the input cap's recency sort depends on it.
 *
 * ESM, depends only on ./text-analysis-core.js. Types in
 * news-clustering-core.d.ts.
 */

import { SIMILARITY_THRESHOLD, SUPPRESSED_TRENDING_TERMS, jaccardSimilarity, tokenize } from './text-analysis-core.js';

export const MAX_CLUSTER_NEWS_ITEMS = 1000;

const THREAT_PRIORITY = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1,
};

/**
 * Proto threat-level enum -> the ThreatLevel labels this module's clustering
 * works in. Single source of truth for both the client digest loader and the
 * server-side MCP tools; a second hand-maintained copy is exactly the drift
 * this module exists to prevent.
 */
export const PROTO_TO_THREAT_LEVEL = {
  THREAT_LEVEL_UNSPECIFIED: 'info',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_CRITICAL: 'critical',
};

/** Proto threat level -> label, falling back to 'info' for unknown values. */
export function protoThreatLevelToLabel(value) {
  return PROTO_TO_THREAT_LEVEL[value] ?? 'info';
}

/**
 * Returns the timestamp a ranking/recency comparator should use for this
 * item. Items flagged `pubDateMissing: true` get 0 — they sort last in
 * "newest first" comparators and fail every positive-duration recency gate.
 */
export function effectivePubDateMs(item) {
  if (item.pubDateMissing === true) return 0;
  if (item.pubDate instanceof Date) {
    const ms = item.pubDate.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof item.pubDate === 'number') {
    // Filter NaN / Infinity. Cache-deserialized entries or future numeric
    // pubDate constructors should never claim freshness with a non-finite
    // stamp — sort comparators on NaN have unspecified behavior per the
    // JS spec.
    return Number.isFinite(item.pubDate) ? item.pubDate : 0;
  }
  // String case (serialized form, e.g. from cache deserialization).
  const ms = new Date(item.pubDate).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function aggregateThreats(items) {
  const withThreat = items.filter(i => i.threat);
  if (withThreat.length === 0) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }
  let maxLevel = 'info';
  let maxPriority = 0;
  for (const item of withThreat) {
    const p = THREAT_PRIORITY[item.threat.level];
    if (p > maxPriority) { maxPriority = p; maxLevel = item.threat.level; }
  }
  const catCounts = new Map();
  for (const item of withThreat) {
    const cat = item.threat.category;
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }
  let topCat = 'general';
  let topCount = 0;
  for (const [cat, count] of catCounts) {
    if (count > topCount) { topCount = count; topCat = cat; }
  }
  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of withThreat) {
    const weight = item.tier ? (6 - Math.min(item.tier, 5)) : 1;
    weightedSum += item.threat.confidence * weight;
    weightTotal += weight;
  }
  return {
    level: maxLevel,
    category: topCat,
    confidence: weightTotal > 0 ? weightedSum / weightTotal : 0.5,
    source: 'keyword',
  };
}

function generateClusterId(items) {
  const sorted = [...items].sort((a, b) => a.pubDate.getTime() - b.pubDate.getTime());
  const first = sorted[0];
  return `${first.pubDate.getTime()}-${first.title.slice(0, 20).replace(/\W/g, '')}`;
}

/**
 * Cluster news items by title similarity using Jaccard index.
 * Pure function - no side effects.
 */
export function clusterNewsCore(items, getSourceTier) {
  if (items.length === 0) return [];

  const boundedItems = items.length > MAX_CLUSTER_NEWS_ITEMS
    ? [...items]
        .sort((a, b) =>
          effectivePubDateMs(b) - effectivePubDateMs(a)
          || a.source.localeCompare(b.source)
          || a.title.localeCompare(b.title)
          || a.link.localeCompare(b.link)
        )
        .slice(0, MAX_CLUSTER_NEWS_ITEMS)
    : items;

  const itemsWithTier = boundedItems.map(item => ({
    ...item,
    tier: item.tier ?? getSourceTier(item.source),
  }));

  const tokenCache = new Map();
  const tokenList = [];
  const invertedIndex = new Map();
  for (const item of itemsWithTier) {
    const tokens = tokenize(item.title);
    tokenCache.set(item.title, tokens);
    tokenList.push(tokens);
  }

  for (let index = 0; index < tokenList.length; index++) {
    const tokens = tokenList[index];
    for (const token of tokens) {
      const bucket = invertedIndex.get(token);
      if (bucket) {
        bucket.push(index);
      } else {
        invertedIndex.set(token, [index]);
      }
    }
  }

  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < itemsWithTier.length; i++) {
    if (assigned.has(i)) continue;

    const currentItem = itemsWithTier[i];
    const cluster = [currentItem];
    assigned.add(i);
    const tokensI = tokenList[i];

    const candidateIndices = new Set();
    for (const token of tokensI) {
      const bucket = invertedIndex.get(token);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (idx > i) {
          candidateIndices.add(idx);
        }
      }
    }

    const sortedCandidates = Array.from(candidateIndices).sort((a, b) => a - b);
    for (const j of sortedCandidates) {
      if (assigned.has(j)) {
        continue;
      }

      const otherItem = itemsWithTier[j];
      const tokensJ = tokenList[j];
      const similarity = jaccardSimilarity(tokensI, tokensJ);

      if (similarity >= SIMILARITY_THRESHOLD) {
        cluster.push(otherItem);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters.map(cluster => {
    const sorted = [...cluster].sort((a, b) => {
      const tierDiff = a.tier - b.tier;
      if (tierDiff !== 0) return tierDiff;
      return effectivePubDateMs(b) - effectivePubDateMs(a);
    });

    const primary = sorted[0];
    const dates = cluster.map(i => i.pubDate.getTime());

    const topSources = sorted
      .slice(0, 3)
      .map(item => ({
        name: item.source,
        tier: item.tier,
        url: item.link,
      }));

    const threat = aggregateThreats(cluster);

    // Pick most common geo location across items
    const locItems = cluster.filter(i => i.lat != null && i.lon != null);
    let clusterLat;
    let clusterLon;
    if (locItems.length > 0) {
      const locCounts = new Map();
      for (const li of locItems) {
        const key = `${li.lat},${li.lon}`;
        const entry = locCounts.get(key) || { lat: li.lat, lon: li.lon, count: 0 };
        entry.count++;
        locCounts.set(key, entry);
      }
      const best = Array.from(locCounts.values()).sort((a, b) => b.count - a.count)[0];
      clusterLat = best.lat;
      clusterLon = best.lon;
    }

    return {
      id: generateClusterId(cluster),
      primaryTitle: primary.title,
      primarySource: primary.source,
      primaryLink: primary.link,
      sourceCount: cluster.length,
      topSources,
      allItems: cluster,
      firstSeen: new Date(dates.reduce((min, d) => d < min ? d : min)),
      lastUpdated: new Date(dates.reduce((max, d) => d > max ? d : max)),
      isAlert: cluster.some(i => i.isAlert),
      monitorColor: cluster.find(i => i.monitorColor)?.monitorColor,
      threat,
      ...(clusterLat != null && { lat: clusterLat, lon: clusterLon }),
      lang: primary.lang,
    };
  }).sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
}

/**
 * Top keywords for a cluster by token frequency across member titles,
 * excluding suppressed generic news terms. Server-side MCP helper — the
 * client derives no per-cluster keywords today.
 */
export function topClusterKeywords(cluster, limit = 5) {
  const counts = new Map();
  for (const item of cluster.allItems) {
    for (const token of tokenize(item.title)) {
      if (SUPPRESSED_TRENDING_TERMS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}
