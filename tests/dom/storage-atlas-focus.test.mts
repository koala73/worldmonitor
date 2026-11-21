/**
 * "Open in Storage Atlas" from the map popup: PanelLayoutManager.focusStorageFacility
 * must deliver the facility to the atlas whenever it mounts — immediately when it is
 * already on the page, otherwise from the deferred-mount hook, however late that is.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { PanelLayoutManager } from '@/app/panel-layout';
import { Panel } from '@/components/Panel';

const KEY = 'storage-facility-map';

class AtlasStub extends Panel {
  constructor() {
    super({ id: KEY, title: 'Strategic Storage Atlas', collapsible: true });
  }
}

/** Drive the private deferred-mount hook the way mountDeferredPanel's finish() does. */
function mounted(layout: PanelLayoutManager, panel: Panel): void {
  (layout as unknown as { afterPanelMounted(key: string, panel: Panel): void }).afterPanelMounted(KEY, panel);
}

function layoutWith(panels: Record<string, Panel>, options: { destroyed?: boolean } = {}): PanelLayoutManager {
  const layout = Object.create(PanelLayoutManager.prototype) as PanelLayoutManager;
  Reflect.set(layout, 'ctx', {
    isDestroyed: options.destroyed ?? false,
    panels,
    panelSettings: { [KEY]: { enabled: true } },
  });
  Reflect.set(layout, 'pendingStorageFacilityId', null);
  Reflect.set(layout, 'deferredPanelMounts', new Map());
  Reflect.set(layout, 'mountDeferredPanel', () => false);
  Reflect.set(layout, 'observePanelForHydration', () => {});
  Reflect.set(layout, 'scheduleHydrationForPanelElement', () => {});
  Reflect.set(layout, 'callbacks', { primeVisiblePanelData: () => {} });
  return layout;
}

const delivered: string[] = [];
const revealed: string[] = [];
const onDetail = (ev: Event): void => {
  delivered.push((ev as CustomEvent<{ facilityId?: string }>).detail?.facilityId ?? '');
};
const onReveal = (ev: Event): void => {
  revealed.push((ev as CustomEvent<{ panelId?: string }>).detail?.panelId ?? '');
};
const panels: Panel[] = [];

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  delivered.length = 0;
  revealed.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
  window.addEventListener('energy:open-storage-facility-detail', onDetail);
  window.addEventListener('wm:reveal-panel', onReveal);
});

afterEach(() => {
  window.removeEventListener('energy:open-storage-facility-detail', onDetail);
  window.removeEventListener('wm:reveal-panel', onReveal);
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});

function mountedAtlas(): AtlasStub {
  const atlas = new AtlasStub();
  panels.push(atlas);
  document.body.append(atlas.getElement());
  return atlas;
}

describe('focusStorageFacility', () => {
  it('delivers immediately to a mounted atlas, expanding it and lifting a mobile filter', () => {
    const atlas = mountedAtlas();
    expect(atlas.setCollapsed(true).ok).toBe(true);
    const layout = layoutWith({ [KEY]: atlas });

    layout.focusStorageFacility('okoli');

    expect(delivered).toEqual(['okoli']);
    expect(revealed).toEqual([KEY]);
    expect(atlas.isCollapsed()).toBe(false);
    expect(atlas.getElement().scrollIntoView).toHaveBeenCalled();
  });

  it('keeps the request until the deferred atlas mounts, then delivers it once', () => {
    const layout = layoutWith({});

    layout.focusStorageFacility('okoli');
    expect(delivered).toEqual([]);

    const atlas = mountedAtlas();
    mounted(layout, atlas);
    expect(delivered).toEqual(['okoli']);

    mounted(layout, atlas);
    expect(delivered).toEqual(['okoli']);
  });

  it('lets a newer request replace an older one that never mounted', () => {
    const layout = layoutWith({});
    layout.focusStorageFacility('okoli');
    layout.focusStorageFacility('grijpskerk');

    const atlas = mountedAtlas();
    mounted(layout, atlas);
    expect(delivered).toEqual(['grijpskerk']);
  });

  it('does nothing after the layout is destroyed', () => {
    const atlas = mountedAtlas();
    const layout = layoutWith({ [KEY]: atlas }, { destroyed: true });
    layout.focusStorageFacility('okoli');
    expect(delivered).toEqual([]);
  });
});
