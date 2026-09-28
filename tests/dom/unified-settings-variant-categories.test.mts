import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { UnifiedSettings } from '@/components/UnifiedSettings';
import { PANEL_CATEGORY_MAP } from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import { initTestI18n } from './helpers/i18n.mts';

function createSettings(): UnifiedSettings {
  return new UnifiedSettings({
    getPanelSettings: () => ({ markets: { name: 'Markets', enabled: true, priority: 1 } }),
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

function pillKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#usPanelCatBar [data-panel-cat]')].map((b) => b.dataset.panelCat!);
}

function selectCategory(key: string): string[] {
  const bar = document.querySelector<HTMLElement>('#usPanelCatBar')!;
  const pill = document.createElement('button');
  pill.dataset.panelCat = key;
  bar.appendChild(pill);
  pill.click();
  return [...document.querySelectorAll<HTMLElement>('#usPanelToggles .panel-toggle-item')].map((b) => b.dataset.panel!);
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('UnifiedSettings panel categories follow the active variant', () => {
  it('hides categories scoped to another variant, even when they list panels this variant has', () => {
    // Fixture assumptions: tests run as the full variant, and `markets` sits in
    // both the full-scoped marketsFinance and the tech-only techMarkets category.
    expect(SITE_VARIANT).toBe('full');
    expect(PANEL_CATEGORY_MAP.marketsFinance!.variants).toContain('full');
    expect(PANEL_CATEGORY_MAP.marketsFinance!.panelKeys).toContain('markets');
    expect(PANEL_CATEGORY_MAP.techMarkets!.variants).not.toContain('full');
    expect(PANEL_CATEGORY_MAP.techMarkets!.panelKeys).toContain('markets');

    const settings = createSettings();
    settings.open('panels');

    expect(pillKeys()).toContain('marketsFinance');
    expect(pillKeys()).not.toContain('techMarkets');

    // Positive control: the in-variant category lists `markets`.
    expect(selectCategory('marketsFinance')).toContain('markets');
    // A stale or injected out-of-variant category lists nothing.
    expect(selectCategory('techMarkets')).toEqual([]);
    settings.close();
  });
});
