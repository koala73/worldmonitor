

export const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';
export const PANEL_COL_SPANS_KEY = 'worldmonitor-panel-col-spans';
export const ROW_RESIZE_STEP_PX = 80;
export const COL_RESIZE_STEP_PX = 80;
export const PANELS_GRID_MIN_TRACK_PX = 280;

export function loadPanelSpans(): Record<string, number> {
  try {
    const stored = localStorage.getItem(PANEL_SPANS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

export function savePanelSpan(panelId: string, span: number): void {
  const spans = loadPanelSpans();
  spans[panelId] = span;
  localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify(spans));
}

export function loadPanelColSpans(): Record<string, number> {
  try {
    const stored = localStorage.getItem(PANEL_COL_SPANS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

export function savePanelColSpan(panelId: string, span: number): void {
  const spans = loadPanelColSpans();
  spans[panelId] = span;
  localStorage.setItem(PANEL_COL_SPANS_KEY, JSON.stringify(spans));
}

export function clearPanelColSpan(panelId: string): void {
  const spans = loadPanelColSpans();
  if (!(panelId in spans)) return;
  delete spans[panelId];
  if (Object.keys(spans).length === 0) {
    localStorage.removeItem(PANEL_COL_SPANS_KEY);
    return;
  }
  localStorage.setItem(PANEL_COL_SPANS_KEY, JSON.stringify(spans));
}

export function getDefaultColSpan(element: HTMLElement): number {
  return element.classList.contains('panel-wide') ? 2 : 1;
}

export function getColSpan(element: HTMLElement): number {
  if (element.classList.contains('col-span-3')) return 3;
  if (element.classList.contains('col-span-2')) return 2;
  if (element.classList.contains('col-span-1')) return 1;
  return getDefaultColSpan(element);
}

export function getGridColumnCount(element: HTMLElement): number {
  const grid = (element.closest('.panels-grid') || element.closest('.map-bottom-grid')) as HTMLElement | null;
  if (!grid) return 3;
  const style = window.getComputedStyle(grid);
  const template = style.gridTemplateColumns;
  if (!template || template === 'none') return 3;

  if (template.includes('repeat(')) {
    const repeatCountMatch = template.match(/repeat\(\s*(\d+)\s*,/i);
    if (repeatCountMatch) {
      const parsed = Number.parseInt(repeatCountMatch[1] ?? '0', 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    const autoRepeatMatch = template.match(/repeat\(\s*auto-(fill|fit)\s*,/i);
    if (autoRepeatMatch) {
      const gap = Number.parseFloat(style.columnGap || '0') || 0;
      const width = grid.getBoundingClientRect().width;
      if (width > 0) {
        return Math.max(1, Math.floor((width + gap) / (PANELS_GRID_MIN_TRACK_PX + gap)));
      }
    }
  }

  const columns = template.trim().split(/\s+/).filter(Boolean);
  return columns.length > 0 ? columns.length : 3;
}

export function getMaxColSpan(element: HTMLElement): number {
  return Math.max(1, Math.min(3, getGridColumnCount(element)));
}

export function clampColSpan(span: number, maxSpan: number): number {
  return Math.max(1, Math.min(maxSpan, span));
}

export function clearColSpanClass(element: HTMLElement): void {
  element.classList.remove('col-span-1', 'col-span-2', 'col-span-3');
}

export function setColSpanClass(element: HTMLElement, span: number): void {
  clearColSpanClass(element);
  element.classList.add(`col-span-${span}`);
}

export function persistPanelColSpan(panelId: string, element: HTMLElement): void {
  const maxSpan = getMaxColSpan(element);
  const naturalSpan = clampColSpan(getDefaultColSpan(element), maxSpan);
  const currentSpan = clampColSpan(getColSpan(element), maxSpan);
  if (currentSpan === naturalSpan) {
    element.classList.remove('col-span-1', 'col-span-2', 'col-span-3');
    clearPanelColSpan(panelId);
    return;
  }
  setColSpanClass(element, currentSpan);
  savePanelColSpan(panelId, currentSpan);
}

export function getRowSpan(element: HTMLElement): number {
  if (element.classList.contains('span-4')) return 4;
  if (element.classList.contains('span-3')) return 3;
  if (element.classList.contains('span-2')) return 2;
  return 1;
}

export function setSpanClass(element: HTMLElement, span: number): void {
  element.classList.remove('span-1', 'span-2', 'span-3', 'span-4');
  element.classList.add(`span-${span}`);
  element.classList.add('resized');
}
