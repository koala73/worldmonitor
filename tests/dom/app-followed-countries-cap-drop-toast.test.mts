import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternalUrl = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock('@/services/external-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/external-navigation')>()),
  openExternalUrl,
}));

import { App } from '@/App';
import { WEB_APP_ORIGIN } from '@/config/web-origin';

// The cap-drop EVENT is emitted and asserted at runtime in
// tests/followed-countries-sign-in-handoff.test.mjs. This suite drives the
// App-side renderer that turns it into an upgrade toast.
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
