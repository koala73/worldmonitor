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

/** Minimum track width of `.panels-grid`: `repeat(auto-fill, minmax(270px, 1fr))` in main.css. */
export const PANELS_GRID_MIN_TRACK_PX = 270;
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
 * `.panels-grid` declares `repeat(auto-fill, minmax(270px, 1fr))`, but a
 * rendered grid reports its resolved tracks, implicit ones included: a span
 * wider than the real columns adds implicit tracks, and counting those would
 * let the span keep the columns it created.
 */
function isPanelsGrid(grid: HTMLElement, style: CSSStyleDeclaration): boolean {
  return grid.classList.contains('panels-grid') && style.display === 'grid';
}

/**
 * A `.panels-grid` restyled with a fixed template (the plugin's one-column
 * layout in plugin.css) declares its column count in `--panels-grid-columns`,
 * because the width formula below only holds for the auto-fill template.
 */
function getDeclaredPanelGridColumns(style: CSSStyleDeclaration): number | null {
  const value = style.getPropertyValue('--panels-grid-columns').trim();
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

function isAutoFillPanelsGrid(grid: HTMLElement, style: CSSStyleDeclaration): boolean {
  return isPanelsGrid(grid, style) && getDeclaredPanelGridColumns(style) === null;
}

/** Columns `repeat(auto-fill, minmax(270px, 1fr))` creates in the grid's content box. */
function countAutoFillColumns(grid: HTMLElement, style: CSSStyleDeclaration): number {
  const gap = Number.parseFloat(style.columnGap || '0') || 0;
  const padding = (Number.parseFloat(style.paddingLeft || '0') || 0) + (Number.parseFloat(style.paddingRight || '0') || 0);
  // offsetWidth - clientWidth is the border plus any vertical scrollbar.
  const chrome = Math.max(0, (grid.offsetWidth || 0) - (grid.clientWidth || 0));
  const content = getPanelGridWidth(grid) - padding - chrome;
  return Math.max(1, Math.floor((content + gap) / (PANELS_GRID_MIN_TRACK_PX + gap)));
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
  if (isPanelsGrid(grid, style) && getDeclaredPanelGridColumns(style) !== null) return true;
  if (isAutoFillPanelsGrid(grid, style)) return getPanelGridWidth(grid) > 0;
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
  const declared = isPanelsGrid(grid, style) ? getDeclaredPanelGridColumns(style) : null;
  if (declared !== null) return declared;
  if (isAutoFillPanelsGrid(grid, style)) {
    return getPanelGridWidth(grid) > 0 ? countAutoFillColumns(grid, style) : MAX_PANEL_COL_SPAN;
  }
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
      return getPanelGridWidth(grid) > 0 ? countAutoFillColumns(grid, style) : MAX_PANEL_COL_SPAN;
    }
  }

  const columns = template.trim().split(/\s+/).filter(Boolean);
  return columns.length > 0 ? columns.length : MAX_PANEL_COL_SPAN;
}

/** Largest column span the current grid can accommodate (1…{@link MAX_PANEL_COL_SPAN}). */
export function getMaxColSpan(element: HTMLElement): number {
  return Math.max(1, Math.min(MAX_PANEL_COL_SPAN, getGridColumnCount(element)));
}

/** The column span a panel renders at without a `col-span-N` class. */
export function getDefaultColSpan(element: HTMLElement): number {
  return element.classList.contains('panel-wide') ? 2 : 1;
}

/** The column span a panel asks for, before clamping to the grid. */
export function getColSpan(element: HTMLElement): number {
  return getExplicitColSpanClass(element) ?? getDefaultColSpan(element);
}

/** Point the column resize handle's ARIA range at the grid's current columns. */
export function syncColResizeAria(element: HTMLElement, handle: HTMLElement): void {
  const maxSpan = getMaxColSpan(element);
  handle.setAttribute('aria-valuemax', String(maxSpan));
  handle.setAttribute('aria-valuenow', String(clampColSpan(getColSpan(element), maxSpan)));
}

let gridColumnObserver: ResizeObserver | null = null;
const observedGrids = new WeakSet<HTMLElement>();

function publishGridColumns(grid: HTMLElement): void {
  if (!grid.isConnected) {
    gridColumnObserver?.unobserve(grid);
    observedGrids.delete(grid);
    return;
  }
  if (typeof window === 'undefined' || !isPanelsGrid(grid, window.getComputedStyle(grid))) {
    delete grid.dataset.gridCols;
    return;
  }
  const cols = String(getGridColumnCount(grid));
  if (grid.dataset.gridCols === cols) return;
  grid.dataset.gridCols = cols;
  for (const child of Array.from(grid.children)) {
    if (!(child instanceof HTMLElement) || !child.classList.contains('panel')) continue;
    const handle = child.querySelector<HTMLElement>(':scope > .panel-col-resize-handle');
    if (handle) syncColResizeAria(child, handle);
  }
}

/**
 * Keep `data-grid-cols` on the panel's `.panels-grid` equal to its real column
 * count. CSS clamps `.panel-wide` and `col-span-N` to it, so a span the grid
 * has no room for cannot add implicit columns and squeeze the other panels.
 * Accepts the grid or a panel in it. Idempotent per grid; follows window and
 * map-width resizes.
 */
export function observePanelGridColumns(element: HTMLElement): void {
  const grid = getPanelGrid(element);
  if (!grid || !grid.classList.contains('panels-grid') || observedGrids.has(grid)) return;
  if (typeof ResizeObserver !== 'function') return;
  observedGrids.add(grid);
  gridColumnObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) publishGridColumns(entry.target as HTMLElement);
  });
  // The first notification lands after layout and before paint, so the
  // clamped spans are what first paints.
  gridColumnObserver.observe(grid);
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
