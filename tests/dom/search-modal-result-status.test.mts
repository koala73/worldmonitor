import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';

import ar from '@/locales/ar.json';
import en from '@/locales/en.json';
import fr from '@/locales/fr.json';

vi.mock('@/config/commands', () => ({ getAllCommands: () => [] }));
vi.mock('@/services/analytics', () => ({ trackSearchUsed: vi.fn() }));
vi.mock('@/utils/focus-trap', () => ({
  createFocusTrap: () => ({ activate: vi.fn(), deactivate: vi.fn() }),
}));
vi.mock('@/utils/overlay-history', () => ({
  overlayHistory: { open: vi.fn(), replace: vi.fn(), close: vi.fn() },
}));

import { SearchModal } from '@/components/SearchModal';

const SEARCH_DEBOUNCE_MS = 180;

let modal: SearchModal | null = null;

beforeAll(async () => {
  const resources = {
    ar: { translation: ar as Record<string, unknown> },
    en: { translation: en as Record<string, unknown> },
    fr: { translation: fr as Record<string, unknown> },
  };

  if (!i18next.isInitialized) {
    await i18next.init({
      lng: 'en',
      fallbackLng: 'en',
      supportedLngs: ['ar', 'en', 'fr'],
      resources,
      interpolation: { escapeValue: false },
    });
  } else {
    for (const [language, bundle] of Object.entries(resources)) {
      i18next.addResourceBundle(language, 'translation', bundle.translation, true, true);
    }
    await i18next.changeLanguage('en');
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.body.replaceChildren();
});

afterEach(async () => {
  modal?.close('replacement');
  await vi.runAllTimersAsync();
  modal = null;
  document.body.replaceChildren();
  await i18next.changeLanguage('en');
  vi.useRealTimers();
});

function openModal(viewport: 'desktop' | 'mobile', titles: string[]): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: viewport === 'mobile' ? 600 : 1200,
  });

  modal = new SearchModal(document.body, { placeholder: 'Search' });
  modal.setOnFlightSearch(vi.fn());
  modal.registerSource('country', titles.map((title, index) => ({
    id: `result-${index}`,
    title,
    data: null,
  })));
  modal.open();
}

async function search(query: string): Promise<string> {
  const input = document.querySelector<HTMLInputElement>('.search-input');
  expect(input).not.toBeNull();
  input!.value = query;
  input!.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

  const status = document.querySelector<HTMLElement>('.search-results-status');
  expect(status).not.toBeNull();
  expect(status?.getAttribute('role')).toBe('status');
  expect(status?.getAttribute('aria-live')).toBe('polite');
  return status?.textContent ?? '';
}

describe('SearchModal result-status announcements', () => {
  it('applies a SearchAction query to an open modal without a keystroke', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
    });

    modal = new SearchModal(document.body, { placeholder: 'Search' });
    modal.registerSource('country', [{
      id: 'suez-canal',
      title: 'Suez Canal',
      data: null,
    }]);
    modal.open();
    modal.applyQuery('Suez Canal');

    expect(document.querySelector<HTMLInputElement>('.search-input')?.value).toBe('Suez Canal');
    expect(document.querySelector<HTMLElement>('.search-results-status')?.textContent)
      .toBe('1 result for suez canal');
  });

  it.each(['desktop', 'mobile'] as const)(
    'replaces a stale ordinary count with the %s live-flight action after debounce',
    async (viewport) => {
      openModal(viewport, ['Alpha target']);

      expect(await search('alpha')).toBe('1 result for alpha');
      expect(await search('flight AB123')).toBe('1 result for flight ab123');
      expect(document.querySelector('[data-flight-trigger="AB123"]')).not.toBeNull();
    },
  );

  it('uses French singular and plural result sentences in the live region', async () => {
    await i18next.changeLanguage('fr');
    openModal('desktop', [
      'Unique beacon',
      'Locale beacon north',
      'Locale beacon south',
    ]);

    expect(await search('unique beacon')).toBe('1 résultat pour unique beacon');
    expect(await search('locale beacon')).toBe('2 résultats pour locale beacon');
  });

  it('uses the Arabic few form for a non-one result count', async () => {
    await i18next.changeLanguage('ar');
    openModal('desktop', [
      'Arabic beacon north',
      'Arabic beacon south',
      'Arabic beacon east',
    ]);

    expect(await search('arabic beacon')).toBe('3 نتائج لـ arabic beacon');
  });
});
