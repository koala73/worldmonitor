/**
 * i18n bootstrap for the DOM-behavioral gate tests (#5634).
 *
 * i18next is a module singleton that the app initialises in `initI18n()`.
 * Nothing initialises it under test, and an uninitialised i18next returns
 * `undefined` from `t()` — so every locked-state assertion comparing one
 * reason's copy to another would trivially hold with both sides `undefined`.
 * That is a whole-suite false pass, so `initTestI18n()` loads the REAL
 * production dictionary and then asserts a probe key actually resolved.
 */

import i18next from 'i18next';

import en from '@/locales/en.json';

/**
 * Initialise the i18next singleton with the real English dictionary.
 *
 * Deliberately NOT `initI18n()` from `@/services/i18n`: that path runs
 * navigator language detection, localStorage migration and an async
 * `import.meta.glob` preload whose timing would make copy assertions racy.
 * The dictionary here is the same file that preload ends up merging, so the
 * strings under test are the ones users see.
 */
export async function initTestI18n(): Promise<void> {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: en as Record<string, unknown> } },
      interpolation: { escapeValue: false },
    });
  }

  // Fail loudly rather than let the suite pass on `undefined` copy.
  const probe = i18next.t('components.exportGate.upgradeCta');
  if (typeof probe !== 'string' || probe.length === 0) {
    throw new Error(`[dom-harness] i18n did not initialise — t() returned ${String(probe)}`);
  }
}

/** Translate through the same singleton the components use. */
export function tt(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}
