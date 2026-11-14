/**
 * On a phone, Settings is a full-height sheet and device Back walks it: from a
 * page Back returns to the home list, and from the list Back closes Settings.
 * These drive the real component against the real overlay-history manager,
 * with a scripted browser history underneath it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { AuthSession } from '@/services/auth-state';

/**
 * A browser history stack. `deviceBack` is the user's Back gesture; a Back the
 * app asks for lands later, on `settle`, the way popstate does in a browser.
 */
const browser = vi.hoisted(() => {
  const listeners = new Set<(event: PopStateEvent) => void>();
  const entries: unknown[] = [null];
  const queued: Array<() => void> = [];
  let index = 0;
  const pop = () => {
    index -= 1;
    const event = { state: entries[index] } as PopStateEvent;
    listeners.forEach((listener) => listener(event));
  };
  return {
    environment: {
      get state() { return entries[index]; },
      pushState(state: unknown) {
        entries.splice(index + 1, entries.length, structuredClone(state));
        index += 1;
      },
      replaceState(state: unknown) { entries[index] = structuredClone(state); },
      back() { if (index > 0) queued.push(pop); },
      addPopStateListener(listener: (event: PopStateEvent) => void) { listeners.add(listener); },
      removePopStateListener(listener: (event: PopStateEvent) => void) { listeners.delete(listener); },
    },
    depth: () => index,
    deviceBack() { if (index > 0) pop(); },
    settle() { while (queued.length > 0) queued.shift()!(); },
    reset() {
      entries.splice(0, entries.length, null);
      queued.length = 0;
      index = 0;
    },
  };
});

vi.mock('@/utils/overlay-history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/overlay-history')>();
  return { ...actual, overlayHistory: new actual.OverlayHistoryManager(browser.environment) };
});

let session: AuthSession = { user: null, isPending: false };
const authSubscribers: Array<(state: AuthSession) => void> = [];
vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => session,
  subscribeAuthState: (cb: (state: AuthSession) => void) => {
    authSubscribers.push(cb);
    cb(session);
    return () => authSubscribers.splice(authSubscribers.indexOf(cb), 1);
  },
}));

function switchAccountTo(next: AuthSession): void {
  session = next;
  for (const cb of [...authSubscribers]) cb(next);
}

const signedIn = (id: string): AuthSession => ({
  user: { id, name: `User ${id}`, email: `${id}@example.com`, role: 'free' },
  isPending: false,
});

const { UnifiedSettings } = await import('@/components/UnifiedSettings');
const { overlayHistory } = await import('@/utils/overlay-history');

const PANELS = {
  markets: { name: 'Markets', enabled: true, priority: 1 },
  politics: { name: 'Politics', enabled: false, priority: 1 },
};

let settings: InstanceType<typeof UnifiedSettings>;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const row = (id: string) => $<HTMLButtonElement>(`[data-settings-nav="${id}"]`)!;
const page = (id: string) => $(`[data-settings-page="${id}"]`);
const home = () => $('[data-settings-home]')!;
const modal = () => $('.unified-settings-modal')!;
const isOpen = () => $('#unifiedSettingsModal.active') !== null;

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
  browser.settle();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  localStorage.clear();
  browser.reset();
  overlayHistory.reset();
  session = { user: null, isPending: false };
  authSubscribers.length = 0;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 });
  settings = new UnifiedSettings({
    getPanelSettings: () => structuredClone(PANELS),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key: string, fallback: string) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  });
});

