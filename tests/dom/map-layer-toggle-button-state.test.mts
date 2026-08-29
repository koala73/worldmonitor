/**
 * `MapComponent.toggleLayer` must move the chip's own state classes.
 *
 * The chip markup is a `.layer-toggle-row[data-layer]` wrapper around a
 * `button.layer-toggle[data-layer]`, so an unqualified
 * `container.querySelector('[data-layer="…"]')` resolves the ROW — an ancestor
 * precedes its descendant in document order. The class then lands somewhere
 * with no styling and no readers, and the button keeps whatever state it was
 * born with: a layer the user switched off stays lit forever.
 *
 * It is not only cosmetic. `createLayerToggles`'s `enforceLayerLimit` counts
 * `.layer-toggle.active` buttons to enforce MAX_SVG_LAYERS, so a stale class
 * also feeds the wrong active count into the layer cap.
 *
 * These tests drive the real `toggleLayer` over the real `createLayerToggles`
 * markup. A fixture that rebuilt the row by hand could not catch a change to
 * the component's own DOM shape.
 */
import { describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';
import type { MapLayers } from '@/types';

// Standalone rather than `MapComponent & …`: `container` is private on the
// class, so intersecting the two reduces the whole type to `never`.
type LayerPicker = {
  canToggleLayer: () => boolean;
  container: HTMLElement;
  createLayerToggles: () => HTMLElement;
  layerZoomOverrides: Record<string, boolean>;
  scheduleRender: () => void;
  state: { layers: Partial<MapLayers>; zoom: number };
  toggleLayer: (layer: keyof MapLayers, source?: 'user' | 'programmatic') => void;
};

/**
 * Builds the picker through the component's own DOM builder, on a prototype
 * instance so the constructor's d3/ResizeObserver/network work stays out of it.
 */
function createPicker(layers: Partial<MapLayers>): LayerPicker {
  const map = Object.create(MapComponent.prototype) as unknown as LayerPicker;
  map.container = document.createElement('div');
  map.state = { layers: { ...layers }, zoom: 4 };
  map.layerZoomOverrides = {};
  map.canToggleLayer = () => true;
  map.scheduleRender = vi.fn();
  map.container.appendChild(map.createLayerToggles());
  document.body.append(map.container);
  return map;
}

const chip = (map: LayerPicker, layer: string): HTMLButtonElement => {
  const button = map.container.querySelector<HTMLButtonElement>(
    `button.layer-toggle[data-layer="${layer}"]`,
  );
  if (!button) throw new Error(`no chip rendered for layer "${layer}"`);
  return button;
};

describe('MapComponent.toggleLayer chip state', () => {
  it('renders the row-wrapping-button shape the selector has to cope with', () => {
    const map = createPicker({ conflicts: true });
    const button = chip(map, 'conflicts');

    // Guards the premise: if the wrapper ever stops carrying data-layer, the
    // bug these tests lock down is gone and they should be revisited, not
    // silently kept passing for the wrong reason.
    expect(button.closest('.layer-toggle-row')?.getAttribute('data-layer')).toBe('conflicts');
    expect(map.container.querySelector('[data-layer="conflicts"]')).not.toBe(button);
  });

  it('clears active on the chip when a static layer is switched off', () => {
    const map = createPicker({ conflicts: true });
    expect(chip(map, 'conflicts').classList.contains('active')).toBe(true);

    map.toggleLayer('conflicts');

    expect(map.state.layers.conflicts).toBe(false);
    expect(chip(map, 'conflicts').classList.contains('active')).toBe(false);
  });

  it('sets active on the chip when a static layer is switched on', () => {
    const map = createPicker({ conflicts: false });
    expect(chip(map, 'conflicts').classList.contains('active')).toBe(false);

    map.toggleLayer('conflicts');

    expect(map.state.layers.conflicts).toBe(true);
    expect(chip(map, 'conflicts').classList.contains('active')).toBe(true);
  });

  it('parks an async layer in loading, then clears both classes when switched off', () => {
    const map = createPicker({ natural: false });

    map.toggleLayer('natural');
    expect(chip(map, 'natural').classList.contains('loading')).toBe(true);
    expect(chip(map, 'natural').classList.contains('active')).toBe(false);

    map.toggleLayer('natural');
    expect(chip(map, 'natural').classList.contains('loading')).toBe(false);
    expect(chip(map, 'natural').classList.contains('active')).toBe(false);
  });

  it('keeps the wrapper row free of the chip state classes', () => {
    // Switching an async layer ON is the only path that ADDS a class, so it is
    // the one that can catch the class landing on the wrapper. Asserting over a
    // path that only ever removes classes would pass with the bug in place.
    const map = createPicker({ natural: false });
    const row = chip(map, 'natural').closest('.layer-toggle-row')!;

    map.toggleLayer('natural');

    expect(row.classList.contains('loading')).toBe(false);
    expect(row.classList.contains('active')).toBe(false);
  });

  it('leaves an accurate active count for the layer cap to read', () => {
    const map = createPicker({ conflicts: true, nuclear: true, sanctions: false });
    const activeChips = () =>
      map.container.querySelectorAll('button.layer-toggle.active').length;

    const before = activeChips();
    map.toggleLayer('conflicts');
    expect(activeChips()).toBe(before - 1);

    map.toggleLayer('sanctions');
    expect(activeChips()).toBe(before);
  });
});
