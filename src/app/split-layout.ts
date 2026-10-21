// Single source of truth for the split (map-beside-panels) dashboard layout.
// Keep this module zero-import so tsx-run tests can load it directly.
//
// CSS media queries cannot read these constants, so the split blocks in
// src/styles/main.css and src/styles/panels.css repeat the numbers as
// literals; tests/responsive-zone-listener.test.mjs asserts they stay
// aligned with this module. Change the values here first.

/** Viewport width (CSS px) at which the dashboard switches from the stacked
 * layout (map band above the panel grid) to the split layout (map column
 * beside the panels). Shared by web and the desktop app — issue #6417. */
export const SPLIT_LAYOUT_MIN_WIDTH = 900;

/** Former web-only split threshold. It remains only to bound migration of the
 * legacy shared map-height preference to users who could have set it while
 * the web dashboard was split. */
export const LEGACY_WEB_SPLIT_LAYOUT_MIN_WIDTH = 1600;

export type MapVisualSide = 'left' | 'right';

/** Whether the logical `.map-right` grid class represents a requested visual
 * side. RTL mirrors the grid, so visual right uses the default column. */
export function mapRightClassForVisualSide(side: MapVisualSide, isRtl: boolean): boolean {
  return (side === 'right') !== isRtl;
}

/** Resolves the physical side shown to the user from the logical grid class. */
export function getVisualMapSide(hasMapRightClass: boolean, isRtl: boolean): MapVisualSide {
  return hasMapRightClass !== isRtl ? 'right' : 'left';
}

/** Lower bound of the map column, as a percentage of the split container. */
export const MAP_COL_MIN_PERCENT = 10;

/** Upper bound of the map column, as a percentage of the split container. */
export const MAP_COL_MAX_PERCENT = 75;

/** Absolute pixel floor for the map column: below this the map header
 * actions (2D/3D toggle, fullscreen, pin) and the zoom controls collide. */
export const MAP_COL_MIN_PX = 220;

/** Pixel floor reserved for the panels column so one `minmax(280px, 1fr)`
 * grid track plus its scrollbar always fits beside the map. */
export const PANELS_COL_MIN_PX = 300;

/** Width of the draggable divider between the map and panel columns. */
export const MAP_COL_DIVIDER_PX = 6;

/** Map column width applied when no stored preference exists. */
export const MAP_COL_DEFAULT_PERCENT = 60;

export interface MapColWidthBounds {
  minPct: number;
  maxPct: number;
}

/** Effective percentage bounds for the map column at a given container
 * width: the percentage bounds tightened by the pixel floors on each side. */
export function getMapColWidthBounds(totalWidthPx: number): MapColWidthBounds {
  if (!Number.isFinite(totalWidthPx) || totalWidthPx <= 0) {
    return { minPct: MAP_COL_MIN_PERCENT, maxPct: MAP_COL_MAX_PERCENT };
  }
  const minPct = Math.max(MAP_COL_MIN_PERCENT, (MAP_COL_MIN_PX / totalWidthPx) * 100);
  const maxPct = Math.min(
    MAP_COL_MAX_PERCENT,
    ((totalWidthPx - PANELS_COL_MIN_PX - MAP_COL_DIVIDER_PX) / totalWidthPx) * 100,
  );
  // Degenerate containers (narrower than both floors combined): the map
  // floor wins so the map always stays usable.
  return maxPct < minPct ? { minPct, maxPct: minPct } : { minPct, maxPct };
}

/** Clamps a map-column percentage to the effective bounds for a container
 * width, falling back to MAP_COL_DEFAULT_PERCENT when `pct` is not finite. */
export function clampMapColWidthPercent(pct: number, totalWidthPx: number): number {
  const { minPct, maxPct } = getMapColWidthBounds(totalWidthPx);
  if (!Number.isFinite(pct)) {
    return Math.min(Math.max(MAP_COL_DEFAULT_PERCENT, minPct), maxPct);
  }
  return Math.min(Math.max(pct, minPct), maxPct);
}
