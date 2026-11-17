import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';

import en from '@/locales/en.json';

vi.mock('@/config/commands', () => ({
  getAllCommands: () => [
    { id: 'view:strait-watch', category: 'view', label: 'Strait watch', keywords: ['strait watch'], icon: '' },
  ],
}));
vi.mock('@/services/analytics', () => ({ trackSearchUsed: vi.fn() }));
vi.mock('@/utils/focus-trap', () => ({
  createFocusTrap: () => ({ activate: vi.fn(), deactivate: vi.fn() }),
}));
vi.mock('@/utils/overlay-history', () => ({
  overlayHistory: { open: vi.fn(), replace: vi.fn(), close: vi.fn() },
}));

import { SearchModal, type SearchResult } from '@/components/SearchModal';
import { sentAlertSearchItems } from '@/app/search-alert-source';

const SEARCH_DEBOUNCE_MS = 180;
const ALERT_TITLE = 'Iran closes Hormuz strait to tankers';

let modal: SearchModal | null = null;

beforeAll(async () => {
  const resources = { en: { translation: en as Record<string, unknown> } };
  if (!i18next.isInitialized) {
    await i18next.init({ lng: 'en', fallbackLng: 'en', resources, interpolation: { escapeValue: false } });
  } else {
    i18next.addResourceBundle('en', 'translation', resources.en.translation, true, true);
    await i18next.changeLanguage('en');
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.body.replaceChildren();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
});

afterEach(async () => {
  modal?.close('replacement');
  await vi.runAllTimersAsync();
  modal = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function alertItems() {
  return sentAlertSearchItems([
    {
      title: ALERT_TITLE,
      source: 'Reuters',
      link: 'https://www.reuters.com/world/hormuz',
      sentAt: 1_763_370_000_000,
    },
  ], (alert) => `${alert.source} · Sent 17 Nov, 09:00`);
}

async function search(query: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('.search-input')!;
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
}

/** The rendered list as [kind, text] rows, in document order. */
function rows(): Array<[string, string]> {
  return [...document.querySelectorAll<HTMLElement>('.search-results > *')].map((el) => (
    el.classList.contains('search-section-header')
      ? ['header', el.textContent?.trim() ?? '']
      : [el.dataset.index ?? '', el.querySelector('.search-result-title')?.textContent?.trim() ?? '']
  ));
}

describe('SearchModal: alerts sent to you', () => {
  it('lists an alerted headline that the loaded news does not contain, in its own section', async () => {
    modal = new SearchModal(document.body, { placeholder: 'Search' });
    modal.registerSource('news', [{ id: 'n1', title: 'A loaded headline about tankers', subtitle: 'AP', data: {} }]);
    modal.registerSource('alert', alertItems());
    modal.open();

    await search(ALERT_TITLE);

    expect(rows()).toEqual([
      ['header', 'Alerts sent to you'],
      ['0', ALERT_TITLE],
    ]);
    const row = document.querySelector<HTMLElement>('.search-result-item')!;
    expect(row.querySelector('.search-result-subtitle')?.textContent).toBe('Reuters · Sent 17 Nov, 09:00 · reuters.com');
    expect(row.querySelector('.search-result-type')?.textContent).toBe('Alert');
    // The phone stylesheet keeps the second line only for rows with this class.
    expect(row.classList.contains('search-result-alert')).toBe(true);
  });

  it('keeps commands, alerts and other results in separate sections with continuous option indexes', async () => {
    modal = new SearchModal(document.body, { placeholder: 'Search' });
    modal.setCommandVisibleFn(() => true);
    modal.registerSource('news', [{ id: 'n1', title: 'Strait traffic resumes', subtitle: 'AP', data: {} }]);
    modal.registerSource('alert', alertItems());
    modal.open();

    await search('strait');

    expect(rows()).toEqual([
      ['header', 'Commands'],
      ['0', 'Strait watch'],
      ['header', 'Alerts sent to you'],
      ['1', ALERT_TITLE],
      ['header', 'Results'],
      ['2', 'Strait traffic resumes'],
    ]);
    // Headers are not options: the listbox exposes exactly the three rows.
    expect(document.querySelectorAll('.search-results [role="option"]').length).toBe(3);
    expect(document.querySelector('[data-search-section="alerts"]')?.getAttribute('role')).toBe('presentation');
  });

  it('shows no alert section when no alert matches', async () => {
    modal = new SearchModal(document.body, { placeholder: 'Search' });
    modal.registerSource('news', [{ id: 'n1', title: 'Quiet day for shipping', subtitle: 'AP', data: {} }]);
    modal.registerSource('alert', alertItems());
    modal.open();

    await search('quiet day');

    expect(rows()).toEqual([['0', 'Quiet day for shipping']]);
  });

  it('hands the selected alert to the selection handler with its link', async () => {
    const selected: SearchResult[] = [];
    modal = new SearchModal(document.body, { placeholder: 'Search' });
    modal.setOnSelect((result) => { selected.push(result); });
    modal.registerSource('alert', alertItems());
    modal.open();
    await search(ALERT_TITLE);

    document.querySelector<HTMLElement>('.search-result-item')!.click();

    expect(selected).toHaveLength(1);
    expect(selected[0]!.type).toBe('alert');
    expect((selected[0]!.data as { link: string }).link).toBe('https://www.reuters.com/world/hormuz');
  });

  it('tells its sources each time it opens, and shows alerts that arrive while it is open', async () => {
    const onOpen = vi.fn();
    modal = new SearchModal(document.body, { placeholder: 'Search' });
    modal.setOnOpen(onOpen);
    modal.open();
    expect(onOpen).toHaveBeenCalledTimes(1);

    await search(ALERT_TITLE);
    expect(document.querySelectorAll('.search-result-item[data-index]').length).toBe(0);

    // The fetch started on open resolves after the user already typed.
    modal.registerSource('alert', alertItems());
    modal.refreshSearch();
    expect(rows()).toEqual([
      ['header', 'Alerts sent to you'],
      ['0', ALERT_TITLE],
    ]);
  });
});
