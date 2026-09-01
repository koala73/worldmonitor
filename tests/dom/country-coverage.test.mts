import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NewsItem } from '@/types';

const rssMocks = vi.hoisted(() => ({
  fetchFeed: vi.fn(),
}));
const runtimeMocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(() => false),
}));

vi.mock('@/services/rss', () => ({
  fetchFeed: rssMocks.fetchFeed,
}));
vi.mock('@/services/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime')>(),
  isDesktopRuntime: runtimeMocks.isDesktopRuntime,
}));

import { fetchCountryCoverage } from '@/services/country-coverage';

function newsItem(
  title: string,
  category: NonNullable<NewsItem['threat']>['category'],
  pubDate: Date,
): NewsItem {
  return {
    source: 'Country coverage: France',
    title,
    link: `https://example.com/${encodeURIComponent(title)}`,
    pubDate,
    isAlert: false,
    threat: {
      level: category === 'military' ? 'high' : 'medium',
      category,
      confidence: 0.9,
      source: 'keyword',
    },
  };
}

describe('country coverage', () => {
  beforeEach(() => {
    rssMocks.fetchFeed.mockReset();
    runtimeMocks.isDesktopRuntime.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads recent country headlines and maps only timeline event categories', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    const signal = new AbortController().signal;
    const recentMilitary = newsItem(
      'France deploys military units after security alert',
      'military',
      new Date('2026-08-31T10:00:00Z'),
    );
    const recentProtest = newsItem(
      'French unions plan a national protest',
      'protest',
      new Date('2026-08-30T09:00:00Z'),
    );
    const recentEconomic = newsItem(
      'France reports stronger quarterly growth - Reuters',
      'economic',
      new Date('2026-08-29T08:00:00Z'),
    );
    const staleConflict = newsItem(
      'France reviews an older conflict report',
      'conflict',
      new Date('2026-08-20T07:00:00Z'),
    );
    rssMocks.fetchFeed.mockImplementation(async (feed) => (
      feed.name === 'Country events: France'
        ? [recentMilitary, recentProtest, recentEconomic, staleConflict]
        : [recentEconomic, staleConflict]
    ));

    const coverage = await fetchCountryCoverage({
      country: 'France',
      searchTerms: ['france', 'french', 'paris'],
      signal,
    });

    expect(rssMocks.fetchFeed).toHaveBeenCalledTimes(2);
    const queries = rssMocks.fetchFeed.mock.calls.map(([feed, options]) => {
      expect(options).toEqual({ mode: 'isolated', signal });
      const proxyUrl = new URL(feed.url, 'https://worldmonitor.test');
      expect(proxyUrl.pathname).toBe('/api/rss-proxy');
      const feedUrl = new URL(proxyUrl.searchParams.get('url') ?? '');
      expect(feedUrl.hostname).toBe('news.google.com');
      return feedUrl.searchParams.get('q');
    });
    expect(queries).toEqual([
      '"France" when:7d',
      '("France" OR "french" OR "paris") (protest OR demonstration OR riot OR conflict OR attack OR military OR earthquake OR flood OR wildfire) when:7d',
    ]);
    expect(coverage.headlines).toEqual([{
      ...recentEconomic,
      title: 'France reports stronger quarterly growth',
      source: 'Reuters',
    }]);
    expect(coverage.timelineEvents).toEqual([
      {
        timestamp: recentMilitary.pubDate.getTime(),
        lane: 'military',
        label: recentMilitary.title,
        severity: 'high',
        source: recentMilitary.source,
        link: recentMilitary.link,
      },
      {
        timestamp: recentProtest.pubDate.getTime(),
        lane: 'protest',
        label: recentProtest.title,
        severity: 'medium',
        source: recentProtest.source,
        link: recentProtest.link,
      },
    ]);
  });

  it('routes desktop country feeds through the local RSS proxy', async () => {
    runtimeMocks.isDesktopRuntime.mockReturnValue(true);
    rssMocks.fetchFeed.mockResolvedValue([]);
    const signal = new AbortController().signal;

    await fetchCountryCoverage({ country: 'France', searchTerms: [], signal });

    expect(rssMocks.fetchFeed).toHaveBeenCalledTimes(2);
    for (const [feed, options] of rssMocks.fetchFeed.mock.calls) {
      expect(options).toEqual({ mode: 'isolated', signal });
      const proxyUrl = new URL(feed.url, 'https://desktop.local');
      expect(proxyUrl.pathname).toBe('/api/rss-proxy');
      expect(new URL(proxyUrl.searchParams.get('url') ?? '').hostname).toBe('news.google.com');
    }
  });

  it('rejects before starting either feed when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(fetchCountryCoverage({
      country: 'France',
      searchTerms: [],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(rssMocks.fetchFeed).not.toHaveBeenCalled();
  });
});
