/**
 * #4547: on mobile, label-overlap thinning is deferred until the first direct
 * map interaction (the #4541 optimisation). A layout change before that
 * interaction — rotating the device, entering split view — re-laid the
 * overlays out via the ResizeObserver → render → applyTransform() path, but
 * that path skips thinning while disarmed, so labels sat stacked on the new
 * geometry until the user touched the map.
 *
 * `onContainerResized` is exercised on a prototype instance (the pattern from
 * map-layer-toggle-button-state) so the constructor's d3/ResizeObserver/network
 * work stays out of it; the collaborators it reaches are stubbed and asserted.
 */
import { describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';

type ResizeSurface = {
  isMobile: boolean;
  isResizing: boolean;
  mobileLabelVisibilityArmed: boolean;
  observedContainerWidth: number;
  observedContainerHeight: number;
  rememberContainerSize: ReturnType<typeof vi.fn>;
  scheduleRender: ReturnType<typeof vi.fn>;
  updateLabelVisibility: ReturnType<typeof vi.fn>;
  onContainerResized: (width: number, height: number) => void;
  shouldUpdateLabelVisibility: () => boolean;
};

function createMap(isMobile: boolean): ResizeSurface {
  const map = Object.create(MapComponent.prototype) as unknown as ResizeSurface;
  map.isMobile = isMobile;
  map.isResizing = false;
  // Mirrors the constructor: desktop measures from the start, mobile defers.
  map.mobileLabelVisibilityArmed = !isMobile;
  map.observedContainerWidth = 0;
  map.observedContainerHeight = 0;
  map.rememberContainerSize = vi.fn();
  map.scheduleRender = vi.fn();
  map.updateLabelVisibility = vi.fn();
  return map;
}

describe('mobile label thinning re-arms on a post-paint layout change (#4547)', () => {
  it('the first observation is the initial paint and must not arm', () => {
    const map = createMap(true);
    map.onContainerResized(360, 640);

    expect(map.mobileLabelVisibilityArmed).toBe(false);
    expect(map.shouldUpdateLabelVisibility()).toBe(false);
    expect(map.rememberContainerSize).toHaveBeenCalledWith({ width: 360, height: 640 });
    expect(map.scheduleRender).toHaveBeenCalledTimes(1);
  });

  it('a height-only change (mobile URL bar) must not arm', () => {
    const map = createMap(true);
    map.onContainerResized(360, 640);
    map.onContainerResized(360, 560);

    expect(map.mobileLabelVisibilityArmed).toBe(false);
    expect(map.scheduleRender).toHaveBeenCalledTimes(2);
  });

  it('a width change after first paint arms thinning and leaves the pass to the scheduled render', () => {
    const map = createMap(true);
    map.onContainerResized(360, 640);
    map.onContainerResized(640, 360); // rotation

    expect(map.mobileLabelVisibilityArmed).toBe(true);
    expect(map.shouldUpdateLabelVisibility()).toBe(true);
    // applyTransform() inside the scheduled render owns the measurement; the
    // resize path must not add a second, synchronous pass.
    expect(map.updateLabelVisibility).not.toHaveBeenCalled();
    expect(map.scheduleRender).toHaveBeenCalledTimes(2);
  });

  it('a hide/reveal cycle is not a layout change', () => {
    const map = createMap(true);
    map.onContainerResized(360, 640);
    map.onContainerResized(0, 0); // tab hidden
    map.onContainerResized(360, 640); // revealed at the same size

    expect(map.mobileLabelVisibilityArmed).toBe(false);
    // The hide is recorded (getKnownContainerSize() must see the zero) but
    // never rendered.
    expect(map.rememberContainerSize).toHaveBeenCalledWith({ width: 0, height: 0 });
    expect(map.scheduleRender).toHaveBeenCalledTimes(2);
  });

  it('a repeated identical observation is a no-op', () => {
    const map = createMap(true);
    map.onContainerResized(360, 640);
    map.onContainerResized(360, 640);

    expect(map.rememberContainerSize).toHaveBeenCalledTimes(1);
    expect(map.scheduleRender).toHaveBeenCalledTimes(1);
  });

  it('desktop stays armed throughout, so nothing changes there', () => {
    const map = createMap(false);
    map.onContainerResized(1280, 800);
    map.onContainerResized(1024, 800);

    expect(map.mobileLabelVisibilityArmed).toBe(true);
    expect(map.shouldUpdateLabelVisibility()).toBe(true);
    expect(map.scheduleRender).toHaveBeenCalledTimes(2);
  });
});
