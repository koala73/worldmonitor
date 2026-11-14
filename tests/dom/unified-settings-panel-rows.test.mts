import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { UnifiedSettings } from '@/components/UnifiedSettings';
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
  document.body.replaceChildren();
});

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
});
