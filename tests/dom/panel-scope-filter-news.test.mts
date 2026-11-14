/**
 * Dashboard focus (#10453), live news: a regional NewsPanel shows the focused
 * countries first, then neighbours marked "Neighbour: …", counts what the
 * focus hides and what has no country, and re-renders from memory when the
 * focus changes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { NewsPanel } from '@/components/NewsPanel';
import { clusterNews } from '@/services/clustering';
import type { ResolvedScope } from '@/services/tab-focus';
import type { NewsItem } from '@/types';
import { resolveScope } from '../../shared/tab-scope-resolve';

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
const FOCUS = scopeOf(['TH', 'VN', 'ID']);

let at = Date.parse('2026-11-11T12:00:00.000Z');
function news(title: string): NewsItem {
  at -= 60_000;
  return {
    source: 'Reuters',
    title,
    link: `https://example.com/${encodeURIComponent(title)}`,
    pubDate: new Date(at),
    isAlert: false,
  } as NewsItem;
}

// Newest first, so "newest" and source order agree: US, LA, TH, none, VN.
const US = news('US Senate passes the budget bill');
const LAOS = news('Laos closes a border crossing after floods');
const THAILAND = news('Thailand imposes a curfew in three provinces');
const NONE = news('Global markets rally on rate cut hopes');
const VIETNAM = news('Vietnam detains a prominent blogger');
const ITEMS = [US, LAOS, THAILAND, NONE, VIETNAM];

let fetchSpy: ReturnType<typeof vi.fn>;
let panel: NewsPanel;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem('wm_sort_full_politics', 'newest');
  fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  panel?.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

/** A news panel whose clustering fails, so the flat list stays (the documented fallback). */
function mountFlat(key = 'politics'): NewsPanel {
  panel = new NewsPanel(key, 'World News', undefined, {
    clusterNews: () => Promise.reject(new Error('flat list only')),
  });
  document.body.appendChild(panel.getElement());
  return panel;
}

async function settle(): Promise<void> {
  await vi.runAllTimersAsync();
}

const el = () => panel.getElement();
const titles = () => [...el().querySelectorAll('.item .item-title')].map((n) => n.textContent);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (title: string) => [...el().querySelectorAll('.item')].find((n) => n.querySelector('.item-title')?.textContent === title);

