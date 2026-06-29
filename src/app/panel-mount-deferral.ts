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

export interface DeferredPanelNaturalFootprint {
  rowSpan?: number;
  colSpan?: number;
  wide?: boolean;
}

export type DeferredPanelFootprintSource = 'natural' | 'saved';

export interface DeferredPanelShellFootprint {
  rowSpan?: number;
  rowSpanSource?: DeferredPanelFootprintSource;
  colSpan?: number;
  colSpanSource?: DeferredPanelFootprintSource;
  wide?: boolean;
  collapsed?: boolean;
}

export interface DeferredPanelShellFootprintInput {
  panelId: string;
  naturalFootprints?: Readonly<Record<string, DeferredPanelNaturalFootprint | undefined>>;
  dynamicFootprints?: Readonly<Record<string, DeferredPanelNaturalFootprint | undefined>>;
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

function validIntegerInRange(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function getNaturalFootprint({
  panelId,
  naturalFootprints,
  dynamicFootprints,
}: Pick<DeferredPanelShellFootprintInput, 'panelId' | 'naturalFootprints' | 'dynamicFootprints'>): DeferredPanelNaturalFootprint {
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
  const naturalRowSpan = validIntegerInRange(natural.rowSpan, 1, 4);
  const savedRowSpan = validIntegerInRange(savedRowSpans?.[panelId], 1, 4);

  const wide = natural.wide === true;
  const naturalColSpan = validIntegerInRange(natural.colSpan, 1, 3);
  const savedColSpan = validIntegerInRange(savedColSpans?.[panelId], 1, 3);
  // The real panel's default column span (Panel.getDefaultColSpan) is 2 for wide
  // panels (via the panel-wide class) and 1 otherwise. A saved span only needs an
  // explicit col-span class when it differs from that default — matching
  // Panel.restoreSavedColSpan, which clears the class when saved === default.
  const defaultColSpan = wide ? 2 : 1;

  const footprint: DeferredPanelShellFootprint = {
    wide,
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
  } else if (naturalColSpan !== undefined && naturalColSpan > 1 && !wide) {
    footprint.colSpan = naturalColSpan;
    footprint.colSpanSource = 'natural';
  }

  return footprint;
}

function applyDeferredPanelShellFootprint(shell: HTMLElement, footprint: DeferredPanelShellFootprint): void {
  if (footprint.wide) {
    shell.classList.add('panel-wide');
  }
  if (footprint.rowSpan !== undefined) {
    shell.classList.add('span-' + footprint.rowSpan);
    if (footprint.rowSpanSource === 'saved') {
      shell.classList.add('resized');
    }
  }
  if (footprint.colSpan !== undefined) {
    shell.classList.add('col-span-' + footprint.colSpan);
  }
  if (footprint.collapsed) {
    // The .panel-deferred-shell.panel-collapsed .panel-deferred-content { display: none }
    // CSS rule already hides the content; no inline style needed (and an inline
    // style would out-specify any future reveal animation).
    shell.classList.add('panel-collapsed');
  }
}

/**
 * After a deferred shell is attached to the grid, clamp its `col-span-*` class to
 * the live grid column count. The real Panel does the same on mount via
 * `restoreSavedColSpan`, so without this a saved col-span (e.g. 3) on a viewport
 * that only fits 2 columns would over-reserve and the panel would shrink
 * horizontally on mount — reintroducing CLS. `maxColSpan` is the live grid's
 * resolved maximum (1-3); pass it from the caller that can measure the grid.
 */
export function reconcileDeferredShellColSpan(shell: HTMLElement, maxColSpan: number): void {
  const current = shell.classList.contains('col-span-3') ? 3
    : shell.classList.contains('col-span-2') ? 2
      : shell.classList.contains('col-span-1') ? 1
        : undefined;
  if (current === undefined) return;
  const clamped = Math.max(1, Math.min(maxColSpan, current));
  if (clamped === current) return;
  shell.classList.remove('col-span-1', 'col-span-2', 'col-span-3');
  if (clamped > 1) {
    shell.classList.add('col-span-' + clamped);
  }
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
  applyDeferredPanelShellFootprint(shell, footprint);
  return shell;
}

export function countInteractiveControls(root: ParentNode): number {
  return root.querySelectorAll(CONTROL_SELECTOR).length;
}
