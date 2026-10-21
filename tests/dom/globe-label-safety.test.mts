import { afterEach, expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => ({ labels: new Map<string, (value: unknown) => string>(), done: new Error('labels registered') }));
vi.mock('globe.gl', () => ({ default: vi.fn(function () {
    const controls = { addEventListener() {} };
    const proxy = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => {
      if (name === 'controls') return controls;
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
