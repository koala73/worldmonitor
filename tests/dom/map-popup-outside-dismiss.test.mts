/**
 * #11022: a tap outside an open map popup closes it, however soon after the
 * popup opened. The outside listener used to be attached in a setTimeout, and
 * Chromium runs queued input ahead of timers on a busy main thread, so a quick
 * outside tap could arrive before the listener existed and be lost. The
 * gesture that opened the popup, including its trailing click, must still not
 * close it.
 *
 * Timers are faked and never advanced: every assertion holds before any
 * timer could run, which is the starved main thread.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MapPopup } from '@/components/MapPopup';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);

const realInnerWidth = window.innerWidth;
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setViewportWidth(realInnerWidth);
  document.body.innerHTML = '';
});

const HOTSPOT = { id: 'h1', name: 'Test Hotspot', lat: 1, lon: 2, keywords: [], level: 'high', subtext: '' } as never;

const fire = (target: EventTarget, type: string) => {
  // The sheet's own touch handlers read `touches`; a plain Event has none.
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), type.startsWith('touch') ? { touches: [] } : {});
  target.dispatchEvent(event);
};

/** A finger tap, in the order a phone browser dispatches it. */
const touchTap = (target: EventTarget) => ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'click'].forEach((t) => fire(target, t));
/** A mouse click. */
const mouseClick = (target: EventTarget) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => fire(target, t));

type Opener = 'click' | 'pointerup';

/** A marker that opens the popup from `opener`, as the SVG map (click) and deck.gl (pointerup) do. */
function mountMarkerAndPopup(opener: Opener = 'click'): { popup: MapPopup; marker: HTMLElement; outside: HTMLElement } {
  const container = document.createElement('div');
  const marker = document.createElement('button');
  const outside = document.createElement('div');
  container.append(marker, outside);
  document.body.appendChild(container);
  const popup = new MapPopup(container);
  marker.addEventListener(opener, () => popup.show({ type: 'hotspot', data: HOTSPOT, x: 10, y: 10 }));
  return { popup, marker, outside };
}

const popupCount = () => document.querySelectorAll('.map-popup').length;

for (const { label, width, tap } of [
  { label: 'phone sheet', width: 375, tap: touchTap },
  { label: 'desktop popup', width: 1280, tap: mouseClick },
] as const) {
  describe(label, () => {
    beforeEach(() => setViewportWidth(width));

    for (const opener of ['click', 'pointerup'] as const) {
      it(`stays open through the whole gesture that opened it from ${opener}`, () => {
        const { marker } = mountMarkerAndPopup(opener);
        tap(marker);
        expect(popupCount()).toBe(1);
      });

      it(`closes on an outside tap right after opening from ${opener}`, () => {
        const { marker, outside } = mountMarkerAndPopup(opener);
        tap(marker);
        expect(popupCount()).toBe(1);
        tap(outside);
        expect(popupCount()).toBe(0);
      });
    }

    it('stays open when the tap lands inside the popup', () => {
      const { marker } = mountMarkerAndPopup();
      tap(marker);
      tap(document.querySelector('.map-popup .popup-body')!);
      expect(popupCount()).toBe(1);
    });

    it('closes on Escape right after opening', () => {
      const { marker } = mountMarkerAndPopup();
      tap(marker);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(popupCount()).toBe(0);
    });

    it('removes every document listener it added once closed', () => {
      const { popup, marker } = mountMarkerAndPopup();
      const key = (type: string, fn: unknown, opts: unknown) =>
        `${type}|${typeof opts === 'boolean' ? opts : Boolean((opts as AddEventListenerOptions | undefined)?.capture)}|${String(fn)}`;
      const added = new Map<string, unknown>();
      const removed = new Set<string>();
      vi.spyOn(document, 'addEventListener').mockImplementation(function (this: Document, type, fn, opts) {
        added.set(key(type, fn, opts), fn);
        return EventTarget.prototype.addEventListener.call(this, type, fn, opts);
      });
      vi.spyOn(document, 'removeEventListener').mockImplementation(function (this: Document, type, fn, opts) {
        if (added.get(key(type, fn, opts)) === fn) removed.add(key(type, fn, opts));
        return EventTarget.prototype.removeEventListener.call(this, type, fn, opts);
      });
      tap(marker);
      expect(added.size).toBeGreaterThan(0);
      popup.hide();
      expect([...added.keys()].filter((k) => !removed.has(k))).toEqual([]);
    });

    for (const opener of ['click', 'pointerup'] as const) {
      it(`replaces the open popup when another marker opens one from ${opener}`, () => {
        const { popup, marker, outside } = mountMarkerAndPopup(opener);
        const second = document.createElement('button');
        marker.after(second);
        second.addEventListener(opener, () => popup.show({ type: 'hotspot', data: { ...(HOTSPOT as object), id: 'h2', name: 'Second Hotspot' } as never, x: 20, y: 20 }));
        tap(marker);
        tap(second);
        expect(popupCount()).toBe(1);
        expect(document.querySelector('.map-popup .popup-title')?.textContent).toMatch(/second hotspot/i);
        tap(outside);
        expect(popupCount()).toBe(0);
      });
    }

    it('closes on an outside click activated from the keyboard', () => {
      const { marker, outside } = mountMarkerAndPopup();
      tap(marker);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      fire(outside, 'click');
      expect(popupCount()).toBe(0);
    });

    it('closes on a click with no press before it once the fallback timer has run', () => {
      const { marker, outside } = mountMarkerAndPopup();
      tap(marker);
      vi.runAllTimers();
      fire(outside, 'click');
      expect(popupCount()).toBe(0);
    });
  });
}

describe('phone sheet outside touchstart alone', () => {
  it('closes as soon as an outside finger lands', () => {
    setViewportWidth(375);
    const { marker, outside } = mountMarkerAndPopup();
    touchTap(marker);
    fire(outside, 'touchstart');
    expect(popupCount()).toBe(0);
  });
});

describe('route breakdown popup', () => {
  beforeEach(() => setViewportWidth(1280));

  function mountRouteBreakdown(): { outside: HTMLElement; marker: HTMLElement } {
    const container = document.createElement('div');
    const marker = document.createElement('div');
    const outside = document.createElement('div');
    container.append(marker, outside);
    document.body.appendChild(container);
    const popup = new MapPopup(container);
    // deck.gl opens it from a pointerup on the route; the native click trails.
    marker.addEventListener('pointerup', () => popup.showRouteBreakdown({ id: 'r1', name: 'Test Route' } as never, [], 10, 10));
    return { outside, marker };
  }

  it('stays open through the click that trails the opening pointerup', () => {
    const { marker } = mountRouteBreakdown();
    mouseClick(marker);
    expect(document.querySelectorAll('.map-popup-route-breakdown')).toHaveLength(1);
  });

  it('closes on the next outside click', () => {
    const { marker, outside } = mountRouteBreakdown();
    mouseClick(marker);
    mouseClick(outside);
    expect(document.querySelectorAll('.map-popup-route-breakdown')).toHaveLength(0);
  });

  it('closes on an outside tap', () => {
    const { marker, outside } = mountRouteBreakdown();
    mouseClick(marker);
    touchTap(outside);
    expect(document.querySelectorAll('.map-popup-route-breakdown')).toHaveLength(0);
  });

  it('closes on Escape', () => {
    const { marker } = mountRouteBreakdown();
    mouseClick(marker);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelectorAll('.map-popup-route-breakdown')).toHaveLength(0);
  });
});
