import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const tier = vi.hoisted(() => ({ pro: false }));
vi.mock('@/services/widget-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/widget-store')>()),
  isProUser: () => tier.pro,
}));

import { UnifiedSettings } from '@/components/UnifiedSettings';
import { ALL_PANELS, FREE_MAX_PANELS, isFreePanelCapCounted } from '@/config/panels';
import type { PanelConfig } from '@/types';
import { initTestI18n } from './helpers/i18n.mts';

function createSettings(saved: Record<string, PanelConfig>, saves: Array<Record<string, PanelConfig>>): UnifiedSettings {
  return new UnifiedSettings({
    getPanelSettings: () => saved,
    savePanelSettings: (panels) => { saves.push(panels); },
    getDisabledSources: () => new Set<string>(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key: string, fallback: string) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  });
}

function row(key: string): HTMLElement {
  const toggle = document.querySelector<HTMLElement>(`#usPanelToggles .panel-toggle-item[data-panel="${key}"]`);
  expect(toggle, `row for ${key}`).not.toBeNull();
  return toggle!.closest<HTMLElement>('.panel-settings-item')!;
}

function selectedScale(item: HTMLElement, key: string): string | undefined {
  return item.querySelector<HTMLOptionElement>(`select[data-panel-font-scale="${key}"] option[selected]`)?.value;
}

function chooseScale(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  tier.pro = false;
  document.body.replaceChildren();
});

/** Every catalog panel saved explicitly, with exactly FREE_MAX_PANELS free panels on. */
function atFreeCap(): { saved: Record<string, PanelConfig>; next: string } {
  const free = Object.keys(ALL_PANELS).filter((key) => isFreePanelCapCounted(key) && !ALL_PANELS[key]!.premium);
  expect(free.length).toBeGreaterThan(FREE_MAX_PANELS);
  const saved: Record<string, PanelConfig> = {};
  for (const key of Object.keys(ALL_PANELS)) saved[key] = { ...ALL_PANELS[key]!, enabled: false };
  for (const key of free.slice(0, FREE_MAX_PANELS)) saved[key]!.enabled = true;
  return { saved, next: free[FREE_MAX_PANELS]! };
}

const pressed = (key: string) => row(key).querySelector('.panel-toggle-item')!.getAttribute('aria-pressed');
const saveButton = () => document.querySelector<HTMLButtonElement>('.panels-save-layout')!;

describe('UnifiedSettings panel rows', () => {
  it('renders one row per panel with its switch button and, when supported, an inline text size select', () => {
    const settings = createSettings({
      map: { name: 'Global Situation', enabled: true, priority: 1 },
      'live-news': { name: 'Live News', enabled: true, priority: 1, fontScale: 1.25 },
      markets: { name: 'Markets', enabled: false, priority: 1 },
    }, []);
    settings.open('panels');

    const rows = [...document.querySelectorAll<HTMLElement>('#usPanelToggles .panel-settings-item')];
    expect(rows.length).toBeGreaterThan(3);
    for (const item of rows) {
      const toggles = item.querySelectorAll<HTMLButtonElement>('button.panel-toggle-item[data-panel]');
      expect(toggles).toHaveLength(1);
      expect(toggles[0]!.type).toBe('button');
    }
    expect(document.querySelector('.panel-font-scale-details')).toBeNull();

    const news = row('live-news');
    expect(news.querySelector('.panel-toggle-item')!.getAttribute('aria-pressed')).toBe('true');
    expect(selectedScale(news, 'live-news')).toBe('1.25');
    expect(news.querySelector('[data-panel-scale-summary]')!.textContent).toBe('125%');

    const markets = row('markets');
    expect(markets.querySelector('.panel-toggle-item')!.getAttribute('aria-pressed')).toBe('false');
    expect(selectedScale(markets, 'markets')).toBe('global');
    expect(markets.querySelector('[data-panel-scale-summary]')!.textContent).toBe('Aa');

    const map = row('map');
    expect(map.querySelector('.panel-toggle-item')!.getAttribute('aria-pressed')).toBe('true');
    expect(map.querySelector('[data-panel-font-scale]')).toBeNull();
    settings.close();
  });

  it('locks the switch and select for a panel the user is not entitled to', () => {
    const settings = createSettings({ 'stock-analysis': { name: 'Stock Analysis', enabled: false, priority: 1 } }, []);
    settings.open('panels');

    const locked = row('stock-analysis');
    const toggle = locked.querySelector<HTMLElement>('.panel-toggle-item')!;
    expect(toggle.hasAttribute('aria-pressed')).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe('Upgrade to Pro to use Stock Analysis');
    expect(locked.querySelector<HTMLSelectElement>('[data-panel-font-scale]')!.disabled).toBe(true);
    settings.close();
  });

  it('keeps text size edits as a draft until Save and saves "global" as no override', () => {
    const saves: Array<Record<string, PanelConfig>> = [];
    const settings = createSettings({
      'live-news': { name: 'Live News', enabled: true, priority: 1, fontScale: 1.25 },
      markets: { name: 'Markets', enabled: true, priority: 1 },
    }, saves);
    settings.open('panels');

    chooseScale(row('markets').querySelector<HTMLSelectElement>('[data-panel-font-scale]')!, '0.9');
    expect(row('markets').querySelector('[data-panel-scale-summary]')!.textContent).toBe('90%');
    expect(row('markets').querySelector('.panel-toggle-item')!.classList.contains('changed')).toBe(true);
    chooseScale(row('live-news').querySelector<HTMLSelectElement>('[data-panel-font-scale]')!, 'global');
    expect(row('live-news').querySelector('[data-panel-scale-summary]')!.textContent).toBe('Aa');
    expect(saves).toHaveLength(0);

    document.querySelector<HTMLButtonElement>('.panels-save-layout')!.click();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.markets!.fontScale).toBe(0.9);
    expect(saves[0]!['live-news']).not.toHaveProperty('fontScale');
    settings.close();
  });

  it('refuses a free user a panel past the free cap and says why', () => {
    const { saved, next } = atFreeCap();
    const saves: Array<Record<string, PanelConfig>> = [];
    const settings = createSettings(saved, saves);
    settings.open('panels');

    row(next).querySelector<HTMLElement>('.panel-toggle-item')!.click();

    expect(pressed(next)).toBe('false');
    expect(document.querySelector('.toast-notification')?.textContent).toContain(String(FREE_MAX_PANELS));
    expect(saveButton().disabled).toBe(true);
    saveButton().click();
    expect(saves).toHaveLength(0);
    settings.close();
  });

  it('drops unsaved panels past the cap when paid access ends with Settings open', () => {
    tier.pro = true;
    const { saved, next } = atFreeCap();
    const saves: Array<Record<string, PanelConfig>> = [];
    const settings = createSettings(saved, saves);
    settings.open('panels');

    row(next).querySelector<HTMLElement>('.panel-toggle-item')!.click();
    expect(pressed(next)).toBe('true');
    expect(saveButton().disabled).toBe(false);

    tier.pro = false;
    settings.refreshPanelToggles();

    expect(pressed(next)).toBe('false');
    expect(saveButton().disabled).toBe(true);
    saveButton().click();
    expect(saves).toHaveLength(0);
    settings.close();
  });
});
