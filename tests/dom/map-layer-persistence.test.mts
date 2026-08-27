/**
 * The persistence proof behind the WebMCP cancellation gate (#7186).
 *
 * `WEBMCP_TOOL_CANCELLATION_POLICY` classifies `set_map_layers` as
 * 'silently-persistent' — the sole reason the tool is refused outright when the
 * browser cannot deliver a target-side AbortSignal. That justification rests on
 * one concrete claim: applying a map-layer change writes STORAGE_KEYS.mapLayers
 * to local storage, so a phantom completion outlives the session.
 *
 * Nothing exercised that claim. `tests/webmcp*.test.mjs` stub
 * `applyDashboardAction`, so they prove the gate's plumbing and never reach the
 * write. This runs the real `EventHandlerManager.applyMapLayerChange` against
 * the real `saveToStorage` and the real happy-dom `localStorage`: delete the
 * `saveToStorage(STORAGE_KEYS.mapLayers, …)` line in event-handlers.ts and
 * every assertion below goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventHandlerManager } from '@/app/event-handlers';
import { STORAGE_KEYS } from '@/config';

function createManager(mapLayers: Record<string, boolean>) {
  const container = document.createElement('div');
  document.body.append(container);
  return new EventHandlerManager({
    container,
    isDesktopApp: false,
    panels: {},
    panelSettings: {},
    mapLayers,
  } as never, {
    loadDataForLayer: vi.fn(),
    clearLayerData: vi.fn(),
  } as never);
}

describe('applyMapLayerChange persists map layers', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('writes the updated layer set to STORAGE_KEYS.mapLayers', () => {
    const mapLayers = { conflicts: false };
    const manager = createManager(mapLayers);

    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    manager.applyMapLayerChange('conflicts' as never, true, 'programmatic');

    // The stored value — not merely "storage was touched". A write of the
    // pre-change object, or of the wrong key, fails here.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ conflicts: true });

    manager.destroy();
  });

  it('leaves the write behind after the invocation returns, with nothing to cancel', () => {
    // This is the property the gate exists for: the tool has no undo. Toggling
    // off writes again rather than restoring the pre-invocation storage state,
    // so an uncancellable invocation is not recoverable by putting the map back.
    const manager = createManager({ conflicts: true, protests: false });

    manager.applyMapLayerChange('protests' as never, true, 'programmatic');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ conflicts: true, protests: true });

    manager.applyMapLayerChange('protests' as never, false, 'programmatic');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ conflicts: true, protests: false });

    manager.destroy();
  });
});
