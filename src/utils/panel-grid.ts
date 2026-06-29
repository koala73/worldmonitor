/**
 * Shared grid-geometry helpers for panel row/column spans.
 *
 * Both the live {@link Panel} component and the deferred-shell placeholder
 * logic (`panel-mount-deferral`) reason about the same CSS grid
 * (`.panels-grid` / `.map-bottom-grid`) and the same `span-N` / `col-span-N`
 * classes. Keeping the column-count inference and the span clamp/class helpers
 * in one module guarantees a deferred shell reserves exactly the footprint the
 * real panel occupies after hydration — divergent copies would silently
 * reintroduce the layout shift this reservation exists to prevent.
 */

/** Minimum track width assumed for `repeat(auto-fill, minmax(280px, 1fr))`. */
export const PANELS_GRID_MIN_TRACK_PX = 280;
/** Maximum row span supported by the CSS (`.panel.span-1` … `.panel.span-4`). */
export const MAX_PANEL_ROW_SPAN = 4;
/** Maximum column span supported by the CSS (`.panel.col-span-1` … `.col-span-3`). */
export const MAX_PANEL_COL_SPAN = 3;

function getPanelGrid(element: HTMLElement): HTMLElement | null {
  return (element.closest('.panels-grid') || element.closest('.map-bottom-grid')) as HTMLElement | null;
}

function getPanelGridWidth(grid: HTMLElement): number {
  const width = grid.getBoundingClientRect().width;
  return Number.isFinite(width) ? width : 0;
}

/**
 * Whether the owning grid's column count can be trusted right now. CSS
 * `repeat(auto-fill/auto-fit, ...)` templates need a rendered width before
 * they can be converted into a column count; a connected grid can briefly
 * report width 0 during synchronous insertion/layout.
 */
export function isPanelGridColumnCountReady(element: HTMLElement): boolean {
  const grid = getPanelGrid(element);
  if (!grid || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true;

  const style = window.getComputedStyle(grid);
  const template = style.gridTemplateColumns;
  if (!template || template === 'none' || !template.includes('repeat(')) return true;
  if (/repeat\(\s*\d+\s*,/i.test(template)) return true;
  if (/repeat\(\s*auto-(fill|fit)\s*,/i.test(template)) {
    return getPanelGridWidth(grid) > 0;
  }
  return true;
}

/**
 * Best-effort count of the rendered columns of the grid that owns `element`.
 * Falls back to {@link MAX_PANEL_COL_SPAN} when the grid or its computed style
 * is unavailable (e.g. server-side render).
 */
export function getGridColumnCount(element: HTMLElement): number {
  const grid = getPanelGrid(element);
  if (!grid || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return MAX_PANEL_COL_SPAN;
  const style = window.getComputedStyle(grid);
  const template = style.gridTemplateColumns;
  if (!template || template === 'none') return MAX_PANEL_COL_SPAN;

  if (template.includes('repeat(')) {
    const repeatCountMatch = template.match(/repeat\(\s*(\d+)\s*,/i);
    if (repeatCountMatch) {
      const parsed = Number.parseInt(repeatCountMatch[1] ?? '0', 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    // For repeat(auto-fill/auto-fit, minmax(...)), infer count from rendered width.
    const autoRepeatMatch = template.match(/repeat\(\s*auto-(fill|fit)\s*,/i);
    if (autoRepeatMatch) {
      const gap = Number.parseFloat(style.columnGap || '0') || 0;
      const width = getPanelGridWidth(grid);
      if (width > 0) {
        return Math.max(1, Math.floor((width + gap) / (PANELS_GRID_MIN_TRACK_PX + gap)));
      }
      return MAX_PANEL_COL_SPAN;
    }
  }

  const columns = template.trim().split(/\s+/).filter(Boolean);
  return columns.length > 0 ? columns.length : MAX_PANEL_COL_SPAN;
}

/** Largest column span the current grid can accommodate (1…{@link MAX_PANEL_COL_SPAN}). */
export function getMaxColSpan(element: HTMLElement): number {
  return Math.max(1, Math.min(MAX_PANEL_COL_SPAN, getGridColumnCount(element)));
}

/** Clamp `span` into the `[1, maxSpan]` range. */
export function clampColSpan(span: number, maxSpan: number): number {
  return Math.max(1, Math.min(maxSpan, span));
}

/**
 * The explicit `col-span-N` class on `element`, or `undefined` when none is
 * set (i.e. the element renders at its natural/default column span).
 */
export function getExplicitColSpanClass(element: HTMLElement): number | undefined {
  if (element.classList.contains('col-span-3')) return 3;
  if (element.classList.contains('col-span-2')) return 2;
  if (element.classList.contains('col-span-1')) return 1;
  return undefined;
}

/** Remove any `col-span-N` class. */
export function clearColSpanClass(element: HTMLElement): void {
  element.classList.remove('col-span-1', 'col-span-2', 'col-span-3');
}

/** Replace any existing `col-span-N` class with `col-span-${span}`. */
export function setColSpanClass(element: HTMLElement, span: number): void {
  clearColSpanClass(element);
  element.classList.add(`col-span-${span}`);
}
