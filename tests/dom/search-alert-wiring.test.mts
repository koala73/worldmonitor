/**
 * The Cmd+K "Alerts sent to you" wiring (src/app/search-alert-wiring.ts):
 * where a selected alert's article opens, and when the indexed alerts are
 * dropped. The source, the modal and the server each have their own suite;
 * this one covers what only the wiring decides.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/services/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop-runtime')>()),
  isDesktopRuntime: () => runtime.desktop,
}));

// The native side of `open_url`. The real external-navigation module runs.
const invokeTauri = vi.hoisted(() => vi.fn());
vi.mock('@/services/tauri-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tauri-bridge')>()),
  invokeTauri: (...args: unknown[]) => invokeTauri(...args),
}));
vi.mock('@/bootstrap/sentry-defer', () => ({ enqueueSentryCall: vi.fn() }));

// Account state the wiring reads, and the listeners it registers per signal.
const account = vi.hoisted(() => ({
  userId: 'user_a' as string | null,
  premium: true,
  listeners: {
    auth: new Set<() => void>(),
    entitlement: new Set<() => void>(),
    widgetAccess: new Set<() => void>(),
    runtimeConfig: new Set<() => void>(),
  },
}));
function subscribeTo(listeners: Set<() => void>) {
  return (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
}
vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({ user: account.userId ? { id: account.userId } : null }),
  subscribeAuthState: subscribeTo(account.listeners.auth),
}));
vi.mock('@/services/entitlements', () => ({ onEntitlementChange: subscribeTo(account.listeners.entitlement) }));
vi.mock('@/services/widget-store', () => ({ subscribeWidgetAccess: subscribeTo(account.listeners.widgetAccess) }));
vi.mock('@/services/runtime-config', () => ({ subscribeRuntimeConfig: subscribeTo(account.listeners.runtimeConfig) }));
// Tester-key and desktop-API-key grants count as premium here, as in the real panel-gating.
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => account.premium }));
vi.mock('@/services/i18n', () => ({ getLocale: () => 'en', t: (key: string) => key }));
const fetchSentAlerts = vi.hoisted(() => vi.fn());
vi.mock('@/services/sent-alerts', () => ({ fetchSentAlerts: (...args: unknown[]) => fetchSentAlerts(...args) }));

import { attachSentAlertSearch, canOpenSentAlertLink, openSentAlertLink } from '@/app/search-alert-wiring';
import type { SearchModal } from '@/components/SearchModal';

const HTTPS_LINK = 'https://www.reuters.com/world/hormuz';
const HTTP_LINK = 'http://example.org/story';

let windowOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runtime.desktop = false;
  invokeTauri.mockReset().mockResolvedValue(undefined);
  windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  windowOpen.mockRestore();
});

describe('opening a selected alert', () => {
  it('hands the article to the OS browser on desktop, never to the app WebView', async () => {
    runtime.desktop = true;
    openSentAlertLink(HTTPS_LINK);
    await vi.waitFor(() => expect(invokeTauri).toHaveBeenCalledWith('open_url', { url: HTTPS_LINK }));
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('opens a new tab on the web, with no opener and no referrer', () => {
    openSentAlertLink(HTTPS_LINK);
    expect(windowOpen).toHaveBeenCalledWith(HTTPS_LINK, '_blank', 'noopener,noreferrer');
    expect(invokeTauri).not.toHaveBeenCalled();
  });

  it('offers a plain-http article on the web, where a tab can open it', () => {
    expect(canOpenSentAlertLink(HTTP_LINK)).toBe(true);
    expect(canOpenSentAlertLink(HTTPS_LINK)).toBe(true);
  });

  it('offers only what the native opener accepts on desktop', () => {
    runtime.desktop = true;
    expect(canOpenSentAlertLink(HTTPS_LINK)).toBe(true);
    // The native opener refuses plain http, so the row must not offer it.
    expect(canOpenSentAlertLink(HTTP_LINK)).toBe(false);
  });

  it('never offers a link that is not http or https', () => {
    for (const desktop of [false, true]) {
      runtime.desktop = desktop;
      for (const link of ['', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) {
        expect(canOpenSentAlertLink(link), `${desktop ? 'desktop' : 'web'}: ${link}`).toBe(false);
      }
    }
  });
});

describe('dropping the indexed alerts', () => {
  /** A palette that records what the alert source registers. */
  function palette() {
    const registered: number[] = [];
    let open: () => void = () => {};
    const modal = {
      setOnOpen: (callback: () => void) => { open = callback; },
      registerSource: (_type: string, items: unknown[]) => { registered.push(items.length); },
      getSearchIndexRevision: () => registered.length,
      refreshSearch: () => {},
    } as unknown as SearchModal;
    return { modal, registered, open: () => open() };
  }

  beforeEach(() => {
    account.userId = 'user_a';
    account.premium = true;
    for (const listeners of Object.values(account.listeners)) listeners.clear();
    fetchSentAlerts.mockReset().mockResolvedValue([
      { title: 'Iran closes Hormuz strait to tankers', source: 'Reuters', link: HTTPS_LINK, sentAt: 1_763_370_000_000 },
    ]);
  });

  // Removing a tester key or the desktop API key ends premium access and
  // notifies only its own listeners: the signed-in user and the entitlement
  // are unchanged.
  for (const [grant, signal] of [['a tester key', 'widgetAccess'], ['the desktop API key', 'runtimeConfig']] as const) {
    it(`drops them when ${grant} is removed while the palette stays open`, async () => {
      const ui = palette();
      const detach = attachSentAlertSearch(ui.modal);
      ui.open();
      await vi.waitFor(() => expect(ui.registered).toEqual([1]));

      account.premium = false;
      for (const listener of account.listeners[signal]) listener();

      expect(ui.registered).toEqual([1, 0]);
      detach();
    });
  }

  it('keeps them when a signal fires and the account is unchanged', async () => {
    const ui = palette();
    const detach = attachSentAlertSearch(ui.modal);
    ui.open();
    await vi.waitFor(() => expect(ui.registered).toEqual([1]));
    for (const listeners of Object.values(account.listeners)) for (const listener of listeners) listener();
    expect(ui.registered).toEqual([1]);
    detach();
  });

  it('stops listening for every account signal on teardown', () => {
    const detach = attachSentAlertSearch(palette().modal);
    expect(Object.values(account.listeners).map((listeners) => listeners.size)).toEqual([1, 1, 1, 1]);
    detach();
    expect(Object.values(account.listeners).map((listeners) => listeners.size)).toEqual([0, 0, 0, 0]);
  });
});
