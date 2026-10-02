import type { MapLayers } from '@/types';

export interface ZoomHintInputs {
  zoom: number;
  layers: MapLayers;
}

/**
 * Guard that suppresses unchanged map-control zoom-hint scans (#7776).
 *
 * `updateZoomHints()` runs on every `updateLayers()` pass — including the
 * trade-animation's every-other-frame `render()` — but a hint pass only needs
 * to touch the DOM when its visibility inputs or its DOM rows changed:
 *
 *   - `zoom`: feeds `isLayerVisible()` via the per-layer minZoom thresholds,
 *     so crossing a threshold flips `zoomHidden` for gated rows.
 *   - `layers`: enabled/disabled state flips `zoomHidden` directly, and a
 *     disabled layer must not retain an enabled-layer zoom warning.
 *   - rows: locale or layout reconstruction replaces the row nodes, so fresh
 *     nodes must invalidate the guard even when zoom/layer values match.
 *     Any innerHTML rebuild replaces every child, so first-child identity
 *     plus child count detects rebuilds and row add/remove without a DOM
 *     query; the suppressed path is three property reads and pure-JS flag
 *     compares, with zero selector queries or class toggles.
 *
 * Zoom alone is not a complete invalidation key: a layer flip at a constant
 * zoom changes hints, so both zoom and the full layer-flag set are keyed.
 */
export class ZoomHintGuard {
  private lastZoom: number | null = null;
  private lastLayers: MapLayers | null = null;
  private lastToggleList: Element | null = null;
  private lastChildCount = -1;
  private lastFirstChild: Element | null = null;

  invalidate(): void {
    this.lastZoom = null;
    this.lastLayers = null;
    this.lastToggleList = null;
    this.lastChildCount = -1;
    this.lastFirstChild = null;
  }

  shouldScan(inputs: ZoomHintInputs, toggleList: Element): boolean {
    if (this.lastZoom !== inputs.zoom) return true;
    if (!this.lastLayers || !sameLayerFlags(this.lastLayers, inputs.layers)) return true;
    if (this.lastToggleList !== toggleList) return true;
    // Rebuilt rows are fresh nodes without hint classes even when the key
    // set is unchanged (locale/layout reconstruction). A rebuild replaces
    // every child, so first-child identity catches it; the count catches
    // added/removed rows. Both are property reads, not selector queries.
    if (toggleList.childElementCount !== this.lastChildCount) return true;
    if (toggleList.firstElementChild !== this.lastFirstChild) return true;
    return false;
  }

  markScanned(inputs: ZoomHintInputs, toggleList: Element): void {
    this.lastZoom = inputs.zoom;
    this.lastLayers = { ...inputs.layers };
    this.lastToggleList = toggleList;
    this.lastChildCount = toggleList.childElementCount;
    this.lastFirstChild = toggleList.firstElementChild;
  }
}

function sameLayerFlags(a: MapLayers, b: MapLayers): boolean {
  const keysA = Object.keys(a) as (keyof MapLayers)[];
  const keysB = Object.keys(b) as (keyof MapLayers)[];
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}
