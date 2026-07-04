import {
  MAX_PANEL_COL_SPAN,
  MAX_PANEL_ROW_SPAN,
  getExplicitColSpanClass,
  getMaxColSpan,
  isPanelGridColumnCountReady,
  setColSpanClass,
} from '@/utils/panel-grid';

export const INITIAL_PANEL_MOUNT_BUDGET_DESKTOP = 8;
// Mobile mounts fewer panels eagerly; the rest get IntersectionObserver shells (700px
// lookahead) and mount before they scroll into view. Lowered 4->3 to trim boot DOM /
// main-thread work on mobile (#4460 / #4443 U4); the typically 1-2 above-the-fold panels
// still mount eagerly, so no added skeleton flash.
export const INITIAL_PANEL_MOUNT_BUDGET_MOBILE = 3;

export interface PanelMountDeferralInput {
  enabled: boolean;
  mountedEnabledCount: number;
  isMobile: boolean;
}

export type DeferredPanelFootprintSource = 'natural' | 'saved';

export interface DeferredPanelShellFootprint {
  className?: string;
  rowSpan?: number;
  rowSpanSource?: DeferredPanelFootprintSource;
  colSpan?: number;
  colSpanSource?: DeferredPanelFootprintSource;
  collapsed?: boolean;
}

export interface DeferredPanelShellFootprintInput {
  panelId: string;
  naturalFootprints?: Readonly<Record<string, DeferredPanelShellFootprint | undefined>>;
  dynamicFootprints?: Readonly<Record<string, DeferredPanelShellFootprint | undefined>>;
  savedRowSpans?: Readonly<Record<string, number | undefined>>;
  savedColSpans?: Readonly<Record<string, number | undefined>>;
  savedCollapsed?: Readonly<Record<string, boolean | undefined>>;
}

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

function hasClassToken(className: string | undefined, token: string): boolean {
  return className?.split(/\s+/).includes(token) === true;
}

function getNaturalFootprint({
  panelId,
  naturalFootprints,
  dynamicFootprints,
}: Pick<DeferredPanelShellFootprintInput, 'panelId' | 'naturalFootprints' | 'dynamicFootprints'>): DeferredPanelShellFootprint {
  const exact = naturalFootprints?.[panelId];
  if (exact) return exact;
  if (!dynamicFootprints) return {};
  for (const [prefix, footprint] of Object.entries(dynamicFootprints)) {
    if (panelId.startsWith(prefix) && footprint) return footprint;
  }
  return {};
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
  naturalFootprints,
  dynamicFootprints,
  savedRowSpans,
  savedColSpans,
  savedCollapsed,
}: DeferredPanelShellFootprintInput): DeferredPanelShellFootprint {
  const natural = getNaturalFootprint({ panelId, naturalFootprints, dynamicFootprints });
  const naturalRowSpan = clampSpan(natural.rowSpan, MAX_PANEL_ROW_SPAN);
  const savedRowSpan = clampSpan(savedRowSpans?.[panelId], MAX_PANEL_ROW_SPAN);
  const naturalColSpan = clampSpan(natural.colSpan, MAX_PANEL_COL_SPAN);
  const savedColSpan = clampSpan(savedColSpans?.[panelId], MAX_PANEL_COL_SPAN);
  const defaultColSpan = hasClassToken(natural.className, 'panel-wide') ? 2 : 1;

  const footprint: DeferredPanelShellFootprint = {
    className: natural.className,
    collapsed: savedCollapsed?.[panelId] === true,
  };

  if (savedRowSpan !== undefined) {
    footprint.rowSpan = savedRowSpan;
    footprint.rowSpanSource = 'saved';
  } else if (naturalRowSpan !== undefined && naturalRowSpan > 1) {
    footprint.rowSpan = naturalRowSpan;
    footprint.rowSpanSource = 'natural';
  }

  if (savedColSpan !== undefined) {
    if (savedColSpan !== defaultColSpan) {
      footprint.colSpan = savedColSpan;
      footprint.colSpanSource = 'saved';
    }
  } else if (naturalColSpan !== undefined && naturalColSpan !== defaultColSpan) {
    footprint.colSpan = naturalColSpan;
    footprint.colSpanSource = 'natural';
  }

  return footprint;
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

  const rowSpan = clampSpan(footprint.rowSpan, MAX_PANEL_ROW_SPAN);
  if (rowSpan !== undefined) {
    shell.classList.add(`span-${rowSpan}`);
    if (footprint.rowSpanSource === 'saved') {
      shell.classList.add('resized');
    }
  }

  const colSpan = clampSpan(footprint.colSpan, MAX_PANEL_COL_SPAN);
  if (colSpan !== undefined) {
    shell.classList.add(`col-span-${colSpan}`);
  }

  if (footprint.collapsed) {
    shell.classList.add('panel-collapsed');
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

/**
 * Clamp a deferred shell's reserved `col-span-N` down to what the rendered
 * grid can actually fit. Mirrors {@link Panel}'s `reconcileColSpanAfterAttach`:
 * the grid's column template/width is only readable once the shell is attached,
 * so when it is not yet connected we retry across up to `attempts` animation
 * frames instead of clamping against a 0-width grid (which would read a wrong
 * column count and leave an over-wide shell -- a layout shift in the opposite
 * direction until the real panel mounts).
 */
export function reconcileDeferredPanelShellColSpan(shell: HTMLElement, attempts = 3): void {
  const tryReconcile = (remaining: number): void => {
    const currentSpan = getExplicitColSpanClass(shell);
    if (currentSpan === undefined) return;

    if (!shell.isConnected || !shell.parentElement || !isPanelGridColumnCountReady(shell)) {
      if (remaining <= 0 || typeof requestAnimationFrame !== 'function') return;
      requestAnimationFrame(() => tryReconcile(remaining - 1));
      return;
    }
    const maxSpan = getMaxColSpan(shell);
    const clampedSpan = Math.max(1, Math.min(maxSpan, currentSpan));
    if (clampedSpan !== currentSpan) {
      setColSpanClass(shell, clampedSpan);
    }
  };

  tryReconcile(attempts);
}

export function countInteractiveControls(root: ParentNode): number {
  return root.querySelectorAll(CONTROL_SELECTOR).length;
}
