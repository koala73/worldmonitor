/**
 * Per-panel filter choices travel with the tab (#10453, phase 2). A panel that
 * owns a choice reports a user's change, accepts one from the tab or a shared
 * dashboard without reporting it back, and ignores a value it does not know.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForecastPanel } from '@/components/ForecastPanel';
import { LiveWebcamsPanel } from '@/components/LiveWebcamsPanel';
import { Panel } from '@/components/Panel';
import { captureTeamDashboardLayout, toTeamDashboardTab } from '@/services/team-dashboards';
import { PanelLayoutManager } from '@/app/panel-layout';

import { createFakeYouTubeIframeApi } from './helpers/fake-youtube-iframe-api.mts';
import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/live-video/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: () => Promise.resolve(createFakeYouTubeIframeApi().namespace),
}));

vi.mock('@/config/live-video-sources', async (importOriginal) => {
  const { withFixtureWebcamCatalog } = await import('./helpers/webcam-catalog.mts');
  return withFixtureWebcamCatalog(await importOriginal<typeof import('@/config/live-video-sources')>());
});

class FakeIntersectionObserver {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

// Panel.setSafeContent commits a render after this long.
const CONTENT_DEBOUNCE_MS = 150;

const panels: Panel[] = [];

function mount<T extends Panel>(panel: T): T {
  panels.push(panel);
  document.body.appendChild(panel.getElement());
  return panel;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Panel base class', () => {
  it('declares no filter choice by default', () => {
    class Plain extends Panel {
      constructor() {
        super({ id: 'plain-test', title: 'Plain' });
      }
    }
    const panel = mount(new Plain());
    expect(panel.hasFilterChoice()).toBe(false);
    expect(panel.getFilterChoice()).toBeNull();
    panel.setFilterChoice('anything');
    expect(panel.getFilterChoice()).toBeNull();
  });
});

describe('ForecastPanel region choice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares a choice, null while on All Regions', () => {
    const panel = mount(new ForecastPanel());
    expect(panel.hasFilterChoice()).toBe(true);
    expect(panel.getFilterChoice()).toBeNull();
  });

  it('accepts a known region without reporting it back, and shows it active', () => {
    const panel = mount(new ForecastPanel());
    const seen = vi.fn();
    panel.onFilterChoiceChange(seen);
    panel.setFilterChoice('east-asia');
    expect(panel.getFilterChoice()).toBe('east-asia');
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(panel.getElement().querySelector('[data-fc-region="east-asia"]')?.classList.contains('fc-active')).toBe(true);
  });

  it('applies the region restored from a shared dashboard through the layout to the real panel', () => {
    const panel = mount(new ForecastPanel());
    const panelSettings = { forecast: { name: 'Forecast', enabled: true, priority: 1 } };
    const layout = captureTeamDashboardLayout({
      panelSettings, panelOrder: ['forecast'], bottomSet: [], rowSpans: {}, colSpans: {}, map: null,
      panelFilters: { forecast: 'east-asia' },
    });
    const tab = toTeamDashboardTab(layout, panelSettings);
    Reflect.get(PanelLayoutManager.prototype, 'applyTabPanelFilters').call({
      ctx: { panels: { forecast: panel } }, appliedPanelFilters: new Set(),
    }, tab.panelFilters);
    expect(panel.getFilterChoice()).toBe('east-asia');
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(panel.getElement().querySelector('[data-fc-region="east-asia"]')?.classList.contains('fc-active')).toBe(true);
  });

  it('ignores a region it does not know and returns to All Regions on null', () => {
    const panel = mount(new ForecastPanel());
    panel.setFilterChoice('east-asia');
    panel.setFilterChoice('atlantis');
    expect(panel.getFilterChoice()).toBe('east-asia');
    panel.setFilterChoice(null);
    expect(panel.getFilterChoice()).toBeNull();
  });

  it('reports a region the user picks, and "" when the user returns to All Regions', () => {
    const panel = mount(new ForecastPanel());
    const seen = vi.fn();
    panel.onFilterChoiceChange(seen);
    panel.updateForecasts([], { generatedAt: 1_790_000_000_000 });
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    panel.getElement().querySelector<HTMLElement>('[data-fc-region="europe"]')!.click();
    expect(seen).toHaveBeenLastCalledWith('europe');
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    panel.getElement().querySelector<HTMLElement>('[data-fc-region=""]')!.click();
    // All Regions is a choice the tab keeps ('' ), not an absent one.
    expect(seen).toHaveBeenLastCalledWith('');
  });
});

describe('LiveWebcamsPanel region choice', () => {
  it('declares a choice, null while on All', () => {
    const panel = mount(new LiveWebcamsPanel());
    expect(panel.hasFilterChoice()).toBe(true);
    expect(panel.getFilterChoice()).toBeNull();
  });

  it('accepts a known region without reporting it back, and marks its button active', () => {
    const panel = mount(new LiveWebcamsPanel());
    const seen = vi.fn();
    panel.onFilterChoiceChange(seen);
    panel.setFilterChoice('europe');
    expect(panel.getFilterChoice()).toBe('europe');
    expect(seen).not.toHaveBeenCalled();
    expect(panel.getElement().querySelector('.webcam-region-btn[data-region="europe"]')?.classList.contains('active')).toBe(true);
  });

  it('ignores a region it does not know, and "all" is the same as null', () => {
    const panel = mount(new LiveWebcamsPanel());
    panel.setFilterChoice('europe');
    panel.setFilterChoice('atlantis');
    expect(panel.getFilterChoice()).toBe('europe');
    panel.setFilterChoice('all');
    expect(panel.getFilterChoice()).toBeNull();
    panel.setFilterChoice('asia');
    panel.setFilterChoice(null);
    expect(panel.getFilterChoice()).toBeNull();
  });

  it('reports a region the user picks', () => {
    const panel = mount(new LiveWebcamsPanel());
    const seen = vi.fn();
    panel.onFilterChoiceChange(seen);
    panel.getElement().querySelector<HTMLButtonElement>('.webcam-region-btn[data-region="asia"]')!.click();
    expect(seen).toHaveBeenLastCalledWith('asia');
    panel.getElement().querySelector<HTMLButtonElement>('.webcam-region-btn[data-region="all"]')!.click();
    // All is a choice the tab keeps, not an absent one.
    expect(seen).toHaveBeenLastCalledWith('all');
  });
});
