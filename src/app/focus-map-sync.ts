import type { ResolvedScope } from '@/services/tab-focus';

/** The chosen countries (solid outline) and their neighbours (lighter outline). */
export interface FocusMapOutline {
  chosen: readonly string[];
  neighbours: readonly string[];
}

/** The part of MapContainer the focus drives. */
export interface FocusMapTarget {
  setFocusScope(focus: FocusMapOutline | null, options: { fit: boolean }): void;
}

/**
 * Keeps the map in step with the active tab's focus (#10453): the chosen
 * countries outlined solid, neighbours lighter, and the view fitted to the
 * chosen countries. Markers are never filtered; the map is context.
 *
 * When the map moves:
 * - a focus is set, or its chosen countries change (an edit, a switch to a
 *   tab focused elsewhere, a reload of a focused tab): fit;
 * - only the dates or the neighbours switch change: outline only, so a
 *   pan the user made since stays;
 * - the focus is cleared: the outline goes, the view stays where it is.
 *
 * Team dashboards: a shared dashboard stores the analyst's map view (centre
 * and zoom). On open, and on "update from team", that saved view wins over
 * the focus fit, because the analyst framed it deliberately; the outline
 * still draws. PanelLayoutManager wraps those paths in `keepMapView`.
 *
 * The fit itself is queued by MapContainer, which also drops it when the
 * user moves the map, or a later viewport command lands, before it runs.
 */
export class FocusMapSync {
  private map: FocusMapTarget | null = null;
  private current: ResolvedScope | null = null;
  /** Sorted chosen countries of the last focus seen, fitted or held. */
  private lastChosenKey: string | null = null;
  /** A fit decided before the map existed, applied on attach. */
  private pendingFit = false;
  private holdDepth = 0;

  onScopeChanged(resolved: ResolvedScope | null): void {
    this.current = resolved;
    const key = resolved ? [...resolved.chosen].sort().join(',') : null;
    const changed = key !== this.lastChosenKey;
    this.lastChosenKey = key;
    const fit = !!resolved && changed && this.holdDepth === 0;
    if (!this.map) {
      if (!resolved || this.holdDepth > 0) this.pendingFit = false;
      else if (fit) this.pendingFit = true;
      return;
    }
    this.map.setFocusScope(outlineOf(resolved), { fit });
  }

  /** Called once the map exists; applies the focus that arrived before it. */
  attachMap(map: FocusMapTarget): void {
    this.map = map;
    const fit = this.pendingFit;
    this.pendingFit = false;
    if (this.current) map.setFocusScope(outlineOf(this.current), { fit });
  }

  /**
   * Run `fn` (which restores a team dashboard's focus and then applies its
   * stored map view) so that any focus change inside it outlines without
   * fitting. See the class comment for why the stored view wins.
   */
  keepMapView<T>(fn: () => T): T {
    this.holdDepth += 1;
    try {
      return fn();
    } finally {
      this.holdDepth -= 1;
    }
  }
}

function outlineOf(resolved: ResolvedScope | null): FocusMapOutline | null {
  return resolved ? { chosen: [...resolved.chosen], neighbours: [...resolved.neighbours] } : null;
}
