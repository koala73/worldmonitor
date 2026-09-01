import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NewsItem } from '@/types';

const rssMocks = vi.hoisted(() => ({
  fetchFeed: vi.fn(),
}));

vi.mock('@/services/rss', () => ({
  fetchFeed: rssMocks.fetchFeed,
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads recent country headlines and maps only timeline event categories', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
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

    const coverage = await fetchCountryCoverage('France', ['france', 'french', 'paris']);

    expect(rssMocks.fetchFeed).toHaveBeenCalledTimes(2);
    const queries = rssMocks.fetchFeed.mock.calls.map(([feed]) => {
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
      },
      {
        timestamp: recentProtest.pubDate.getTime(),
        lane: 'protest',
        label: recentProtest.title,
        severity: 'medium',
      },
    ]);
  });
});