describe('NewsPanel under a focus', () => {
  it('retains the location country when a long title fills the attribution budget', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item = { ...news('France announces talks '.padEnd(1100, 'x')), locationName: 'Thailand' } as NewsItem;
    panel.renderNews([item]);
    panel.applyScope(scopeOf(['TH'], false));
    await settle();
    expect(titles()).toEqual([item.title]);
    expect(el().querySelector('.panel-scope-empty')).toBeNull();
  });

  it('lists chosen countries first, then the neighbour marked, and counts the rest', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel.renderNews(ITEMS);
    panel.applyScope(FOCUS);
    await settle();

    expect(titles()).toEqual([THAILAND.title, VIETNAM.title, LAOS.title]);
    expect(rowFor(LAOS.title)?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(rowFor(THAILAND.title)?.querySelector('.panel-scope-tag')).toBeNull();

    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('Showing Thailand, Vietnam, Indonesia + neighbours');
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    expect(stripButton('show-all')?.getAttribute('aria-label')).toBe('Show everything in this panel, including 1 item outside the focus');
    expect(stripButton('show-unattributed')?.getAttribute('aria-label')).toBe('Show the 1 item with no country');
  });

  it('keeps two articles with the same link and title but different sources apart', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = { ...news('Border crossing reopens after talks'), source: 'Reuters', locationName: 'Thailand' } as NewsItem;
    const b = { ...a, source: 'Reuters Asia', locationName: 'Laos' } as NewsItem;
    panel.renderNews([a, b]);
    panel.applyScope(FOCUS);
    await settle();
    const tags = [...panel.getElement().querySelectorAll('.item')].map((row) => row.querySelector('.panel-scope-tag-neighbour')?.textContent ?? '');
    expect(tags.sort()).toEqual(['', 'Neighbour: Laos']);
  });

  it('newest-first ranks an article without a real date as old, not fresh', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dated = news('Thailand imposes a curfew');
    const undated = { ...news('Thailand lifts a curfew'), pubDate: new Date(Date.parse('2026-11-12T00:00:00Z')), pubDateMissing: true } as NewsItem;
    panel.renderNews([undated, dated]);
    panel.applyScope(scopeOf(['TH']));
    await settle();
    expect(titles()).toEqual([dated.title, undated.title]);
  });

  it('keeps the order and the marker in the clustered view', async () => {
    panel = new NewsPanel('politics', 'World News', undefined, { clusterNews: async (items) => clusterNews(items) });
    document.body.appendChild(panel.getElement());
    panel.applyScope(FOCUS);
    panel.renderNews(ITEMS);
    await settle();

    expect(el().querySelectorAll('.item.clustered')).toHaveLength(3);
    expect(titles()).toEqual([THAILAND.title, VIETNAM.title, LAOS.title]);
    expect(rowFor(LAOS.title)?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
  });

  it('shows the items with no country on request, marked, and hides them again', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel.renderNews(ITEMS);
    panel.applyScope(FOCUS);
    await settle();

    stripButton('show-unattributed')?.click();
    await settle();
    expect(titles()).toEqual([THAILAND.title, VIETNAM.title, LAOS.title, NONE.title]);
    expect(rowFor(NONE.title)?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');
    expect(stripButton('hide-unattributed')).toBeTruthy();

    stripButton('hide-unattributed')?.click();
    await settle();
    expect(titles()).toEqual([THAILAND.title, VIETNAM.title, LAOS.title]);
  });

  it('"Show all" lifts the focus for this panel only, and a new focus resets it', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel.renderNews(ITEMS);
    panel.applyScope(FOCUS);
    await settle();

    stripButton('show-all')?.click();
    await settle();
    expect(titles()).toEqual(ITEMS.map((i) => i.title));
    expect(el().querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.textContent).toContain('Focus off in this panel');
    expect(stripButton('apply')).toBeTruthy();

    // Another panel with the same focus is unaffected.
    const other = new NewsPanel('asia', 'Asia-Pacific', undefined, { clusterNews: () => Promise.reject(new Error('flat')) });
    document.body.appendChild(other.getElement());
    other.renderNews(ITEMS);
    other.applyScope(FOCUS);
    await settle();
    expect(other.getElement().querySelectorAll('.item')).toHaveLength(3);
    other.destroy();

    panel.applyScope(scopeOf(['TH']));
    await settle();
    expect(strip()?.textContent).toContain('Showing Thailand + neighbours');
    expect(titles()).toEqual([THAILAND.title, LAOS.title]);
  });

  it('applying then clearing the focus restores the full list without a fetch, and re-applying is stable', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel.renderNews(ITEMS);
    await settle();
    expect(titles()).toEqual(ITEMS.map((i) => i.title));

    panel.applyScope(FOCUS);
    panel.applyScope(FOCUS);
    await settle();
    expect(titles()).toEqual([THAILAND.title, VIETNAM.title, LAOS.title]);
    panel.applyScope({ ...FOCUS, scope: { ...FOCUS.scope, countries: [...FOCUS.scope.countries] } });
    await settle();
    expect(titles()).toEqual([THAILAND.title, VIETNAM.title, LAOS.title]);

    panel.applyScope(null);
    await settle();
    expect(titles()).toEqual(ITEMS.map((i) => i.title));
    expect(strip()?.hidden).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with neighbours off, the neighbour item is hidden and counted', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel.renderNews(ITEMS);
    panel.applyScope(scopeOf(['TH', 'VN', 'ID'], false));
    await settle();
    expect(titles()).toEqual([THAILAND.title, VIETNAM.title]);
    expect(strip()?.textContent).toContain('Showing Thailand, Vietnam, Indonesia');
    expect(strip()?.textContent).not.toContain('+ neighbours');
    expect(strip()?.textContent).toContain('2 hidden by focus');
  });

  it('an empty focused result is distinct from a load failure and from stale data', async () => {
    mountFlat();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel.applyScope(FOCUS);
    panel.renderNews([US, NONE]);
    await settle();

    const empty = el().querySelector('.panel-scope-empty');
    expect(empty?.textContent).toContain('Nothing for these countries in the current headlines');
    expect(el().querySelector('.panel-error-state')).toBeNull();
    expect(el().querySelector('.panel-header')?.classList.contains('panel-header-error')).toBe(false);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(stripButton('show-all')).toBeTruthy();
    expect(el().querySelector('.panel-data-badge')?.className).toContain('live');

    // Stale: the same empty state, with the header saying the data is cached.
    panel.setRefreshDegraded(true);
    expect(el().querySelector('.panel-data-badge')?.className).toContain('cached');
    expect(el().querySelector('.panel-scope-empty')).not.toBeNull();

    // Failure: the panel's error state, no focus counts.
    panel.showError('Feed failed');
    expect(el().querySelector('.panel-scope-empty')).toBeNull();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Feed failed');
    expect(el().querySelector('.panel-header')?.classList.contains('panel-header-error')).toBe(true);
    expect(strip()?.hidden).toBe(true);

    // A later focus change does not paint old headlines over the error.
    panel.applyScope(scopeOf(['US']));
    await settle();
    expect(el().querySelector('.panel-error-state')).not.toBeNull();
  });

  it('a news panel the registry keeps global ignores the focus', async () => {
    mountFlat('startups');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel.renderNews(ITEMS);
    panel.applyScope(FOCUS);
    await settle();
    expect(titles()).toEqual(ITEMS.map((i) => i.title));
    expect(strip()?.hidden).toBe(true);
  });
});
