import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClusteredEvent, NewsItem } from '@/types';

const workerMocks = vi.hoisted(() => ({
  clusterNews: vi.fn(),
}));
const mlMocks = vi.hoisted(() => ({
  available: false,
  clusterBySemanticSimilarity: vi.fn(),
}));

vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: workerMocks.clusterNews },
}));
vi.mock('@/services/ml-worker', () => ({
  mlWorker: {
    get isAvailable() { return mlMocks.available; },
    clusterBySemanticSimilarity: mlMocks.clusterBySemanticSimilarity,
  },
}));

import { clusterNews, clusterNewsHybrid, MAX_SEMANTIC_CLUSTER_INPUT } from '@/services/clustering';

function item(index: number, source = 'Reuters', title = `Distinct event ${index}`): NewsItem {
  return {
    source,
    title,
    link: `https://fixture.test/${index}`,
    pubDate: new Date(Date.UTC(2026, 8, 6, 12, 0) - index * 60_000),
    isAlert: false,
  };
}

function cluster(index: number, overrides: Partial<ClusteredEvent> = {}): ClusteredEvent {
  const primary = item(index, `Source ${index}`, `Cluster ${index}`);
  return {
    id: `cluster-${index}`,
    primaryTitle: primary.title,
    primarySource: primary.source,
    primaryLink: primary.link,
    sourceCount: 1,
    uniquePublisherCount: 1,
    topSources: [{ name: primary.source, tier: 4, url: primary.link }],
    allItems: [primary],
    firstSeen: primary.pubDate,
    lastUpdated: primary.pubDate,
    isAlert: false,
    ...overrides,
  };
}

