import type { UnifiedSettingsTabId } from '@/components/settings-types';

type SettingsTabControl = Pick<HTMLElement, 'classList' | 'dataset' | 'setAttribute'>;
type SettingsTabPanel = Pick<HTMLElement, 'classList' | 'dataset'>;
type SettingsToggleControl = Pick<HTMLElement, 'dataset' | 'focus'>;

export function normalizeSettingsTab(
  activeTab: UnifiedSettingsTabId,
  availableTabs: readonly UnifiedSettingsTabId[],
): UnifiedSettingsTabId {
  return availableTabs.includes(activeTab) ? activeTab : 'settings';
}

export function getSettingsTabNavigationIndex(
  key: string,
  currentIndex: number,
  tabCount: number,
): number | null {
  if (tabCount <= 0 || currentIndex < 0 || currentIndex >= tabCount) return null;
  if (key === 'ArrowRight') return (currentIndex + 1) % tabCount;
  if (key === 'ArrowLeft') return (currentIndex - 1 + tabCount) % tabCount;
  if (key === 'Home') return 0;
  if (key === 'End') return tabCount - 1;
  return null;
}

export function updateSettingsTabSelection(
  tabs: Iterable<SettingsTabControl>,
  panels: Iterable<SettingsTabPanel>,
  activeTab: UnifiedSettingsTabId,
): void {
  for (const tab of tabs) {
    const isActive = tab.dataset.tab === activeTab;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
    tab.setAttribute('tabindex', isActive ? '0' : '-1');
  }

  for (const panel of panels) {
    panel.classList.toggle('active', panel.dataset.panelId === activeTab);
  }
}

export function restoreSettingsToggleFocus(
  shouldRestore: boolean,
  controls: Iterable<SettingsToggleControl>,
  dataKey: 'panel' | 'source',
  value: string,
): void {
  if (!shouldRestore) return;
  for (const control of controls) {
    if (control.dataset[dataKey] === value) {
      control.focus();
      return;
    }
  }
}

export function getPanelToggleA11yState(
  locked: boolean,
  enabled: boolean,
  displayName: string,
): { ariaPressed: string | null; ariaLabel: string | null } {
  if (locked) {
    return {
      ariaPressed: null,
      ariaLabel: `Upgrade to Pro to use ${displayName}`,
    };
  }
  return {
    ariaPressed: String(enabled),
    ariaLabel: null,
  };
}
