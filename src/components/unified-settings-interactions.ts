type SettingsToggleControl = Pick<HTMLElement, 'dataset' | 'focus'>;

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
