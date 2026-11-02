/**
 * Variant panel names reach every surface that names a panel.
 *
 * VARIANT_PANEL_OVERRIDES renames shared panels per variant (finance's
 * insights panel is "AI Market Insights"). The panel header, the Settings
 * panel list and the search command deck each resolved the generic
 * `panels.<key>` locale string instead, so finance.worldmonitor.app and
 * energy.worldmonitor.app read "AI INSIGHTS" everywhere.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';

import { initTestI18n } from './helpers/i18n.mts';

const { variant } = vi.hoisted(() => ({ variant: { value: 'full' } }));

vi.mock('@/config/variant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/variant')>();
  return {
    ...actual,
    get SITE_VARIANT() { return variant.value; },
  };
});

vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: vi.fn(async () => null),
  setPersistentCache: vi.fn(async () => {}),
  deletePersistentCache: vi.fn(async () => {}),
  deletePersistentCacheByPrefix: vi.fn(),
}));

vi.mock('@/services/insights-loader', () => ({
  getServerInsights: vi.fn(() => null),
  fetchServerInsights: vi.fn(async () => null),
  MAX_AGE_MS: 3_600_000,
}));

vi.mock('@/services/ml-worker', () => ({
  mlWorker: { isAvailable: false, classifySentiment: vi.fn(async () => null) },
}));

vi.mock('@/services/analytics', () => ({ trackSearchUsed: vi.fn() }));

import { VARIANT_PANEL_OVERRIDES } from '@/config/panels';
import { InsightsPanel } from '@/components/InsightsPanel';
import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { SearchModal } from '@/components/SearchModal';
import { PanelLayoutManager } from '@/app/panel-layout';
import en from '@/locales/en.json';
import fr from '@/locales/fr.json';

const OVERRIDES = Object.entries(VARIANT_PANEL_OVERRIDES).flatMap(([variantName, panels]) =>
  Object.entries(panels ?? {}).map(([key, config]) => ({ variant: variantName, key, name: config?.name ?? '' })),
);

const PANEL_CONSTRUCTORS: Record<string, () => { getElement(): HTMLElement; destroy(): void }> = {
  insights: () => new InsightsPanel(),
  'live-news': () => new LiveNewsPanel(),
};

const panels: Array<{ destroy(): void }> = [];
let modal: SearchModal | null = null;

function headerOf(key: string): string {
  const panel = PANEL_CONSTRUCTORS[key]!();
  panels.push(panel);
  return panel.getElement().querySelector('.panel-title')?.textContent?.trim() ?? '';
}

function searchCommandTitle(query: string, commandId: string): string {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  modal = new SearchModal(document.body, { placeholder: 'Search' });
  modal.setActivePanels(['map', 'live-news', 'insights']);
  modal.open();
  modal.applyQuery(query);
  return document.querySelector(`[data-command="${commandId}"] .search-result-title`)?.textContent?.trim() ?? '';
}

async function mapHeaderOf(): Promise<string> {
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
  const container = document.body.appendChild(document.createElement('div'));
  const layout = Object.create(PanelLayoutManager.prototype) as PanelLayoutManager;
  Reflect.set(layout, 'ctx', { container, isDesktopApp: false, isMobile: false, panels: {}, panelSettings: {} });
  // The shell markup is written first; panel creation after it needs a full App and throws here.
  await layout.renderLayout().catch(() => {});
  return container.querySelector('#mapSection .panel-title')?.textContent?.trim() ?? '';
}

function settingsName(key: string): string {
  return PanelLayoutManager.prototype.getLocalizedPanelName(key, key);
}

beforeAll(async () => {
  await initTestI18n();
  i18next.addResourceBundle('fr', 'translation', fr, true, true);
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  modal?.close();
  modal = null;
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  variant.value = 'full';
  await i18next.changeLanguage('en');
});

describe('variant panel name overrides', () => {
  it('covers the finance and energy insights rename', () => {
    expect(OVERRIDES).toContainEqual({ variant: 'finance', key: 'insights', name: 'AI Market Insights' });
    expect(OVERRIDES).toContainEqual({ variant: 'energy', key: 'insights', name: 'AI Energy Insights' });
  });

  it.each(OVERRIDES)('ships the $variant $key name in the English catalog', ({ variant: variantName, key, name }) => {
    const camelKey = key.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
    expect(Reflect.get(Reflect.get(en.panelVariants, variantName) ?? {}, camelKey)).toBe(name);
  });

  it.each(OVERRIDES.filter(({ key }) => key in PANEL_CONSTRUCTORS))(
    'renders the $variant $key header as "$name"',
    ({ variant: variantName, key, name }) => {
      variant.value = variantName;
      expect(headerOf(key)).toBe(name);
    },
  );

  it.each(OVERRIDES)('lists the $variant $key panel as "$name" in Settings', ({ variant: variantName, key, name }) => {
    variant.value = variantName;
    expect(settingsName(key)).toBe(name);
  });

  it.each(OVERRIDES)('labels the $variant $key search command "$name"', ({ variant: variantName, key, name }) => {
    variant.value = variantName;
    expect(searchCommandTitle(name, `panel:${key}`)).toBe(`${en.commands.prefixes.panel}: ${name}`);
  });

  it.each(OVERRIDES.filter(({ key }) => key === 'map'))(
    'renders the $variant map header as "$name"',
    async ({ variant: variantName, name }) => {
      variant.value = variantName;
      expect(await mapHeaderOf()).toBe(name);
    },
  );

  it('keeps the generic name on the full variant', async () => {
    variant.value = 'full';
    expect(headerOf('insights')).toBe(en.panels.insights);
    expect(headerOf('live-news')).toBe(en.panels.liveNews);
    expect(settingsName('insights')).toBe(en.panels.insights);
    expect(await mapHeaderOf()).toBe(en.panels.map);
  });

  it('localizes the override name, not the generic panel name', async () => {
    await i18next.changeLanguage('fr');
    variant.value = 'finance';
    const header = headerOf('insights');
    expect(header).not.toBe('AI Market Insights');
    expect(header).not.toBe(fr.panels.insights);
    expect(settingsName('insights')).toBe(header);
  });
});
