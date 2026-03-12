// Pipeline: fetch → normalize → dedup → cluster
// Runs on a timer, never calls AI during ingestion

import type { NewsItem } from '@/types';
import type { NormalizedStory, StoryCluster } from '@/types/news-reader';
import { fetchCategoryFeeds } from '@/ingestion/rss';
import { getFeedsByCategory, getCategories } from '@/ingestion/feeds';
import { normalizeBatch } from '@/normalize/cleaner';
import { deduplicateStories } from '@/cluster/dedup';
import { clusterStories, getClusters, deleteOldClusters } from '@/cluster/cluster-engine';
import { putStories, getRecentStories, deleteOldStories } from '@/normalize/store';
import { getSettings } from '@/services/settings-store';

export type PipelineListener = (data: {
  stories: NormalizedStory[];
  clusters: StoryCluster[];
  loading: boolean;
  error: string | null;
  lastRefresh: Date | null;
}) => void;

let listeners: PipelineListener[] = [];
let latestStories: NormalizedStory[] = [];
let latestClusters: StoryCluster[] = [];
let loading = false;
let error: string | null = null;
let lastRefresh: Date | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  const data = { stories: latestStories, clusters: latestClusters, loading, error, lastRefresh };
  for (const fn of listeners) {
    try { fn(data); } catch { /* listener error */ }
  }
}

export function subscribePipeline(fn: PipelineListener): () => void {
  listeners.push(fn);
  // Immediately emit current state
  fn({ stories: latestStories, clusters: latestClusters, loading, error, lastRefresh });
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export async function runPipeline(): Promise<void> {
  if (loading) return;
  loading = true;
  error = null;
  notify();

  try {
    const settings = getSettings();
    const enabledCats = settings.enabledCategories.length > 0
      ? settings.enabledCategories
      : getCategories();

    // 1. Fetch feeds by category
    const allItems: NewsItem[] = [];
    for (const cat of enabledCats) {
      const feeds = getFeedsByCategory(cat);
      if (feeds.length === 0) continue;
      const items = await fetchCategoryFeeds(feeds, { batchSize: 5 });
      allItems.push(...items);
    }

    if (allItems.length === 0) {
      loading = false;
      lastRefresh = new Date();
      notify();
      return;
    }

    // 2. Normalize
    const normalized = await normalizeBatch(allItems);

    // 3. Dedup — keep only new, unique stories
    const existing = await getRecentStories(200);
    const existingIds = new Set(existing.map((s) => s.id));
    const newStories = deduplicateStories(normalized, existingIds);

    // 4. Store new stories
    if (newStories.length > 0) {
      await putStories(newStories);
    }

    // 5. Cluster all recent stories
    const allRecent = await getRecentStories(500);
    await clusterStories(allRecent);

    // 6. Cleanup old data (>48h)
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await deleteOldStories(cutoff);
    await deleteOldClusters(cutoff);

    // 7. Update state
    latestStories = await getRecentStories(200);
    latestClusters = await getClusters();
    lastRefresh = new Date();
    loading = false;
    error = null;
    notify();
  } catch (e) {
    console.error('[Pipeline] Error:', e);
    error = e instanceof Error ? e.message : 'Pipeline failed';
    loading = false;
    notify();
  }
}

export function startPipeline(): void {
  // Run immediately
  void runPipeline();

  // Set up recurring refresh
  const settings = getSettings();
  const intervalMs = (settings.feedRefreshInterval || 5) * 60 * 1000;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void runPipeline(), intervalMs);
}

export function stopPipeline(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function getPipelineState() {
  return { stories: latestStories, clusters: latestClusters, loading, error, lastRefresh };
}
