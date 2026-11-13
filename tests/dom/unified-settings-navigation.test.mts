/**
 * Settings opens on a home list of sections. Each row drills into one page,
 * the header's back button returns to the list, and the list's summaries
 * follow what changed on the pages. These drive the real component the way a
 * user does: clicking rows, the back button and the controls on a page.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const openSignIn = vi.hoisted(() => vi.fn());
vi.mock('@/services/clerk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/clerk')>()),
  openSignIn,
}));

const notificationsMount = vi.hoisted(() => ({ attached: 0, detached: 0 }));
vi.mock('@/services/notifications-settings', () => ({
  renderNotificationsSettings: () => ({
    html: '<div data-notifications-stub></div>',
    attach: () => {
      notificationsMount.attached += 1;
      return () => { notificationsMount.detached += 1; };
    },
  }),
}));

const { UnifiedSettings } = await import('@/components/UnifiedSettings');

type Settings = InstanceType<typeof UnifiedSettings>;

const PANELS = {
  markets: { name: 'Markets', enabled: true, priority: 1 },
  politics: { name: 'Politics', enabled: false, priority: 1 },
};

let settings: Settings;

function createSettings(): Settings {
  return new UnifiedSettings({
    getPanelSettings: () => structuredClone(PANELS),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set<string>(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key: string, fallback: string) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  });
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const row = (id: string) => $<HTMLButtonElement>(`[data-settings-nav="${id}"]`);
const page = (id: string) => $(`[data-settings-page="${id}"]`);
const summary = (id: string) => row(id)?.querySelector('[data-settings-summary]')?.textContent ?? null;
const home = () => $('[data-settings-home]')!;
const back = () => $<HTMLButtonElement>('[data-settings-back]')!;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  localStorage.clear();
  openSignIn.mockClear();
  notificationsMount.attached = 0;
  notificationsMount.detached = 0;
  settings = createSettings();
});

afterEach(() => {
  settings.destroy();
  document.body.replaceChildren();
});

describe('Settings home list', () => {
  it('opens on grouped rows and mounts no page until one is chosen', () => {
    settings.open();

    expect(home().hidden).toBe(false);
    expect(back().hidden).toBe(true);
    const groups = [...document.querySelectorAll('.us-group-label')].map((h) => h.textContent);
    expect(groups).toEqual(['Dashboard', 'Preferences', 'Developer', 'App']);
    expect(row('panels')).not.toBeNull();
    expect(row('about')).not.toBeNull();
    expect(document.querySelectorAll('[data-settings-page]')).toHaveLength(0);
    expect(document.querySelector('[role="tablist"]')).toBeNull();
  });

  it('offers sign-in in place of the account card when signed out', () => {
    settings.open();

    expect(row('account')).toBeNull();
    $<HTMLButtonElement>('[data-settings-signin]')!.click();

    expect(document.querySelector('#unifiedSettingsModal.active')).toBeNull();
    return vi.waitFor(() => expect(openSignIn).toHaveBeenCalledTimes(1));
  });

  it('drills into a page and returns focus to its row on back', () => {
    settings.open();
    row('map')!.click();

    expect(home().hidden).toBe(true);
    expect(back().hidden).toBe(false);
    expect(page('map')!.hidden).toBe(false);
    expect(document.activeElement).toBe(page('map')!.querySelector('.us-page-title'));
    expect(page('map')!.querySelector('#us-map-provider')).not.toBeNull();

    back().click();

    expect(home().hidden).toBe(false);
    expect(page('map')!.hidden).toBe(true);
    expect(document.activeElement).toBe(row('map'));
  });

  it('opens straight onto a requested page', () => {
    settings.open('notifications');

    expect(home().hidden).toBe(true);
    expect(page('notifications')!.querySelector('[data-notifications-stub]')).not.toBeNull();
    expect(notificationsMount.attached).toBe(1);
  });

  it('keeps a visited page mounted until close, then disposes it', () => {
    settings.open('notifications');
    back().click();
    row('notifications')!.click();
    expect(notificationsMount.attached).toBe(1);

    settings.close();
    expect(notificationsMount.detached).toBe(1);
    expect(document.querySelectorAll('[data-settings-page]')).toHaveLength(0);

    settings.open();
    expect(home().hidden).toBe(false);
  });

  it('lists the site and legal links on the About page', () => {
    settings.open('about');

    const about = page('about')!;
    expect(about.querySelector('nav.dashboard-site-links-row')).not.toBeNull();
    expect(about.querySelector('nav.legal-links-row a')).not.toBeNull();
  });
});

describe('Settings row summaries', () => {
  it('counts the panels the Panels page shows as on, and follows a toggle', () => {
    settings.open();
    row('panels')!.click();
    const toggles = () => [...page('panels')!.querySelectorAll<HTMLButtonElement>('.panel-toggle-item')];
    const on = () => toggles().filter((toggle) => toggle.classList.contains('active')).length;
    const before = on();
    back().click();
    expect(summary('panels')).toBe(`${before} of ${toggles().length}`);

    row('panels')!.click();
    // Turning one off avoids the free-plan cap on turning panels on.
    toggles().find((toggle) => toggle.classList.contains('active'))!.click();
    expect(on()).toBe(before - 1);
    back().click();

    expect(summary('panels')).toBe(`${before - 1} of ${toggles().length}`);
  });

  it('shows the theme on the Display row and follows a change', () => {
    settings.open();
    expect(summary('display')).toBe('Auto');

    row('display')!.click();
    const theme = page('display')!.querySelector<HTMLSelectElement>('#us-theme')!;
    theme.value = 'dark';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
    back().click();

    expect(summary('display')).toBe('Dark');
  });
});
