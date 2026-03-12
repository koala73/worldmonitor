import type { NormalizedStory, StoryCluster } from '@/types/news-reader';
import { jaccardSimilarity } from './similarity';
import { getDb } from '@/services/db';

const CLUSTER_THRESHOLD = 0.6;
const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

const THREAT_PRIORITY: Record<string, number> = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1,
};

// ── Serialization ─────────────────────────────────────────────────────────

interface StoredCluster extends Omit<StoryCluster, 'firstSeen' | 'lastUpdated'> {
  firstSeen: string;
  lastUpdated: string;
}

function toStored(c: StoryCluster): StoredCluster {
  return { ...c, firstSeen: c.firstSeen.toISOString(), lastUpdated: c.lastUpdated.toISOString() };
}

function fromStored(s: StoredCluster): StoryCluster {
  return { ...s, firstSeen: new Date(s.firstSeen), lastUpdated: new Date(s.lastUpdated) };
}

// ── Cluster CRUD ──────────────────────────────────────────────────────────

export async function getClusters(limit = 50): Promise<StoryCluster[]> {
  const db = await getDb();
  const tx = db.transaction('clusters');
  const index = tx.store.index('firstSeen');
  const results: StoryCluster[] = [];
  let cursor = await index.openCursor(null, 'prev');
  while (cursor && results.length < limit) {
    results.push(fromStored(cursor.value as unknown as StoredCluster));
    cursor = await cursor.continue();
  }
  return results;
}

export async function getCluster(clusterId: string): Promise<StoryCluster | undefined> {
  const db = await getDb();
  const stored = await db.get('clusters', clusterId);
  return stored ? fromStored(stored as unknown as StoredCluster) : undefined;
}

async function putCluster(cluster: StoryCluster): Promise<void> {
  const db = await getDb();
  await db.put('clusters', toStored(cluster));
}

// ── Clustering logic ──────────────────────────────────────────────────────

function selectPrimary(stories: NormalizedStory[]): NormalizedStory {
  return stories.reduce((best, s) => {
    if (s.sourceTier < best.sourceTier) return s;
    if (s.sourceTier === best.sourceTier && s.publishedAt < best.publishedAt) return s;
    return best;
  });
}

function highestThreat(stories: NormalizedStory[]): string {
  let max = 'info';
  let maxP = 0;
  for (const s of stories) {
    const p = THREAT_PRIORITY[s.threatLevel] ?? 0;
    if (p > maxP) { maxP = p; max = s.threatLevel; }
  }
  return max;
}

function mergeKeywords(stories: NormalizedStory[]): string[] {
  const freq = new Map<string, number>();
  for (const s of stories) {
    for (const kw of s.keywords) {
      freq.set(kw, (freq.get(kw) ?? 0) + 1);
    }
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([kw]) => kw);
}

function mostCommon(items: string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best = items[0] || 'Global';
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) { bestCount = count; best = item; }
  }
  return best;
}

function calcVelocity(stories: NormalizedStory[]): number {
  if (stories.length < 2) return 0;
  const times = stories.map(s => s.publishedAt.getTime()).sort();
  const spanHours = (times[times.length - 1]! - times[0]!) / (1000 * 60 * 60);
  return spanHours > 0 ? stories.length / spanHours : 0;
}

