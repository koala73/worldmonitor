import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternalUrl = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock('@/services/external-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/external-navigation')>()),
  openExternalUrl,
}));

// App.init() is driven only as far as the cap-drop listener registration.
// These stubs replace the network, IndexedDB, and global-install steps that
// precede it; nothing here stands in for the listener itself.
vi.mock('@/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services')>()),
  initDB: vi.fn(async () => undefined),
}));
vi.mock('@/services/wm-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wm-session')>()),
  ensureWmSession: vi.fn(async () => true),
  installWmSessionFetchInterceptor: vi.fn(),
}));
vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bootstrap')>()),
  fetchBootstrapData: vi.fn(async () => undefined),
}));
vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  initAuthState: vi.fn(async () => undefined),
}));
vi.mock('@/services/sign-up-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sign-up-resume')>()),
  installSignUpResume: vi.fn(),
}));
vi.mock('@/utils/cloud-prefs-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/cloud-prefs-sync')>()),
  install: vi.fn(),
}));
vi.mock('@/services/followed-countries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/followed-countries')>()),
  installFollowedCountriesAuthListener: vi.fn(),
}));

import { App } from '@/App';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { WM_FOLLOWED_COUNTRIES_CAP_DROP } from '@/services/followed-countries';

// The cap-drop EVENT is emitted and asserted at runtime in
// tests/followed-countries-sign-in-handoff.test.mjs. This suite checks that
// App.init() subscribes to it and App.destroy() unsubscribes, and drives the
// App-side renderer that turns it into an upgrade toast.
function dispatchCapDrop(kept: number, dropped: number): void {
  window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CAP_DROP, { detail: { kept, dropped } }));
}
function showToast(app: App, kept: number, dropped: number): void {
  const show = Reflect.get(app, 'showFollowedCountriesCapDropToast') as (
    kept: number,
    dropped: number,
  ) => void;
  show.call(app, kept, dropped);
}

function makeApp(): App {
  const app = Object.create(App.prototype) as App;
  Reflect.set(app, 'followedCountriesCapDropToastTimer', null);
  return app;
}

function currentToast(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.wm-followed-cap-drop-toast');
}

describe('App followed-countries cap-drop toast', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openExternalUrl.mockClear();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('init subscribes to the cap-drop event and destroy unsubscribes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'));
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    const app = new App('app');

    dispatchCapDrop(1, 2);
    expect(currentToast(), 'no listener before init').toBeNull();

    // enforceFreeTierLimits() is the first call after the registration; make it
    // throw so init stops there instead of building the whole dashboard.
    const stop = new Error('stop after cap-drop registration');
    const enforce = vi.spyOn(
      App.prototype as unknown as { enforceFreeTierLimits: () => boolean },
      'enforceFreeTierLimits',
    ).mockImplementation(() => { throw stop; });
    try {
      await expect(app.init(null)).rejects.toBe(stop);
    } finally {
      enforce.mockRestore();
    }

    dispatchCapDrop(1, 2);
    expect(currentToast()?.querySelector('.update-toast-detail')?.textContent).toMatch(/^1 kept\. 2 countries/);
    currentToast()!.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.click();
    expect(currentToast()).toBeNull();

    app.destroy();
    dispatchCapDrop(1, 2);
    expect(currentToast(), 'listener must be removed by destroy').toBeNull();
    fetchSpy.mockRestore();
  });

  it('renders one accessible upgrade toast that explains the cap', () => {
    const app = makeApp();
    showToast(app, 1, 2);
    showToast(app, 1, 2);

    expect(document.querySelectorAll('.wm-followed-cap-drop-toast')).toHaveLength(1);
    const toast = currentToast()!;
    expect(toast.classList.contains('update-toast')).toBe(true);
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(toast.querySelector('.update-toast-title')?.textContent).toBe('Follow limit reached');
    expect(toast.querySelector('.update-toast-detail')?.textContent)
      .toMatch(/^1 kept\. 2 countries were not added because the free plan supports \d+ followed countries\.$/);
  });

  it('auto-dismisses after its timer and clears the handle', () => {
    const app = makeApp();
    showToast(app, 2, 1);
    expect(Reflect.get(app, 'followedCountriesCapDropToastTimer')).not.toBeNull();

    vi.advanceTimersByTime(8000);

    expect(currentToast()).toBeNull();
    expect(Reflect.get(app, 'followedCountriesCapDropToastTimer')).toBeNull();
  });

  it('upgrade opens the absolute pricing URL through openExternalUrl and clears the timer', () => {
    const app = makeApp();
    showToast(app, 2, 1);

    currentToast()!.querySelector<HTMLButtonElement>('[data-action="upgrade"]')!.click();

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(`${WEB_APP_ORIGIN}/pro#pricing`);
    expect(new URL(openExternalUrl.mock.calls[0]![0]).protocol).toBe('https:');
    expect(currentToast()).toBeNull();
    expect(Reflect.get(app, 'followedCountriesCapDropToastTimer')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dismiss removes the toast and clears the timer without navigating', () => {
    const app = makeApp();
    showToast(app, 2, 1);

    currentToast()!.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.click();

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(currentToast()).toBeNull();
    expect(Reflect.get(app, 'followedCountriesCapDropToastTimer')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
