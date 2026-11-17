// Cmd+K finds a headline the dashboard no longer holds: the real SearchModal
// and the real HeadlineHistorySearch provider, with the server answer faked.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';

import en from '@/locales/en.json';

vi.mock('@/config/commands', () => ({ getAllCommands: () => [] }));
vi.mock('@/services/analytics', () => ({ trackSearchUsed: vi.fn() }));
vi.mock('@/utils/focus-trap', () => ({
  createFocusTrap: () => ({ activate: vi.fn(), deactivate: vi.fn() }),
}));
vi.mock('@/utils/overlay-history', () => ({
  overlayHistory: { open: vi.fn(), replace: vi.fn(), close: vi.fn() },
}));

import { SearchModal, type SearchResult } from '@/components/SearchModal';
import { trackSearchUsed } from '@/services/analytics';
import {
  HEADLINE_HISTORY_DEBOUNCE_MS,
  HeadlineHistorySearch,
  type HeadlineHistoryResultData,
} from '@/app/headline-history-search';
import type { HistoryHeadline } from '@/services/headline-history';
import { headlineTitleKey } from '@/shared/headline-title-key';

const SEARCH_DEBOUNCE_MS = 180;
const NOW = Date.UTC(2026, 10, 17, 15, 0, 0);
const HOUR = 3600_000;

const headline = (title: string, link: string, source = 'Reuters World', hoursAgo = 5): HistoryHeadline => ({
  title, link, source, publishedAt: NOW - hoursAgo * HOUR, lastServedAt: NOW - hoursAgo * HOUR,
});

let modal: SearchModal | null = null;
let provider: HeadlineHistorySearch;
let serverAnswers: Map<string, HistoryHeadline[]>;
let requests: string[];
let failNextRequest: boolean;
let selected: SearchResult[];
let loadedNews: string[];
let loadedText: Map<string, string>;

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: en as Record<string, unknown> } },
      interpolation: { escapeValue: false },
    });
  } else {
    i18next.addResourceBundle('en', 'translation', en as Record<string, unknown>, true, true);
    await i18next.changeLanguage('en');
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(trackSearchUsed).mockClear();
  localStorage.clear();
  document.body.replaceChildren();
  serverAnswers = new Map();
  requests = [];
  failNextRequest = false;
  selected = [];
  loadedNews = [];
});

afterEach(async () => {
  modal?.close('replacement');
  await vi.runAllTimersAsync();
  modal = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** Wires the modal to the provider the way SearchManager does. */
function openModal(viewport: 'desktop' | 'mobile' = 'desktop'): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport === 'mobile' ? 600 : 1200 });
  modal = new SearchModal(document.body, { placeholder: 'Search' });
  const current = modal;
  registerLoadedNews();
  provider = new HeadlineHistorySearch({
    fetchHeadlines: async (query) => {
      requests.push(query);
      if (failNextRequest) {
        failNextRequest = false;
        throw new Error('fixture: search did not run');
      }
      return serverAnswers.get(query) ?? [];
    },
    publish: (items, refresh) => {
      current.registerSource('headline', items, { updateVisibleMetrics: false });
      if (refresh) current.refreshResultsInBackground();
    },
    isLoadedMatch: (titleKey, query) => loadedText.get(titleKey)?.includes(query) ?? false,
    // The article-opening policy (isOpenableExternalUrl): https only.
    isOpenable: (link) => link.startsWith('https://'),
    formatAge: (date) => `${Math.round((NOW - date.getTime()) / HOUR)}h ago`,
    setPending: (pending) => current.setResultsPending(pending),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
    now: () => Date.now(),
  });
  current.setOnQueryChange((rawInput) => provider.onQueryChange(rawInput));
  current.setOnSelect((result) => { selected.push(result); });
  current.open();
}

function registerLoadedNews(): void {
  modal!.registerSource('news', loadedNews.map((title, index) => ({
    id: `https://loaded.example/${index}`,
    title,
    subtitle: 'Loaded Source',
    data: { link: `https://loaded.example/${index}` },
  })));
  loadedText = new Map(loadedNews.map((title) => [headlineTitleKey(title), `${title}\nLoaded Source`.toLowerCase()]));
}

