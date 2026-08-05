/**
 * `MapPopup` desktop height cache — DOM regression coverage.
 *
 * `positionDesktopPopup` used to append the popup off-screen, read
 * `offsetHeight`, and remove it again — on every popup open, inside the click
 * handler, for all 76 marker call sites across Map.ts, DeckGLMap.ts and
 * GlobeMap.ts. `offsetHeight` forces a synchronous layout of the whole
 * document, so that read landed squarely on the task INP measures.
 *
 * The fix caches the measured height per popup type. What matters is not that
 * "a height is used" but that the SECOND popup of a type performs NO layout read
 * during `show()`. These tests count reads through a patched `offsetHeight`
 * getter, which is the only way to observe the property that actually costs.
 *
 * The post-paint `requestAnimationFrame` re-measure is asserted separately: it
 * must happen (so a stale entry converges) and it must NOT happen inside the
 * click task (so it cannot be traded back into the interaction).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MapPopup } from '@/components/MapPopup';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const MEASURED_HEIGHT = 240;

let popup: MapPopup;
let container: HTMLElement;
let offsetHeightReads = 0;
let originalOffsetHeight: PropertyDescriptor | undefined;
let rafCallbacks: FrameRequestCallback[] = [];

/** The private static cache; cleared per test so cold/warm paths stay explicit. */
function heightCache(): Map<string, number> {
  return (MapPopup as unknown as { heightByType: Map<string, number> }).heightByType;
}

function quake(x = 100, y = 100) {
  return {
    type: 'earthquake',
    data: {
      magnitude: 5.4,
      place: 'Test Ridge',
      depthKm: 12.5,
      occurredAt: new Date('2026-08-05T00:00:00.000Z').toISOString(),
    },
    x,
    y,
  } as unknown as Parameters<MapPopup['show']>[0];
}

beforeEach(() => {
  // Desktop: isMobileDevice() is innerWidth <= 768, and the mobile sheet path
  // skips positioning entirely — a mobile viewport would make these vacuous.
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });

  originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(): number {
      offsetHeightReads++;
      return MEASURED_HEIGHT;
    },
  });

  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });

  heightCache().clear();
  offsetHeightReads = 0;

  container = document.createElement('div');
  document.body.appendChild(container);
  popup = new MapPopup(container);
});

afterEach(() => {
  popup.hide();
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  }
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  heightCache().clear();
});

describe('MapPopup desktop height cache', () => {
  it('measures on the first popup of a type and records it', () => {
    popup.show(quake());

    expect(offsetHeightReads).toBeGreaterThan(0);
    expect(heightCache().get('earthquake')).toBe(MEASURED_HEIGHT);
  });

  it('performs NO layout read when reopening the same popup type', () => {
    popup.show(quake());
    expect(heightCache().has('earthquake')).toBe(true);

    offsetHeightReads = 0;
    popup.show(quake(200, 300));

    // The whole point: the warm click path never touches offsetHeight.
    expect(offsetHeightReads).toBe(0);
  });

  it('still positions the reopened popup', () => {
    popup.show(quake());
    popup.show(quake(200, 300));

    const el = document.querySelector<HTMLElement>('.map-popup');
    expect(el).not.toBeNull();
    expect(el?.style.top).toMatch(/^-?\d+(\.\d+)?px$/);
    expect(el?.style.left).toMatch(/^-?\d+(\.\d+)?px$/);
    // Never parked at the off-screen measuring position.
    expect(el?.style.left).not.toBe('-9999px');
    expect(el?.style.visibility).not.toBe('hidden');
  });

  it('defers the re-measure to a frame callback, not the click task', () => {
    popup.show(quake());
    offsetHeightReads = 0;

    // A frame was scheduled, and nothing was read yet.
    expect(rafCallbacks.length).toBeGreaterThan(0);
    expect(offsetHeightReads).toBe(0);

    for (const cb of rafCallbacks) cb(0);

    // Now the correction runs — off the interaction critical path.
    expect(offsetHeightReads).toBeGreaterThan(0);
  });

  it('converges a stale cache entry on the post-paint re-measure', () => {
    heightCache().set('earthquake', 9999);

    popup.show(quake());
    for (const cb of rafCallbacks) cb(0);

    expect(heightCache().get('earthquake')).toBe(MEASURED_HEIGHT);
  });
});
