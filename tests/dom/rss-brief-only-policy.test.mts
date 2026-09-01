import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxyMocks = vi.hoisted(() => ({
  fetchWithProxy: vi.fn(),
}));
const trendingMocks = vi.hoisted(() => ({
  ingestHeadlines: vi.fn(),
}));
const classifierMocks = vi.hoisted(() => ({
  classifyWithAI: vi.fn(),
}));
const memoryMocks = vi.hoisted(() => ({
  isHeadlineMemoryEnabled: vi.fn(() => true),
  vectorStoreIngest: vi.fn(async () => undefined),
}));
const aiQueueMocks = vi.hoisted(() => ({
  canQueueAiClassification: vi.fn(() => true),
}));

vi.mock('@/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils')>(),
  fetchWithProxy: (...args: unknown[]) => proxyMocks.fetchWithProxy(...args),
}));
vi.mock('@/services/trending-keywords', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/trending-keywords')>(),
  ingestHeadlines: (...args: unknown[]) => trendingMocks.ingestHeadlines(...args),
}));
vi.mock('@/services/threat-classifier', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/threat-classifier')>(),
  classifyWithAI: (...args: unknown[]) => classifierMocks.classifyWithAI(...args),
}));
vi.mock('@/services/ai-flow-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/ai-flow-settings')>(),
  isHeadlineMemoryEnabled: () => memoryMocks.isHeadlineMemoryEnabled(),
}));
vi.mock('@/services/ml-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ml-worker')>();
  return {
    ...actual,
    mlWorker: {
      ...actual.mlWorker,
      get isAvailable() { return true; },
      isModelLoaded: () => true,
      vectorStoreIngest: (...args: unknown[]) => memoryMocks.vectorStoreIngest(...args),
    },
  };
});
vi.mock('@/services/ai-classify-queue', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/ai-classify-queue')>(),
  canQueueAiClassification: (...args: unknown[]) => aiQueueMocks.canQueueAiClassification(...args),
}));

import {
  BRIEF_ONLY_RSS_FETCH_POLICY,
  fetchFeed,
} from '@/services/rss';
import { fetchCountryCoverage } from '@/services/country-coverage';

function overlappingRss(titles: string[]): string {
  const items = titles.map((title, index) => `
    <item>
      <title>${title}</title>
      <link>https://news.example/${index + 1}</link>
      <pubDate>Mon, 31 Aug 2026 10:00:00 GMT</pubDate>
    </item>
  `).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

const OVERLAPPING_TITLES = [
  'Macron warns Europe after a security alert',
  'Macron convenes an emergency security council',
  'Macron addresses the nation after attacks',
  'Macron meets NATO allies on military posture',
  'Macron vows a response to the latest attack',
];

describe('brief-only RSS fetch policy', () => {
  beforeEach(() => {
    proxyMocks.fetchWithProxy.mockReset();
    trendingMocks.ingestHeadlines.mockReset();
    classifierMocks.classifyWithAI.mockReset();
    memoryMocks.vectorStoreIngest.mockReset();
    memoryMocks.vectorStoreIngest.mockResolvedValue(undefined);
    memoryMocks.isHeadlineMemoryEnabled.mockReturnValue(true);
    aiQueueMocks.canQueueAiClassification.mockReturnValue(true);
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not ingest overlapping country feeds into global analysis, and aborts a superseded country', async () => {
    const rss = overlappingRss(OVERLAPPING_TITLES);
    let releaseFrance!: () => void;
    const franceHold = new Promise<void>(resolve => {
      releaseFrance = resolve;
    });
    proxyMocks.fetchWithProxy.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      if (init?.signal) {
        await Promise.race([
          franceHold,
          new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
          }),
        ]);
      }
      return new Response(rss, {
        status: 200,
        headers: { 'Content-Type': 'application/rss+xml' },
      });
    });

    const franceController = new AbortController();
    const francePending = fetchCountryCoverage('France', ['macron'], { signal: franceController.signal });
    await vi.waitFor(() => expect(proxyMocks.fetchWithProxy).toHaveBeenCalledTimes(2));

    franceController.abort();
    await expect(francePending).rejects.toMatchObject({ name: 'AbortError' });

    proxyMocks.fetchWithProxy.mockImplementation(async () => new Response(rss, {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml' },
    }));
    const germany = await fetchCountryCoverage('Germany', ['berlin']);
    expect(germany.headlines).toHaveLength(5);

    expect(trendingMocks.ingestHeadlines).not.toHaveBeenCalled();
    expect(memoryMocks.vectorStoreIngest).not.toHaveBeenCalled();
    expect(classifierMocks.classifyWithAI).not.toHaveBeenCalled();

    const germanyItems = await fetchFeed({
      name: 'Country coverage: Germany',
      url: '/api/rss-proxy?url=https://news.google.com/rss/search?q=Germany',
    }, { policy: BRIEF_ONLY_RSS_FETCH_POLICY });
    const eventItems = await fetchFeed({
      name: 'Country events: Germany',
      url: '/api/rss-proxy?url=https://news.google.com/rss/search?q=events',
    }, { policy: BRIEF_ONLY_RSS_FETCH_POLICY });
    expect(germanyItems).toHaveLength(5);
    expect(eventItems).toHaveLength(5);
    expect(trendingMocks.ingestHeadlines).not.toHaveBeenCalled();
    expect(memoryMocks.vectorStoreIngest).not.toHaveBeenCalled();
    expect(classifierMocks.classifyWithAI).not.toHaveBeenCalled();

    releaseFrance();
  });
});
