import { isDesktopRuntime } from '@/services/desktop-runtime';

/**
 * Every variant a user can switch to. One desktop binary ships and switches
 * between all of these in-app (#5908), so this list is also the set
 * `/api/download` accepts — `tests/desktop-one-binary-model.test.mjs` fails if
 * the two drift apart.
 */
export const SITE_VARIANTS = ['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as const;

export type SiteVariant = (typeof SITE_VARIANTS)[number];

export function isSiteVariant(value: string | null | undefined): value is SiteVariant {
  return typeof value === 'string' && (SITE_VARIANTS as readonly string[]).includes(value);
}

const buildVariant = (() => {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

function loadStoredVariant(): string | null {
  try {
    return localStorage.getItem('worldmonitor-variant');
  } catch {
    return null;
  }
}

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  // Same detector the in-app variant switcher writes through
  // (src/app/event-handlers.ts, isDesktopRuntime). A raw bridge-globals check
  // here answered "web" during desktop:dev early boot and in
  // VITE_DESKTOP_RUNTIME=1 browser builds, so the switcher stored a variant
  // this read then ignored (#5912).
  if (isDesktopRuntime()) {
    const stored = loadStoredVariant();
    if (isSiteVariant(stored)) return stored;
    return buildVariant;
  }

  // window.location, not bare `location`: node-based tests stub `window`
  // without a global `location`, and this module must stay importable there.
  const h = window.location?.hostname;
  if (!h) return buildVariant;
  if (h.startsWith('tech.')) return 'tech';
  if (h.startsWith('finance.')) return 'finance';
  if (h.startsWith('happy.')) return 'happy';
  if (h.startsWith('commodity.')) return 'commodity';
  if (h.startsWith('energy.')) return 'energy';

  if (h === 'localhost' || h === '127.0.0.1') {
    const stored = loadStoredVariant();
    if (isSiteVariant(stored)) return stored;
    return buildVariant;
  }

  return 'full';
})();