/** A dashboard refresh replaced the loaded news, as SearchManager.updateSearchIndex does. */
function replaceLoadedNews(titles: string[]): void {
  loadedNews = titles;
  registerLoadedNews();
  provider.onLoadedNewsChange();
}

function type(query: string): void {
  const input = document.querySelector<HTMLInputElement>('.search-input')!;
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + HEADLINE_HISTORY_DEBOUNCE_MS + 5);
}

async function search(query: string): Promise<void> {
  type(query);
  await settle();
}

function rows(): Array<{ title: string; subtitle: string; type: string }> {
  return [...document.querySelectorAll<HTMLElement>('.search-result-item')].map((row) => ({
    title: row.querySelector('.search-result-title')?.textContent ?? '',
    subtitle: row.querySelector('.search-result-subtitle')?.textContent ?? '',
    type: row.querySelector('.search-result-type')?.textContent ?? '',
  }));
}

const press = (key: string) =>
  document.querySelector<HTMLInputElement>('.search-input')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('Cmd+K headline history', () => {
  it('finds a headline that is not loaded, with its publisher and age', async () => {
    loadedNews = ['Rates held at 4.5%'];
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized by patrol boats', 'https://www.reuters.com/hormuz')]);
    openModal();

    type('hormuz');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(rows()).toEqual([]);
    // Nothing loaded matches, but the server has not answered yet: the list
    // says it is still loading, not that there are no results.
    expect(document.querySelector('.search-empty[data-search-pending]')?.textContent).toContain('Loading...');
    expect(document.querySelector('.search-empty')?.textContent).not.toContain('No results');

    await settle();
    expect(document.querySelector('[data-search-pending]')).toBeNull();
    expect(rows()).toEqual([{
      title: 'Strait of Hormuz tanker seized by patrol boats',
      subtitle: 'Reuters World · 5h ago',
      type: 'News',
    }]);
    expect(document.querySelector('.search-results-status')?.textContent).toBe('1 result for hormuz');
  });

  it('leaves out a headline whose link the dashboard would refuse to open', async () => {
    serverAnswers.set('hormuz', [
      headline('Hormuz tanker seized, state media says', 'http://www.irna.ir/news/1'),
      headline('Strait of Hormuz tanker seized by patrol boats', 'https://www.reuters.com/hormuz'),
    ]);
    openModal();
    await search('hormuz');
    expect(rows().map((row) => row.title)).toEqual(['Strait of Hormuz tanker seized by patrol boats']);
  });

  it('lists a headline from the history once a refresh takes it off the dashboard', async () => {
    loadedNews = ['Iran talks resume in Vienna'];
    serverAnswers.set('iran', [headline('Iran talks resume in Vienna', 'https://www.reuters.com/vienna')]);
    openModal();
    await search('iran');
    expect(rows().map((row) => `${row.title} | ${row.subtitle}`)).toEqual(['Iran talks resume in Vienna | Loaded Source']);

    // The dashboard refreshes while the query is still on screen, and the
    // headline is no longer among the loaded items.
    replaceLoadedNews(['Rates held at 4.5%']);
    modal!.refreshResultsInBackground();
    expect(rows().map((row) => `${row.title} | ${row.subtitle}`)).toEqual(['Iran talks resume in Vienna | Reuters World · 5h ago']);
    expect(requests).toEqual(['iran']);

    // And back: loaded again, the loaded row is the one listed.
    replaceLoadedNews(['Iran talks resume in Vienna']);
    modal!.refreshResultsInBackground();
    expect(rows().map((row) => `${row.title} | ${row.subtitle}`)).toEqual(['Iran talks resume in Vienna | Loaded Source']);
    // No second request.
    expect(requests).toEqual(['iran']);
  });

  it('lists loaded news first and never repeats a title the loaded items already cover', async () => {
    loadedNews = ['Iran talks resume in Vienna'];
    serverAnswers.set('iran', [
      headline('Iran talks resume in Vienna!', 'https://www.reuters.com/vienna'),
      headline('Iran sanctions: EU ministers split', 'https://www.reuters.com/eu', 'BBC World', 30),
    ]);
    openModal();
    await search('iran');
    expect(rows().map((row) => `${row.title} | ${row.subtitle}`)).toEqual([
      'Iran talks resume in Vienna | Loaded Source',
      'Iran sanctions: EU ministers split | BBC World · 30h ago',
    ]);
  });

  it('lists a loaded headline from the server when the loaded row does not match the typed words', async () => {
    // The browser matches the typed text as one phrase; the server matches the
    // words in any order. Dropping the server copy because the title is loaded
    // would leave this headline unfindable from both sides.
    loadedNews = ['Sanctions on Iran widen after talks'];
    serverAnswers.set('iran sanctions', [headline('Sanctions on Iran widen after talks', 'https://www.reuters.com/widen')]);
    openModal();
    await search('iran sanctions');
    expect(rows().map((row) => `${row.title} | ${row.subtitle}`)).toEqual([
      'Sanctions on Iran widen after talks | Reuters World \u00B7 5h ago',
    ]);
  });

  it('keeps a server match whose words are in another order than typed', async () => {
    serverAnswers.set('iran sanctions', [headline('Sanctions on Iran widen after talks', 'https://www.reuters.com/widen')]);
    openModal();
    await search('Iran sanctions');
    expect(rows().map((row) => row.title)).toEqual(['Sanctions on Iran widen after talks']);
  });

  it('asks once per settled query, not per keystroke, and not again when its own results arrive', async () => {
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    openModal();
    for (const partial of ['h', 'ho', 'hor', 'horm', 'hormu', 'hormuz']) {
      type(partial);
      await vi.advanceTimersByTimeAsync(60);
    }
    await settle();
    await settle();
    expect(requests).toEqual(['hormuz']);
    // The arriving results re-render the list; that is not a second search.
    expect(vi.mocked(trackSearchUsed)).toHaveBeenCalledTimes(1);
  });

  it('does not restart a pending request when the same query is searched again', async () => {
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    openModal();
    type('hormuz');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 100);
    // Another source finishing (a live flight lookup) re-runs the same query.
    modal!.refreshSearch();
    await vi.advanceTimersByTimeAsync(HEADLINE_HISTORY_DEBOUNCE_MS - 100 + 5);
    expect(requests).toEqual(['hormuz']);
  });

  it('says there are no results once the server has answered with none, or failed', async () => {
    openModal();
    type('zzzqqq');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(document.querySelector('[data-search-pending]')).not.toBeNull();
    await settle();
    expect(document.querySelector('[data-search-pending]')).toBeNull();
    expect(document.querySelector('.search-empty')?.textContent).toContain('No results');

    failNextRequest = true;
    await search('yyywww');
    expect(document.querySelector('[data-search-pending]')).toBeNull();
    expect(document.querySelector('.search-empty')?.textContent).toContain('No results');
  });

  it('leaves a live flight lookup alone', async () => {
    openModal();
    modal!.setOnFlightSearch(() => {});
    await search('flight ab123');
    expect(requests).toEqual([]);
    expect(document.querySelector('[data-search-pending]')).toBeNull();
    expect(document.querySelector('[data-flight-trigger="AB123"]')).not.toBeNull();
  });

  it('does not ask for a query too short to be worth a week of headlines', async () => {
    openModal();
    await search('ho');
    expect(requests).toEqual([]);
  });

  it('drops results for a query the user has left, and reuses an answer when they return', async () => {
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    serverAnswers.set('quake', [headline('Quake shakes northern Chile', 'https://www.reuters.com/quake')]);
    openModal();
    await search('hormuz');
    await search('quake');
    expect(rows().map((row) => row.title)).toEqual(['Quake shakes northern Chile']);
    await search('hormuz');
    expect(rows().map((row) => row.title)).toEqual(['Strait of Hormuz tanker seized']);
    expect(requests).toEqual(['hormuz', 'quake']);
  });

  it('ignores an answer that arrives after the query changed', async () => {
    let release: (value: HistoryHeadline[]) => void = () => {};
    serverAnswers.set('quake', [headline('Quake shakes northern Chile', 'https://www.reuters.com/quake')]);
    openModal();
    provider = new HeadlineHistorySearch({
      fetchHeadlines: (query) => {
        requests.push(query);
        if (query === 'hormuz') return new Promise((resolve) => { release = resolve; });
        return Promise.resolve(serverAnswers.get(query) ?? []);
      },
      publish: (items, refresh) => {
        modal!.registerSource('headline', items, { updateVisibleMetrics: false });
        if (refresh) modal!.refreshResultsInBackground();
      },
      isLoadedMatch: () => false,
      isOpenable: () => true,
      formatAge: () => '5h ago',
      setPending: (pending) => modal!.setResultsPending(pending),
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
      now: () => Date.now(),
    });
    await search('hormuz');
    await search('quake');
    release([headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    await settle();
    expect(rows().map((row) => row.title)).toEqual(['Quake shakes northern Chile']);
  });

  it('keeps the loaded results when the server search fails, and retries on the next keystroke', async () => {
    loadedNews = ['Hormuz shipping insurance rises'];
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    failNextRequest = true;
    openModal();
    await search('hormuz');
    expect(rows().map((row) => row.title)).toEqual(['Hormuz shipping insurance rises']);
    await search('hormuz ');
    await search('hormuz');
    expect(requests).toEqual(['hormuz', 'hormuz']);
    expect(rows().map((row) => row.title)).toEqual(['Hormuz shipping insurance rises', 'Strait of Hormuz tanker seized']);
  });

  it('keeps the highlighted row highlighted when history results arrive under it', async () => {
    loadedNews = ['Hormuz shipping insurance rises'];
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    openModal();
    modal!.registerSource('prediction', [{ id: 'p1', title: 'Hormuz closed by June?', subtitle: '12% probability', data: null }]);
    type('hormuz');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    press('ArrowDown');
    expect(document.querySelector('.search-result-item.selected .search-result-title')?.textContent).toBe('Hormuz closed by June?');
    await settle();
    expect(rows().map((row) => row.title)).toEqual([
      'Hormuz shipping insurance rises',
      'Strait of Hormuz tanker seized',
      'Hormuz closed by June?',
    ]);
    expect(document.querySelector('.search-result-item.selected .search-result-title')?.textContent).toBe('Hormuz closed by June?');
  });

  it('hands the article link to the selection handler', async () => {
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    openModal();
    await search('hormuz');
    press('Enter');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.type).toBe('headline');
    expect((selected[0]!.data as HeadlineHistoryResultData).link).toBe('https://www.reuters.com/hormuz');
  });

  it('never lists a link that is not a web address', async () => {
    serverAnswers.set('hormuz', [
      headline('Hormuz script link', 'javascript:alert(1)'),
      headline('Hormuz real link', 'https://www.reuters.com/real'),
    ]);
    openModal();
    await search('hormuz');
    expect(rows().map((row) => row.title)).toEqual(['Hormuz real link']);
  });

  it('empties its source when the modal closes, so nothing fetched for one query outlives it', async () => {
    serverAnswers.set('hormuz', [headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/hormuz')]);
    openModal();
    await search('hormuz');
    expect(modal!.search('hormuz').entityMatches).toHaveLength(1);
    modal!.close();
    await vi.runAllTimersAsync();
    expect(modal!.search('hormuz').entityMatches).toHaveLength(0);
  });

  it('shows history headlines inside the five results a phone gets', async () => {
    loadedNews = ['Hormuz shipping insurance rises'];
    serverAnswers.set('hormuz', [
      headline('Strait of Hormuz tanker seized', 'https://www.reuters.com/1'),
      headline('Hormuz patrols doubled', 'https://www.reuters.com/2'),
      headline('Hormuz transit fees proposed', 'https://www.reuters.com/3'),
    ]);
    openModal('mobile');
    modal!.registerSource('country', Array.from({ length: 4 }, (_, index) => ({ id: `c${index}`, title: `Hormuz state ${index}`, data: null })));
    await search('hormuz');
    expect(rows().map((row) => row.title).slice(0, 3)).toEqual([
      'Hormuz shipping insurance rises',
      'Strait of Hormuz tanker seized',
      'Hormuz patrols doubled',
    ]);
    expect(rows()).toHaveLength(5);
    // The phone sheet hides subtitles; history headlines carry the class that keeps theirs.
    const marked = [...document.querySelectorAll('.search-result-item.search-result-headline .search-result-title')]
      .map((title) => title.textContent);
    expect(marked).toEqual(['Strait of Hormuz tanker seized', 'Hormuz patrols doubled']);
  });
});
