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

export function countInteractiveControls(root: ParentNode): number {
  return root.querySelectorAll(CONTROL_SELECTOR).length;
}
