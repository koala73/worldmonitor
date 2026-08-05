/**
 * `MapPopup` desktop height cache — DOM regression coverage.
 *
 * `positionDesktopPopup` used to append the popup off-screen, read
 * `offsetHeight`, and remove it again — on every popup open, inside the click
 * handler, for all 76 marker call sites across Map.ts, DeckGLMap.ts and
 * GlobeMap.ts. `offsetHeight` forces a synchronous layout of the whole
 * document, so that read landed squarely on the task INP measures.
 *
 * Three defects found in review of the first revision, each pinned below:
 *
 *  - the reconciliation ran in a bare `requestAnimationFrame`, which is NOT
 *    after paint — rAF callbacks run before the frame paints, and INP measures
 *    input→next paint, so the read was still inside the interaction window.
 *    The old test asserted only "not in the click task", which passed while the
 *    defect stood. It now distinguishes the two.
 *  - the rAF closure captured the popup TYPE but read `this.popup`, so a popup
 *    opened in between was measured and filed under the previous type.
 *  - the key is the type, but a `waterway` popup's height varies within that key
 *    (transit chart + HS2 ring are entitlement-gated), so a materially wrong
 *    cached height has to be corrected rather than merely clamped.
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

/** A second, structurally different popup type for the replacement case. */
function weather(x = 100, y = 100) {
  return {
    type: 'weather',
    data: {
      severity: 'Severe',
      event: 'Test Storm',
      headline: 'Test headline',
      areaDesc: 'Test County',
      description: 'Test description',
      expires: new Date('2026-08-06T00:00:00.000Z').toISOString(),
    },
    x,
    y,
  } as unknown as Parameters<MapPopup['show']>[0];
}

function livePopup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.map-popup');
}

/** rAF fires, but the frame has not painted yet. */
function runFrame(): void {
  const queued = rafCallbacks;
  rafCallbacks = [];
  for (const cb of queued) cb(0);
}

/** The post-paint tasks queued by that frame. */
function runAfterPaint(): void {
  vi.advanceTimersByTime(1);
}

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
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

    expect(offsetHeightReads).toBe(0);
  });

  it('still positions the reopened popup', () => {
    popup.show(quake());
    popup.show(quake(200, 300));

    const el = livePopup();
    expect(el).not.toBeNull();
    expect(el?.style.top).toMatch(/^-?\d+(\.\d+)?px$/);
    expect(el?.style.left).toMatch(/^-?\d+(\.\d+)?px$/);
    expect(el?.style.left).not.toBe('-9999px');
    expect(el?.style.visibility).not.toBe('hidden');
  });

  it('defers the re-measure past PAINT, not merely past the click task', () => {
    popup.show(quake());
    offsetHeightReads = 0;

    expect(rafCallbacks.length).toBeGreaterThan(0);
    expect(offsetHeightReads).toBe(0);

    // rAF runs BEFORE this frame paints — INP is still measuring here, so the
    // layout read must not happen yet.
    runFrame();
    expect(offsetHeightReads).toBe(0);

    // Only once the frame has painted does the reconciliation read layout.
    runAfterPaint();
    expect(offsetHeightReads).toBeGreaterThan(0);
  });

  it('does not file a replacement popup height under the previous type', () => {
    // Open A, then replace it with B before A's reconciliation runs. show()
    // builds a fresh element, so an element-blind callback would measure B and
    // store it under A's type.
    popup.show(quake());
    heightCache().clear();

    popup.show(weather(300, 300));
    runFrame();
    runAfterPaint();

    // Only the live popup's own type may be written by the reconciliation.
    expect(heightCache().has('earthquake')).toBe(false);
  });

  it('repositions when the measured height drifts from the cached one', () => {
    // A wildly wrong cached height stands in for within-type layout variance
    // (waterway popups gate a transit chart and HS2 ring on entitlement).
    heightCache().set('earthquake', 860);

    popup.show(quake(100, 100));
    const positionedFromCache = livePopup()?.style.top;

    runFrame();
    runAfterPaint();

    const afterReconciliation = livePopup()?.style.top;
    expect(afterReconciliation).not.toBe(positionedFromCache);
    expect(heightCache().get('earthquake')).toBe(MEASURED_HEIGHT);
  });

  it('converges a stale cache entry on the post-paint re-measure', () => {
    heightCache().set('earthquake', 9999);

    popup.show(quake());
    runFrame();
    runAfterPaint();

    expect(heightCache().get('earthquake')).toBe(MEASURED_HEIGHT);
  });
});