export async function clusterStories(newStories: NormalizedStory[]): Promise<StoryCluster[]> {
  if (newStories.length === 0) return [];

  const db = await getDb();
  const cutoff = new Date(Date.now() - CLUSTER_WINDOW_MS).toISOString();

  // Load recent clusters
  const tx = db.transaction('clusters');
  const index = tx.store.index('firstSeen');
  const range = IDBKeyRange.lowerBound(cutoff);
  const recentStored = await index.getAll(range);
  const recentClusters = recentStored.map(s => fromStored(s as unknown as StoredCluster));

  const updatedClusters = new Map<string, StoryCluster>();
  const storyClusterAssignments: Array<{ storyId: string; clusterId: string }> = [];

  for (const story of newStories) {
    let bestCluster: StoryCluster | null = null;
    let bestSim = 0;

    // Compare against existing clusters
    for (const cluster of recentClusters) {
      const sim = jaccardSimilarity(story.cleanTitle, cluster.primaryTitle.toLowerCase());
      if (sim > bestSim && sim >= CLUSTER_THRESHOLD) {
        bestSim = sim;
        bestCluster = cluster;
      }
    }

    // Also check clusters created in this batch
    for (const cluster of updatedClusters.values()) {
      const sim = jaccardSimilarity(story.cleanTitle, cluster.primaryTitle.toLowerCase());
      if (sim > bestSim && sim >= CLUSTER_THRESHOLD) {
        bestSim = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      // Add to existing cluster
      const c = updatedClusters.get(bestCluster.clusterId) || { ...bestCluster };
      if (!c.storyIds.includes(story.id)) {
        c.storyIds.push(story.id);
        c.sourceCount = new Set(c.storyIds).size;
        c.lastUpdated = new Date();
        if (!c.topSources.find(s => s.name === story.source)) {
          c.topSources.push({ name: story.source, tier: story.sourceTier, url: story.url });
          c.topSources.sort((a, b) => a.tier - b.tier);
          c.topSources = c.topSources.slice(0, 5);
        }
        if (!c.categories.includes(story.category)) {
          c.categories.push(story.category);
        }
      }
      updatedClusters.set(c.clusterId, c);
      storyClusterAssignments.push({ storyId: story.id, clusterId: c.clusterId });
    } else {
      // Create new single-story cluster
      const clusterId = crypto.randomUUID();
      const newCluster: StoryCluster = {
        clusterId,
        primaryStoryId: story.id,
        primaryTitle: story.title,
        storyIds: [story.id],
        sourceCount: 1,
        topSources: [{ name: story.source, tier: story.sourceTier, url: story.url }],
        firstSeen: story.publishedAt,
        lastUpdated: new Date(),
        region: story.region,
        categories: [story.category],
        mergedKeywords: story.keywords,
        threatLevel: story.threatLevel,
        velocityScore: 0,
      };
      updatedClusters.set(clusterId, newCluster);
      recentClusters.push(newCluster);
      storyClusterAssignments.push({ storyId: story.id, clusterId });
    }
  }

  // Finalize cluster metadata using helpers
  const storyMap = new Map<string, NormalizedStory>();
  for (const s of newStories) storyMap.set(s.id, s);

  const allClusters = Array.from(updatedClusters.values());
  for (const cluster of allClusters) {
    const clusterStoryList = cluster.storyIds
      .map(id => storyMap.get(id))
      .filter((s): s is NormalizedStory => s !== undefined);

    if (clusterStoryList.length > 0) {
      const primary = selectPrimary(clusterStoryList);
      cluster.primaryStoryId = primary.id;
      cluster.primaryTitle = primary.title;
      cluster.threatLevel = highestThreat(clusterStoryList);
      cluster.mergedKeywords = mergeKeywords(clusterStoryList);
      cluster.region = mostCommon(clusterStoryList.map(s => s.region));
      cluster.velocityScore = calcVelocity(clusterStoryList);
    }
    cluster.sourceCount = cluster.storyIds.length;
  }

  // Batch write clusters
  for (const cluster of allClusters) {
    await putCluster(cluster);
  }

  // Update story cluster assignments
  const storyTx = db.transaction('stories', 'readwrite');
  for (const { storyId, clusterId } of storyClusterAssignments) {
    const story = await storyTx.store.get(storyId);
    if (story) {
      (story as Record<string, unknown>).clusterId = clusterId;
      storyTx.store.put(story);
    }
  }
  await storyTx.done;

  return allClusters;
}

export async function deleteOldClusters(olderThan: Date): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('clusters', 'readwrite');
  const index = tx.store.index('firstSeen');
  const range = IDBKeyRange.upperBound(olderThan.toISOString());
  let cursor = await index.openCursor(range);
  let deleted = 0;
  while (cursor) {
    await cursor.delete();
    deleted++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}
