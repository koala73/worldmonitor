export type PanelKeyboardZone = 'sidebar' | 'bottom';

export interface MovePanelToKeyboardZoneInput {
  panel: HTMLElement;
  panelKey: string;
  targetZone: PanelKeyboardZone;
  sidebarGrid: HTMLElement;
  bottomGrid: HTMLElement;
  bottomSet: Set<string>;
}

/**
 * Move one panel between the two dashboard grids without relying on pointer
 * coordinates. The caller persists the resulting unified order after a move.
 */
export function movePanelToKeyboardZone({
  panel,
  panelKey,
  targetZone,
  sidebarGrid,
  bottomGrid,
  bottomSet,
}: MovePanelToKeyboardZoneInput): boolean {
  const targetGrid = targetZone === 'bottom' ? bottomGrid : sidebarGrid;
  if (panel.parentElement === targetGrid) return false;

  const reference = targetZone === 'sidebar'
    ? sidebarGrid.querySelector('.add-panel-block')
    : null;
  targetGrid.insertBefore(panel, reference);

  if (targetZone === 'bottom') bottomSet.add(panelKey);
  else bottomSet.delete(panelKey);
  return true;
}
