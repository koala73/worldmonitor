/**
 * #6419 step 3: one claim renders one publisher roster on every surface that
 * lists publishers (NewsPanel cluster rows, Country Deep Dive rows, Insights
 * server stories and breaking clusters), and the older per-surface source lists are gone.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { InsightsPanel } from '@/components/InsightsPanel';
import { NewsPanel } from '@/components/NewsPanel';
import { clusterNews } from '@/services/clustering';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import type { ServerInsightStory } from '@/services/insights-loader';
import type { NewsItem } from '@/types';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const UNDECLARED = 'Synthetic Unmapped Outlet 6419';
const TITLE = 'Port strike halts container traffic in Rotterdam';
const LABELS = ['Reuters World', 'Reuters US', 'BBC World', 'Fars News', 'The Verge', UNDECLARED];

function newsItem(source: string, title = TITLE, extra: Partial<NewsItem> = {}): NewsItem {
  return {
    ...extra,
    source,
    title,
    link: `https://example.com/${encodeURIComponent(source + title)}`,
    pubDate: new Date('2026-09-24T00:00:00.000Z'),
    isAlert: false,
  } as NewsItem;
}

type RosterView = {
  summary: string;
  rows: Array<{ name: string; chip: string; chipTitle: string | null; feeds: string | null; risk: string | null }>;
  legend: string;
  href: string | null;
};

function readRoster(root: Element): RosterView | null {
  const roster = root.querySelectorAll('.publisher-roster');
  if (roster.length === 0) return null;
  expect(roster).toHaveLength(1);
  const el = roster[0]!;
  expect(el.tagName).toBe('DETAILS');
  return {
    summary: el.querySelector('summary')?.textContent?.trim() ?? '',
    rows: [...el.querySelectorAll('li')].map((li) => ({
      name: li.querySelector('.publisher-name')?.textContent ?? '',
      chip: li.querySelector('.tier-chip')?.textContent ?? '',
      chipTitle: li.querySelector('.tier-chip')?.getAttribute('title') ?? null,
      feeds: li.querySelector('.publisher-feeds')?.textContent ?? null,
      risk: li.querySelector('.propaganda-badge, .provenance-fact-marker')?.textContent ?? null,
    })),
    legend: el.querySelector('.tier-legend')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    href: el.querySelector('.tier-legend a')?.getAttribute('href') ?? null,
  };
}

function newsPanelRow(labels: string[], extra: Partial<NewsItem> = {}): Element {
  vi.useFakeTimers();
  const panel = new NewsPanel('roster-test', 'Roster');
  document.body.appendChild(panel.getElement());
  (panel as unknown as { renderClusters(clusters: unknown[]): void })
    .renderClusters(clusterNews(labels.map((source) => newsItem(source, TITLE, extra))));
  vi.runAllTimers();
  const rows = panel.getElement().querySelectorAll('.item.clustered');
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function deepDiveRow(labels: string[]): Element {
  const panel = new CountryDeepDivePanel(null);
  const body = document.createElement('div');
  document.body.appendChild(body);
  (panel as unknown as { newsBody: HTMLElement }).newsBody = body;
  panel.updateNews(labels.map((source) => newsItem(source)));
  expect(body.querySelectorAll('.cdp-news-item')).toHaveLength(1);
  return body;
}

function insightsStory(labels: string[], extra: Partial<ServerInsightStory> = {}): Element {
  const renderer = Object.create(InsightsPanel.prototype) as {
    renderServerStories(stories: ServerInsightStory[], sentiments: null): string;
  };
  const host = document.createElement('div');
  host.innerHTML = renderer.renderServerStories([{
    primaryTitle: TITLE,
    primarySource: labels[0]!,
    primaryLink: 'https://example.com/story',
    pubDate: '2026-09-24T00:00:00.000Z',
    sourceCount: labels.length,
    uniqueSourceCount: 5,
    importanceScore: 50,
    velocity: { level: 'normal', sourcesPerHour: 0 },
    isAlert: false,
    category: 'general',
    threatLevel: 'low',
    sources: labels,
    ...extra,
  } as ServerInsightStory], null);
  return host;
}

function insightsBreaking(labels: string[], extra: Partial<NewsItem> = {}): Element {
  const renderer = Object.create(InsightsPanel.prototype) as {
    renderBreakingStories(items: Array<{ cluster: unknown; isq: { tier: string } }>, sentiments: null): string;
  };
  const clusters = clusterNews(labels.map((source) => newsItem(source, TITLE, extra)));
  expect(clusters).toHaveLength(1);
  const host = document.createElement('div');
  host.innerHTML = renderer.renderBreakingStories([{ cluster: clusters[0], isq: { tier: 'weak' } }], null);
  return host;
}

const EXPECTED: RosterView = {
  summary: 'Reported by 5 publishers, including 1 tier-1',
  rows: [
    { name: 'Reuters', chip: 'T1', chipTitle: 'Tier 1: Wire services and official bodies', feeds: 'Feeds seen: Reuters World (T1), Reuters US (T1)', risk: '?' },
    { name: 'BBC', chip: 'T2', chipTitle: 'Tier 2: Major outlets', feeds: 'Feeds seen: BBC World (T2)', risk: null },
    { name: 'Fars News', chip: 'T3', chipTitle: 'Tier 3: Specialist, regional and think-tank sources', feeds: 'Feeds seen: Fars News (T3)', risk: '?' },
    { name: 'The Verge', chip: 'T4', chipTitle: 'Tier 4: Aggregators and blogs', feeds: 'Feeds seen: The Verge (T4)', risk: '?' },
    { name: UNDECLARED, chip: 'T?', chipTitle: 'Tier not declared: not yet reviewed', feeds: `Feeds seen: ${UNDECLARED} (T?)`, risk: '?' },
  ],
  legend: 'Tiers rank sources; they do not judge this claim. How tiers are assigned',
  href: 'https://worldmonitor.app/docs/data-sources#source-credibility-%26-feed-tiering',
};

describe('publisher roster renders identically on every surface (#6419 step 3)', () => {
  it('NewsPanel cluster, Country Deep Dive and Insights show the same roster for one claim', () => {
    const surfaces = {
      newsPanel: readRoster(newsPanelRow(LABELS)),
      deepDive: readRoster(deepDiveRow(LABELS)),
      insights: readRoster(insightsStory(LABELS)),
      insightsBreaking: readRoster(insightsBreaking(LABELS)),
    };
    expect(surfaces).toEqual({ newsPanel: EXPECTED, deepDive: EXPECTED, insights: EXPECTED, insightsBreaking: EXPECTED });
  });

  it('says how many publishers were listed when the digest counted more', () => {
    const roster = readRoster(insightsStory(LABELS, { corroborationCount: 7 }));
    expect(roster?.summary).toBe('Reported by 7 publishers, including 1 tier-1 (5 listed)');
    expect(roster?.rows).toHaveLength(5);
  });

  it('the source-count badge and the roster summary show the same publisher count', () => {
    const count = (el: Element | null | undefined) => Number(el?.textContent?.match(/\d+/)?.[0]);
    const story = insightsStory(LABELS, { corroborationCount: 7 });
    expect(count(story.querySelector('.insight-badge.confirmed'))).toBe(7);
    expect(count(story.querySelector('.publisher-roster summary'))).toBe(7);

    const cluster = newsPanelRow(LABELS, { corroborationCount: 7 });
    expect(count(cluster.querySelector('.source-count'))).toBe(7);
    expect(count(cluster.querySelector('.publisher-roster summary'))).toBe(7);

    const breaking = insightsBreaking(LABELS, { corroborationCount: 7 });
    expect(count(breaking.querySelector('.insight-badge.confirmed'))).toBe(7);
    expect(count(breaking.querySelector('.publisher-roster summary'))).toBe(7);
  });

  it('marks a publisher with the most severe risk among its feeds, whatever order they arrive in', () => {
    const riskOf = (labels: string[]) =>
      readRoster(insightsStory(labels))?.rows.find((row) => row.name === 'Deutsche Welle')?.risk;
    expect(riskOf(['DW Turkish', 'Reuters World'])).toBe('?');
    expect(riskOf(['DW News', 'Reuters World'])).toBe('!');
    expect(riskOf(['DW Turkish', 'DW News', 'Reuters World'])).toBe('!');
    expect(riskOf(['DW News', 'DW Turkish', 'Reuters World'])).toBe('!');
  });

  it('links the tier docs absolutely, so the desktop app and a saved report reach the web docs', () => {
    const href = readRoster(insightsStory(LABELS))?.href;
    const url = new URL(href!);
    expect(url.origin).toBe(WEB_APP_ORIGIN);
    expect(url.pathname).toBe('/docs/data-sources');
    expect(url.hash).toBe('#source-credibility-%26-feed-tiering');
  });

  it('keeps the roster on headlines frozen into the Deep Dive story', async () => {
    const panel = new CountryDeepDivePanel(null);
    const internals = panel as unknown as {
      newsBody: HTMLElement;
      content: HTMLElement;
      panel: HTMLElement;
      currentCode: string;
      currentName: string;
      sections: unknown[];
      openOutput(kind: 'story' | 'report', trigger: HTMLButtonElement): Promise<void>;
    };
    internals.newsBody = document.createElement('div');
    panel.updateNews(LABELS.map((source) => newsItem(source)));
    internals.currentCode = 'NL';
    internals.currentName = 'Netherlands';
    internals.sections = [];
    internals.panel.classList.add('active');
    internals.content.replaceChildren(Object.assign(document.createElement('div'), { className: 'cdp-shell' }));
    await internals.openOutput('story', document.createElement('button'));
    internals.content.querySelector<HTMLButtonElement>('button[aria-label="Previous story slide"]')!.click();

    const slide = internals.content.querySelector('.cdp-output-story-slide')!;
    expect(slide.querySelector('h2')?.textContent).toBe('Top country headlines');
    expect(slide.querySelectorAll('.cdp-news-item')).toHaveLength(1);
    expect(readRoster(slide)?.summary).toBe(EXPECTED.summary);
  });

  it('shows each publisher\'s feeds as text in its row, escaped, not only on hover', () => {
    const hostile = '<img src=x onerror=alert(1)> Desk';
    const host = insightsStory(['Reuters World', hostile]);
    const rows = [...host.querySelectorAll('.publisher-roster li')];
    expect(rows.every((li) => !li.hasAttribute('title'))).toBe(true);
    expect(host.querySelector('img')).toBeNull();
    expect(rows.map((li) => li.querySelector('.publisher-feeds')?.textContent)).toContain(`Feeds seen: ${hostile} (T?)`);
  });

  it('summarizes a tier-4-only claim without a tier-1 clause', () => {
    const roster = readRoster(insightsStory(['The Verge', 'Hacker News'], { uniqueSourceCount: 2 }));
    expect(roster?.summary).toBe('Reported by 2 publishers');
    expect(roster?.rows.map((row) => row.chip)).toEqual(['T4', 'T4']);
  });

  it('omits the roster where the pill already names the only publisher', () => {
    const oneNewsroom = ['Reuters World', 'Reuters US'];
    expect(readRoster(newsPanelRow(oneNewsroom))).toBeNull();
    document.body.innerHTML = '';
    expect(readRoster(deepDiveRow(oneNewsroom))).toBeNull();
    expect(readRoster(insightsStory(oneNewsroom, { uniqueSourceCount: 1 }))).toBeNull();
    expect(readRoster(insightsBreaking(oneNewsroom))).toBeNull();
  });

  it('replaces the NewsPanel "Also:" chips and the Deep Dive "+N sources" tooltip', () => {
    const row = newsPanelRow(LABELS);
    expect(row.querySelector('.also-reported')).toBeNull();
    expect(row.querySelector('.top-source')).toBeNull();
    expect(row.textContent).not.toContain('Also:');

    const body = deepDiveRow(LABELS);
    const meta = body.querySelector('.cdp-news-meta')!;
    expect(meta.getAttribute('title')).toBeNull();
    expect(meta.textContent).not.toMatch(/\+\d+ sources?/);
    expect(body.querySelector('.cdp-news-item .publisher-roster')).toBeNull();
  });
});
