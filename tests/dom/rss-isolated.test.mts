import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithProxy: vi.fn(),
  getPersistentCache: vi.fn(),
  setPersistentCache: vi.fn(),
  ingestHeadlines: vi.fn(),
  classifyWithAI: vi.fn(),
  canQueueAiClassification: vi.fn(() => true),
  inferGeoHubsFromTitle: vi.fn(() => [{ hub: { name: 'Paris', lat: 48.8566, lon: 2.3522 } }]),
  vectorStoreIngest: vi.fn(),
}));

vi.mock('@/config', () => ({ SITE_VARIANT: 'full' }));
vi.mock('@/utils', () => ({
  chunkArray: <T,>(items: T[]) => [items],
  fetchWithProxy: mocks.fetchWithProxy,
  hasNoStoreCacheDirective: () => false,
  isMobileDevice: () => false,
}));
vi.mock('@/utils/after-paint', () => ({ yieldToMain: () => Promise.resolve() }));
vi.mock('@/utils/yielding-work-queue', () => ({
  createYieldingWorkQueue: () => <T,>(work: () => T) => Promise.resolve(work()),
}));
vi.mock('@/services/threat-classifier', () => ({
  classifyByKeyword: () => ({
    level: 'medium',
    category: 'conflict',
    confidence: 0.8,
    source: 'keyword',
  }),
  classifyWithAI: mocks.classifyWithAI,
}));
vi.mock('@/services/geo-hub-index', () => ({ inferGeoHubsFromTitle: mocks.inferGeoHubsFromTitle }));
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: mocks.getPersistentCache,
  setPersistentCache: mocks.setPersistentCache,
}));
vi.mock('@/services/trending-keywords', () => ({ ingestHeadlines: mocks.ingestHeadlines }));
vi.mock('@/services/i18n', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('@/services/feed-language', () => ({ filterFeedsByLanguage: (feeds: unknown[]) => feeds }));
vi.mock('@/services/ai-classify-queue', () => ({
  AI_CLASSIFY_MAX_PER_FEED: 5,
  canQueueAiClassification: mocks.canQueueAiClassification,
}));
vi.mock('@/services/ml-worker', () => ({
  mlWorker: {
    isAvailable: true,
    isModelLoaded: () => true,
    vectorStoreIngest: mocks.vectorStoreIngest,
  },
}));
vi.mock('@/services/ai-flow-settings', () => ({ isHeadlineMemoryEnabled: () => true }));
vi.mock('@/services/data-freshness', () => ({ dataFreshness: { recordUpdate: vi.fn() } }));

import { fetchFeed, getFeedFailures } from '@/services/rss';

const RSS = `<?xml version="1.0"?><rss><channel><item>
  <title>France reports a conflict update</title>
  <link>https://example.test/story</link>
  <pubDate>Mon, 31 Aug 2026 10:00:00 GMT</pubDate>
</item></channel></rss>`;

describe('fetchFeed isolated mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWithProxy.mockResolvedValue(new Response(RSS, { status: 200 }));
  });

  it('keeps parsing and classification but bypasses every global feed effect', async () => {
    const signal = new AbortController().signal;

    const items = await fetchFeed(
      { name: 'Country coverage: France', url: '/api/rss-proxy?url=france' },
      { mode: 'isolated', signal },
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'France reports a conflict update',
      locationName: 'Paris',
      lat: 48.8566,
      lon: 2.3522,
      threat: { category: 'conflict', source: 'keyword' },
    });
    expect(mocks.inferGeoHubsFromTitle).toHaveBeenCalledWith('France reports a conflict update');
    expect(mocks.fetchWithProxy).toHaveBeenCalledWith(
      '/api/rss-proxy?url=france',
      { signal, responseCache: 'bypass' },
    );
    expect(mocks.getPersistentCache).not.toHaveBeenCalled();
    expect(mocks.setPersistentCache).not.toHaveBeenCalled();
    expect(mocks.ingestHeadlines).not.toHaveBeenCalled();
    expect(mocks.vectorStoreIngest).not.toHaveBeenCalled();
    expect(mocks.canQueueAiClassification).not.toHaveBeenCalled();
    expect(mocks.classifyWithAI).not.toHaveBeenCalled();
  });

  it('rejects an aborted request without recording failure or emitting an error log', async () => {
    let release!: (response: Response) => void;
    mocks.fetchWithProxy.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pending = fetchFeed(
      { name: 'Aborted isolated feed', url: '/api/rss-proxy?url=aborted' },
      { mode: 'isolated', signal: controller.signal },
    );
    controller.abort();
    release(new Response(RSS, { status: 200 }));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFeedFailures().has('Aborted isolated feed::en')).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mocks.getPersistentCache).not.toHaveBeenCalled();
    expect(mocks.setPersistentCache).not.toHaveBeenCalled();
    expect(mocks.ingestHeadlines).not.toHaveBeenCalled();
    expect(mocks.vectorStoreIngest).not.toHaveBeenCalled();
    expect(mocks.canQueueAiClassification).not.toHaveBeenCalled();
    expect(mocks.classifyWithAI).not.toHaveBeenCalled();
  });
});