describe('hybrid clustering initial worker stage (#7782)', () => {
  beforeEach(() => {
    workerMocks.clusterNews.mockReset();
    mlMocks.clusterBySemanticSimilarity.mockReset();
    mlMocks.available = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the existing analysis worker result for the initial stage', async () => {
    const items = [item(1), item(2)];
    const expected = clusterNews(items);
    workerMocks.clusterNews.mockResolvedValue(expected);

    await expect(clusterNewsHybrid(items)).resolves.toEqual(expected);
    expect(workerMocks.clusterNews).toHaveBeenCalledOnce();
    expect(workerMocks.clusterNews).toHaveBeenCalledWith(items);
  });

  it('falls back once for an unavailable empty result or worker error, but accepts genuine empty input', async () => {
    const items = [item(1), item(2)];
    const expected = clusterNews(items);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    workerMocks.clusterNews.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Worker reset'));
    await expect(clusterNewsHybrid(items)).resolves.toEqual(expected);
    await expect(clusterNewsHybrid(items)).resolves.toEqual(expected);
    await expect(clusterNewsHybrid([])).resolves.toEqual([]);

    expect(workerMocks.clusterNews).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not start semantic work after a generation is superseded', async () => {
    let resolveWorker!: (clusters: ClusteredEvent[]) => void;
    const pending = new Promise<ClusteredEvent[]>((resolve) => { resolveWorker = resolve; });
    workerMocks.clusterNews.mockReturnValue(pending);
    mlMocks.available = true;
    let current = true;

    const result = clusterNewsHybrid(
      Array.from({ length: 5 }, (_, index) => item(index)),
      { shouldContinue: () => current },
    );
    current = false;
    resolveWorker(Array.from({ length: 5 }, (_, index) => cluster(index)));

    await expect(result).resolves.toEqual([]);
    expect(mlMocks.clusterBySemanticSimilarity).not.toHaveBeenCalled();
  });

  it('does not fall back or start semantic work when teardown terminates the worker', async () => {
    let rejectWorker!: (error: Error) => void;
    const pending = new Promise<ClusteredEvent[]>((_resolve, reject) => { rejectWorker = reject; });
    workerMocks.clusterNews.mockReturnValue(pending);
    mlMocks.available = true;
    let current = true;

    const result = clusterNewsHybrid(
      Array.from({ length: 5 }, (_, index) => item(index)),
      { shouldContinue: () => current },
    );
    current = false;
    rejectWorker(new Error('Worker terminated'));

    await expect(result).resolves.toEqual([]);
    expect(mlMocks.clusterBySemanticSimilarity).not.toHaveBeenCalled();
  });

  it('preserves no-merge and multi-source semantic refinement', async () => {
    const newest = cluster(1, {
      primarySource: 'Unknown fixture publisher',
      topSources: [{ name: 'Unknown fixture publisher', tier: 4, url: 'https://fixture.test/unknown' }],
    });
    const trusted = cluster(2, {
      primarySource: 'Reuters',
      topSources: [{ name: 'Reuters', tier: 1, url: 'https://fixture.test/reuters' }],
    });
    const otherClusters = [cluster(3), cluster(4), cluster(5)];
    const workerClusters = [newest, trusted, ...otherClusters];
    workerMocks.clusterNews.mockResolvedValue(workerClusters);
    mlMocks.available = true;

    mlMocks.clusterBySemanticSimilarity.mockResolvedValueOnce(workerClusters.map(({ id }) => [id]));
    const unmerged = await clusterNewsHybrid(Array.from({ length: 5 }, (_, index) => item(index)));
    expect(unmerged.map(({ id }) => id)).toEqual(workerClusters.map(({ id }) => id));

    mlMocks.clusterBySemanticSimilarity.mockResolvedValueOnce([
      [newest.id, trusted.id],
      ...otherClusters.map(({ id }) => [id]),
    ]);
    const mergedResult = await clusterNewsHybrid(Array.from({ length: 5 }, (_, index) => item(index)));
    const merged = mergedResult.find(({ allItems }) => allItems.length === 2);
    expect(merged?.primarySource).toBe('Reuters');
    expect(merged?.sourceCount).toBe(2);
    expect(merged?.uniquePublisherCount).toBe(2);
    expect(merged?.allItems).toHaveLength(2);
    expect(merged?.firstSeen).toBeInstanceOf(Date);
    expect(merged?.lastUpdated).toBeInstanceOf(Date);
  });

  it('keeps the 250 semantic cap and all overflow clusters', async () => {
    const clusters = Array.from({ length: MAX_SEMANTIC_CLUSTER_INPUT + 10 }, (_, index) => cluster(index));
    workerMocks.clusterNews.mockResolvedValue(clusters);
    mlMocks.available = true;
    mlMocks.clusterBySemanticSimilarity.mockImplementation(async (candidates: Array<{ id: string }>) => (
      candidates.map(({ id }) => [id])
    ));

    const result = await clusterNewsHybrid(Array.from({ length: 260 }, (_, index) => item(index)));

    expect(mlMocks.clusterBySemanticSimilarity.mock.calls[0]?.[0]).toHaveLength(MAX_SEMANTIC_CLUSTER_INPUT);
    expect(result).toHaveLength(260);
  });

  it('passes more than 1,000 inputs to the shared worker core without changing tier semantics', async () => {
    const items = Array.from({ length: 1_001 }, (_, index) => item(index, 'Unknown fixture publisher'));
    items[0] = item(0, 'Reuters', items[1]!.title);
    const expected = clusterNews(items);
    workerMocks.clusterNews.mockResolvedValue(expected);

    const result = await clusterNewsHybrid(items);

    expect(workerMocks.clusterNews.mock.calls[0]?.[0]).toHaveLength(1_001);
    expect(result).toEqual(expected);
    expect(result[0]?.primarySource).toBe('Reuters');
  });

  it('keeps geo, language, credibility, and max threat across a semantic merge', async () => {
    const mildItem = item(1, 'Reuters', 'Shared border story');
    mildItem.lat = 10;
    mildItem.lon = 10;
    mildItem.lang = 'en';
    mildItem.credibilityScore = 81;
    mildItem.threat = { level: 'low', category: 'general', confidence: 0.2, source: 'keyword' };

    const severeItem = item(2, 'Unknown fixture publisher', 'Shared border story continues');
    severeItem.lat = 32.1;
    severeItem.lon = 44.2;
    severeItem.lang = 'ar';
    severeItem.monitorColor = '#c00';
    severeItem.threat = { level: 'critical', category: 'conflict', confidence: 0.9, source: 'keyword' };
    const corroborating = {
      ...severeItem,
      source: 'AP',
      link: 'https://fixture.test/ap',
    };

    const mild = cluster(1, {
      primarySource: 'Reuters',
      primaryTitle: mildItem.title,
      primaryLink: mildItem.link,
      lang: 'en',
      credibilityScore: 81,
      lat: 10,
      lon: 10,
      threat: mildItem.threat,
      monitorColor: '#stale',
      velocity: { sourcesPerHour: 99, level: 'spike', trend: 'rising', sentiment: 'negative', sentimentScore: -5 },
      allItems: [mildItem],
      topSources: [{ name: 'Reuters', tier: 1, url: mildItem.link }],
    });
    const severe = cluster(2, {
      primarySource: 'Unknown fixture publisher',
      threat: severeItem.threat,
      allItems: [severeItem, corroborating],
      topSources: [{ name: 'Unknown fixture publisher', tier: 4, url: severeItem.link }],
    });
    const others = [cluster(3), cluster(4), cluster(5)];
    workerMocks.clusterNews.mockResolvedValue([mild, severe, ...others]);
    mlMocks.available = true;
    mlMocks.clusterBySemanticSimilarity.mockResolvedValue([
      [mild.id, severe.id],
      ...others.map(({ id }) => [id]),
    ]);

    const mergedResult = await clusterNewsHybrid(Array.from({ length: 5 }, (_, index) => item(index)));
    const merged = mergedResult.find((entry) => entry.allItems.length === 3);

    expect(merged?.primarySource).toBe('Reuters');
    expect(merged?.lat).toBe(32.1);
    expect(merged?.lon).toBe(44.2);
    expect(merged?.lang).toBe('en');
    expect(merged?.credibilityScore).toBe(81);
    expect(merged?.threat?.level).toBe('critical');
    expect(merged?.monitorColor).toBe('#c00');
    expect(merged?.velocity?.sourcesPerHour).not.toBe(99);
  });
});