afterEach(() => {
  settings.destroy();
  browser.settle();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('device Back on the phone sheet', () => {
  it('returns from a page to the home list with focus on its row, then closes Settings', () => {
    settings.open();
    expect(browser.depth()).toBe(1);
    row('map').click();
    expect(browser.depth()).toBe(2);

    browser.deviceBack();

    expect(isOpen()).toBe(true);
    expect(home().hidden).toBe(false);
    expect(page('map')!.hidden).toBe(true);
    expect(document.activeElement).toBe(row('map'));
    expect(browser.depth()).toBe(1);

    browser.deviceBack();

    expect(isOpen()).toBe(false);
    expect(browser.depth()).toBe(0);
  });

  it('drops the page entry when the header back button returns to the list', () => {
    settings.open();
    row('display').click();

    $<HTMLButtonElement>('[data-settings-back]')!.click();
    browser.settle();

    expect(home().hidden).toBe(false);
    expect(browser.depth()).toBe(1);
    browser.deviceBack();
    expect(isOpen()).toBe(false);
  });

  it('opens a requested page with the home list beneath it', () => {
    settings.open('notifications');
    expect(browser.depth()).toBe(2);

    browser.deviceBack();
    expect(isOpen()).toBe(true);
    expect(home().hidden).toBe(false);

    browser.deviceBack();
    expect(isOpen()).toBe(false);
  });

  it('never stacks a second page entry for repeated taps', () => {
    settings.open();
    row('display').click();
    row('display').click();
    expect(browser.depth()).toBe(2);

    $<HTMLButtonElement>('[data-settings-back]')!.click();
    row('map').click();
    browser.settle();
    expect(browser.depth()).toBe(2);
    expect(page('map')!.hidden).toBe(false);

    browser.deviceBack();
    browser.deviceBack();
    expect(isOpen()).toBe(false);
    expect(browser.depth()).toBe(0);
  });

  it('removes both entries when Settings closes from a page', () => {
    settings.open();
    row('about').click();

    $<HTMLButtonElement>('.unified-settings-close')!.click();
    browser.settle();

    expect(isOpen()).toBe(false);
    expect(browser.depth()).toBe(0);
    expect(overlayHistory.top()).toBeNull();
  });

  it('keeps unsaved panel changes across Back to the list, and asks before Back closes Settings', async () => {
    settings.open('panels');
    page('panels')!.querySelector<HTMLButtonElement>('.panel-toggle-item.active')!.click();

    browser.deviceBack();
    expect(home().hidden).toBe(false);
    expect($('.confirm-dialog-overlay')).toBeNull();

    browser.deviceBack();
    await vi.waitFor(() => expect($('.confirm-dialog-overlay')).not.toBeNull());
    expect(isOpen()).toBe(true);
    expect(browser.depth()).toBe(1);
  });

  it('closes the deletion dialog on Back and stays on the Account page', () => {
    session = signedIn('user_a');
    settings.open('account');
    $<HTMLButtonElement>('[data-delete-account]')!.click();
    expect($('.account-deletion-dialog-overlay')).not.toBeNull();

    browser.deviceBack();

    expect($('.account-deletion-dialog-overlay')).toBeNull();
    expect(page('account')!.hidden).toBe(false);
    expect(browser.depth()).toBe(2);
  });

  it('drops the page entry when the window widens past the phone layout, and restores it on return', () => {
    settings.open();
    row('display').click();

    setWidth(1280);
    expect(browser.depth()).toBe(1);
    expect(page('display')!.hidden).toBe(false);

    setWidth(393);
    expect(browser.depth()).toBe(2);
    browser.deviceBack();
    expect(home().hidden).toBe(false);
  });

  it('gives Settings opened wide a Back stack once the window narrows to the phone layout', () => {
    setWidth(1280);
    settings.open('display');
    expect(browser.depth()).toBe(0);

    setWidth(393);
    expect(browser.depth()).toBe(2);

    browser.deviceBack();
    expect(isOpen()).toBe(true);
    expect(home().hidden).toBe(false);
    browser.deviceBack();
    expect(isOpen()).toBe(false);
    expect(browser.depth()).toBe(0);
  });

  it('keeps history untouched in the desktop modal', () => {
    setWidth(1280);
    settings.open('display');
    expect(browser.depth()).toBe(0);
  });
});

describe('scroll on the phone sheet', () => {
  it('opens every page at its top and returns the list to where it was', () => {
    settings.open();
    modal().scrollTop = 180;
    row('display').click();
    expect(modal().scrollTop).toBe(0);
    modal().scrollTop = 90;

    browser.deviceBack();
    expect(modal().scrollTop).toBe(180);

    row('display').click();
    expect(modal().scrollTop).toBe(0);
  });

  it('returns each page to its own offset in the desktop modal', () => {
    // The modal scrolls its page pane beside the sidebar, not the whole sheet.
    const pane = () => $('[data-settings-pages]')!;
    setWidth(1280);
    settings.open();
    expect(page('display')!.hidden).toBe(false);
    pane().scrollTop = 120;

    row('map').click();
    expect(pane().scrollTop).toBe(0);
    pane().scrollTop = 60;

    row('display').click();
    expect(pane().scrollTop).toBe(120);
    row('map').click();
    expect(pane().scrollTop).toBe(60);
  });

  it('keeps the reader on the same page in place when an account change remounts it', () => {
    // A browser clamps the offset once the scrolled page leaves the DOM;
    // happy-dom has no layout, so model that clamp at removal.
    let offset = 0;
    Object.defineProperty(modal(), 'scrollTop', {
      configurable: true,
      get: () => offset,
      set: (value: number) => { offset = value; },
    });
    const remove = Element.prototype.remove;
    vi.spyOn(Element.prototype, 'remove').mockImplementation(function (this: Element) {
      if (this.matches('.us-page:not([hidden])')) offset = 0;
      remove.call(this);
    });

    settings.open('display');
    modal().scrollTop = 240;
    switchAccountTo(signedIn('user_b'));

    expect(page('display')!.hidden).toBe(false);
    expect(modal().scrollTop).toBe(240);
  });
});
