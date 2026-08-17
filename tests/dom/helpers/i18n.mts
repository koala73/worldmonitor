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
import zhHans from '@/locales/zh.json';
import zhHant from '@/locales/zh-TW.json';

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

/**
 * Point the singleton at one of the two Chinese catalogues, switchable.
 *
 * Separate from `initTestI18n()` because the zh-TW behavioural tests are all
 * COMPARISONS between the two scripts — asserting one in isolation cannot tell
 * a working fix from a hardcoded string. Both dictionaries are registered up
 * front so the switch is synchronous from the caller's point of view.
 *
 * Verifies the language actually took, and that its dictionary resolved: a tag
 * silently collapsing `zh-TW` to `zh` is the exact bug class these tests exist
 * to catch, so it must not be able to hide inside the harness.
 */
export async function useChineseCatalogue(lng: 'zh' | 'zh-TW'): Promise<void> {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng,
      fallbackLng: 'en',
      supportedLngs: ['zh', 'zh-TW', 'en'],
      resources: {
        zh: { translation: zhHans as Record<string, unknown> },
        'zh-TW': { translation: zhHant as Record<string, unknown> },
      },
      interpolation: { escapeValue: false },
    });
  } else {
    await i18next.changeLanguage(lng);
  }

  if (i18next.language !== lng) {
    throw new Error(`[dom-harness] asked for ${lng}, i18next reports ${i18next.language}`);
  }

  const probe = i18next.t('preferences.display');
  if (typeof probe !== 'string' || probe.length === 0 || probe === 'preferences.display') {
    throw new Error(`[dom-harness] ${lng} dictionary did not load — t() returned ${String(probe)}`);
  }
}
