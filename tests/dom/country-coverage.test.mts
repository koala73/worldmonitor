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
import {
  COVERAGE_CLUSTER_WINDOW_MS,
  clusterCountryTimelineIncidents,
  reconcileCountryTimelineIncidents,
  type CountryTimelineIncident,
} from '@/services/country-timeline-events';

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
        timestamp: recentProtest.pubDate.getTime(),
        lane: 'protest',
        label: recentProtest.title,
        severity: 'medium',
      },
      {
        timestamp: recentMilitary.pubDate.getTime(),
        lane: 'military',
        label: recentMilitary.title,
        severity: 'high',
      },
    ]);
  });

  it('clusters same-lane coverage reprints of one incident', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    const first = newsItem(
      'Thousands join Paris protest after police clash',
      'protest',
      new Date('2026-08-31T08:00:00Z'),
    );
    const reprint = newsItem(
      'Crowds join Paris protest after police clash',
      'protest',
      new Date('2026-08-31T10:00:00Z'),
    );
    const laterWording = newsItem(
      'Thousands join the Paris protest after a police clash',
      'protest',
      new Date('2026-08-31T12:00:00Z'),
    );
    laterWording.threat = { ...laterWording.threat!, level: 'high' };
    const distinct = newsItem(
      'French unions plan a national protest next week',
      'protest',
      new Date('2026-08-30T09:00:00Z'),
    );
    rssMocks.fetchFeed.mockImplementation(async (feed) => (
      feed.name === 'Country events: France'
        ? [first, reprint, laterWording, distinct]
        : []
    ));

    const coverage = await fetchCountryCoverage('France');

    expect(coverage.timelineEvents).toEqual([
      {
        timestamp: distinct.pubDate.getTime(),
        lane: 'protest',
        label: distinct.title,
        severity: 'medium',
      },
      {
        timestamp: first.pubDate.getTime(),
        lane: 'protest',
        label: first.title,
        severity: 'high',
      },
    ]);
  });

  it('keeps similar coverage articles in different lanes or outside the window', () => {
    const t0 = Date.parse('2026-08-31T08:00:00Z');
    const protest: CountryTimelineIncident = {
      timestamp: t0,
      lane: 'protest',
      label: 'Thousands join Paris protest after police clash',
      severity: 'medium',
    };
    const conflict: CountryTimelineIncident = {
      timestamp: t0 + 60 * 60 * 1000,
      lane: 'conflict',
      label: 'Thousands join Paris protest after police clash',
      severity: 'high',
    };
    const laterWave: CountryTimelineIncident = {
      timestamp: t0 + COVERAGE_CLUSTER_WINDOW_MS + 1,
      lane: 'protest',
      label: 'Crowds join Paris protest after police clash',
      severity: 'low',
    };

    expect(clusterCountryTimelineIncidents([protest, conflict, laterWave])).toEqual([
      protest,
      conflict,
      laterWave,
    ]);
  });

  it('prefers one structured record over several matching coverage articles', () => {
    const t0 = Date.parse('2026-08-31T08:00:00Z');
    const articles: CountryTimelineIncident[] = [
      {
        timestamp: t0,
        lane: 'protest',
        label: 'Thousands join Paris protest after police clash',
        severity: 'medium',
      },
      {
        timestamp: t0 + 2 * 60 * 60 * 1000,
        lane: 'protest',
        label: 'Crowds join Paris protest after police clash',
        severity: 'medium',
      },
      {
        timestamp: t0 + 4 * 60 * 60 * 1000,
        lane: 'protest',
        label: 'Thousands join the Paris protest after a police clash',
        severity: 'high',
      },
    ];
    const structured: CountryTimelineIncident = {
      timestamp: t0 + 30 * 60 * 1000,
      lane: 'protest',
      label: 'Paris protest after police clash',
      severity: 'high',
    };
    const unrelated: CountryTimelineIncident = {
      timestamp: t0 + 60 * 60 * 1000,
      lane: 'military',
      label: 'France deploys military units after security alert',
      severity: 'high',
    };

    expect(reconcileCountryTimelineIncidents([...articles, unrelated], [structured])).toEqual([
      structured,
      unrelated,
    ]);
  });

  it('routes desktop country feeds through the local RSS proxy', async () => {
    runtimeMocks.isDesktopRuntime.mockReturnValue(true);
    rssMocks.fetchFeed.mockResolvedValue([]);

    await fetchCountryCoverage('France');

    expect(rssMocks.fetchFeed).toHaveBeenCalledTimes(2);
    for (const [feed] of rssMocks.fetchFeed.mock.calls) {
      const proxyUrl = new URL(feed.url, 'https://desktop.local');
      expect(proxyUrl.pathname).toBe('/api/rss-proxy');
      expect(new URL(proxyUrl.searchParams.get('url') ?? '').hostname).toBe('news.google.com');
    }
  });
});
