export const INITIAL_PANEL_MOUNT_BUDGET_DESKTOP = 8;
// Mobile mounts fewer panels eagerly; the rest get IntersectionObserver shells (700px
// lookahead) and mount before they scroll into view. Lowered 4→3 to trim boot DOM /
// main-thread work on mobile (#4460 / #4443 U4); the typically 1–2 above-the-fold panels
// still mount eagerly, so no added skeleton flash.
export const INITIAL_PANEL_MOUNT_BUDGET_MOBILE = 3;

export interface PanelMountDeferralInput {
  enabled: boolean;
  mountedEnabledCount: number;
  isMobile: boolean;
}

export interface DeferredPanelShellFootprint {
  className?: string;
  rowSpan?: number;
  colSpan?: number;
}

export interface DeferredPanelShellFootprintInput {
  panelId: string;
  naturalFootprints?: Readonly<Record<string, DeferredPanelShellFootprint>>;
  savedRowSpans?: Readonly<Record<string, number>>;
  savedColSpans?: Readonly<Record<string, number>>;
}

const PANELS_GRID_MIN_TRACK_PX = 280;
const CONTROL_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[role="button"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function clampSpan(value: number | undefined, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > max) return undefined;
  return value;
}

function addClassTokens(element: HTMLElement, className: string | undefined): void {
  if (!className) return;
  for (const token of className.split(/\s+/)) {
    if (token) element.classList.add(token);
  }
}

function getColSpanClass(element: HTMLElement): number | undefined {
  if (element.classList.contains('col-span-3')) return 3;
  if (element.classList.contains('col-span-2')) return 2;
  if (element.classList.contains('col-span-1')) return 1;
  return undefined;
}

function setColSpanClass(element: HTMLElement, span: number): void {
  element.classList.remove('col-span-1', 'col-span-2', 'col-span-3');
  element.classList.add('col-span-' + span);
}

function getGridColumnCount(element: HTMLElement): number {
  const grid = (element.closest('.panels-grid') || element.closest('.map-bottom-grid')) as HTMLElement | null;
  if (!grid || typeof window === 'undefined') return 3;
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

export function getInitialPanelMountBudget(isMobile: boolean): number {
  return isMobile ? INITIAL_PANEL_MOUNT_BUDGET_MOBILE : INITIAL_PANEL_MOUNT_BUDGET_DESKTOP;
}

export function shouldDeferInitialPanelMount({
  enabled,
  mountedEnabledCount,
  isMobile,
}: PanelMountDeferralInput): boolean {
  return enabled && mountedEnabledCount >= getInitialPanelMountBudget(isMobile);
}

export function getDeferredPanelShellFootprint({
  panelId,
  naturalFootprints = {},
  savedRowSpans = {},
  savedColSpans = {},
}: DeferredPanelShellFootprintInput): DeferredPanelShellFootprint {
  const natural = naturalFootprints[panelId] ?? {};
  return {
    className: natural.className,
    rowSpan: clampSpan(savedRowSpans[panelId], 4) ?? clampSpan(natural.rowSpan, 4),
    colSpan: clampSpan(savedColSpans[panelId], 3) ?? clampSpan(natural.colSpan, 3),
  };
}

export function createDeferredPanelShell(
  panelId: string,
  title: string,
  footprint: DeferredPanelShellFootprint = {},
): HTMLElement {
  const shell = document.createElement('div');
  shell.className = 'panel panel-deferred-shell';
  shell.dataset.panel = panelId;
  shell.dataset.deferredPanel = 'true';
  shell.setAttribute('aria-hidden', 'true');
  addClassTokens(shell, footprint.className);

  const rowSpan = clampSpan(footprint.rowSpan, 4);
  if (rowSpan !== undefined) {
    shell.classList.add(`span-${rowSpan}`);
  }

  const colSpan = clampSpan(footprint.colSpan, 3);
  if (colSpan !== undefined) {
    shell.classList.add(`col-span-${colSpan}`);
  }

  const header = document.createElement('div');
  header.className = 'panel-header panel-deferred-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'panel-header-left';

  const titleEl = document.createElement('span');
  titleEl.className = 'panel-title';
  titleEl.textContent = title;
  headerLeft.appendChild(titleEl);
  header.appendChild(headerLeft);

  const content = document.createElement('div');
  content.className = 'panel-content panel-deferred-content';
  for (let index = 0; index < 3; index++) {
    const line = document.createElement('span');
    line.className = 'panel-deferred-skeleton';
    line.setAttribute('aria-hidden', 'true');
    content.appendChild(line);
  }

  shell.appendChild(header);
  shell.appendChild(content);
  return shell;
}

export function reconcileDeferredPanelShellColSpan(shell: HTMLElement): void {
  const currentSpan = getColSpanClass(shell);
  if (currentSpan === undefined) return;

  const maxSpan = Math.max(1, Math.min(3, getGridColumnCount(shell)));
  const clampedSpan = Math.max(1, Math.min(maxSpan, currentSpan));
  if (clampedSpan !== currentSpan) {
    setColSpanClass(shell, clampedSpan);
  }
}

export function countInteractiveControls(root: ParentNode): number {
  return root.querySelectorAll(CONTROL_SELECTOR).length;
}
