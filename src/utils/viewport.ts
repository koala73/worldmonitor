interface PanelViewportTarget {
  isNearViewport?: (marginPx?: number) => boolean;
  getElement?: () => HTMLElement;
}

export function isElementNearViewport(el: HTMLElement, marginPx = 400): boolean {
  if (el.hidden || el.classList.contains('hidden')) return false;
  const rect = el.getBoundingClientRect();
  return rect.bottom >= -marginPx && rect.top <= window.innerHeight + marginPx;
}

export function isLoadedPanelNearViewport(
  panels: Record<string, unknown>,
  panelId: string,
  marginPx = 400,
): boolean {
  const panel = panels[panelId] as PanelViewportTarget | undefined;
  if (!panel) return false;
  if (panel.isNearViewport?.(marginPx)) return true;
  const el = panel.getElement?.();
  return el ? isElementNearViewport(el, marginPx) : false;
}
