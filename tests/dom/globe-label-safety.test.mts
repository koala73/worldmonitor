import { afterEach, expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => ({ labels: new Map<string, (value: unknown) => string>(), done: new Error('labels registered') }));
const polygons = vi.hoisted(() => new Map<string, (value: unknown) => unknown>());
vi.mock('globe.gl', () => ({ default: vi.fn(function () {
    const controls = { addEventListener() {} };
    const proxy = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => {
      if (name === 'controls') return controls;
      if (String(name).startsWith('polygon')) polygons.set(String(name), args[0] as (value: unknown) => unknown);
      if (String(name).endsWith('Label')) {
        capture.labels.set(String(name), args[0] as (value: unknown) => string);
        if (name === 'polygonLabel') throw capture.done;
      }
      return proxy;
    } });
    return proxy;
}) }));
import { GlobeMap } from '@/components/GlobeMap';
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
it('escapes labels registered with globe.gl for routes, paths, and polygons', async () => {
  vi.useFakeTimers();
  const host = Object.create(GlobeMap.prototype);
  host.container = document.createElement('div');
  host.handleContextMenu = () => {};
  await expect(host.initGlobe()).rejects.toBe(capture.done);
  const hostile = '<img src=x onerror="alert(1)">';
  for (const [label, data] of [
    ['arcLabel', { routeName: hostile, volumeDesc: hostile }],
    ['pathLabel', { name: hostile }],
    ['polygonLabel', { _kind: 'cii', name: hostile, score: hostile }],
  ] as const) {
    const element = document.createElement('div');
    element.innerHTML = capture.labels.get(label)!(data);
    expect(element.querySelector('img')).toBeNull();
    expect(element.textContent).toContain(hostile);
  }
  host.unsubscribeGlobeQuality?.();
  host.unsubscribeGlobeTexture?.();
  host.unsubscribeVisualPreset?.();
  host.satHoverStyle?.remove();
});

it('creates stroke-only focus polygons above every conflict cap', async () => {
  vi.useFakeTimers();
  const host = Object.create(GlobeMap.prototype);
  host.container = document.createElement('div');
  host.handleContextMenu = () => {};
  await expect(host.initGlobe()).rejects.toBe(capture.done);
  try {
    const conflictAltitudes = ['high', 'medium', 'low'].map(intensity =>
      polygons.get('polygonAltitude')!({ _kind: 'conflict', intensity }) as number);
    for (const kind of ['focusChosen', 'focusNeighbour']) {
      const data = { _kind: kind };
      // A transparent but truthy colour still creates a raycastable cap.
      expect(polygons.get('polygonCapColor')!(data)).toBeFalsy();
      expect(polygons.get('polygonSideColor')!(data)).toBeFalsy();
      expect(polygons.get('polygonStrokeColor')!(data)).toBeTruthy();
      expect(polygons.get('polygonAltitude')!(data)).toBeGreaterThan(Math.max(...conflictAltitudes));
    }
  } finally {
    host.unsubscribeGlobeQuality?.();
    host.unsubscribeGlobeTexture?.();
    host.unsubscribeVisualPreset?.();
    host.satHoverStyle?.remove();
  }
});
