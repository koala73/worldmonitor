/**
 * #11157: the globe's own controls (time range, layer list, zoom buttons) sit
 * inside the globe container. Holding or right-clicking one must not open the
 * map's point lookup, matching the 2D phone map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('globe.gl', () => ({ default: vi.fn() }));
import { GlobeMap } from '@/components/GlobeMap';

type Host = {
  container: HTMLElement;
  globe: unknown;
  onMapContextMenuCb: (payload: unknown) => void;
  installContextMenu(): void;
  whenReady(): Promise<void>;
};

const touch = (type: string, x: number, y: number) =>
  new PointerEvent(type, { pointerType: 'touch', pointerId: 1, clientX: x, clientY: y, bubbles: true });

function globeWithControls() {
  const host = document.createElement('div');
  document.body.append(host);
  const state = { layers: {}, timeRange: '7d', view: 'global', zoom: 1, pan: { x: 0, y: 0 } };
  const map = new GlobeMap(host, state as unknown as ConstructorParameters<typeof GlobeMap>[1]) as unknown as Host;
  map.whenReady().catch(() => {});
  map.globe = { toGlobeCoords: () => ({ lat: 10, lng: 20 }) };
  const lookups = vi.fn();
  map.onMapContextMenuCb = lookups;
  map.installContextMenu();
  const slider = document.createElement('div');
  slider.className = 'time-slider globe-time-slider';
  const timeBtn = document.createElement('button');
  timeBtn.className = 'time-btn';
  slider.append(timeBtn);
  const toggles = document.createElement('div');
  toggles.className = 'layer-toggles';
  const row = document.createElement('label');
  row.className = 'layer-toggle';
  toggles.append(row);
  const surface = document.createElement('div');
  host.append(slider, toggles, surface);
  return { map, lookups, timeBtn, row, surface };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('globe point lookup over its own controls', () => {
  it('ignores a long press on a time button or a layer row, but opens on the globe', () => {
    vi.useFakeTimers();
    const { lookups, timeBtn, row, surface } = globeWithControls();
    for (const el of [timeBtn, row]) {
      el.dispatchEvent(touch('pointerdown', 50, 50));
      vi.advanceTimersByTime(700);
      el.dispatchEvent(touch('pointerup', 50, 50));
    }
    expect(lookups).not.toHaveBeenCalled();
    surface.dispatchEvent(touch('pointerdown', 50, 50));
    vi.advanceTimersByTime(700);
    expect(lookups).toHaveBeenCalledOnce();
  });

  it('ignores a right-click on a control, but opens on the globe', () => {
    const { lookups, timeBtn, row, surface } = globeWithControls();
    for (const el of [timeBtn, row]) {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    }
    expect(lookups).not.toHaveBeenCalled();
    surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    expect(lookups).toHaveBeenCalledOnce();
  });
});
