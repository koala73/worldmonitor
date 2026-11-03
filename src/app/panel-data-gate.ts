/**
 * Whether a panel's data should load: its variant ships it, or the user added
 * it to this variant's layout. Any panel can be enabled in any variant, so a
 * variant-only gate leaves a user-added panel on its loading state forever
 * (#9396: Intel Feed and Fires under the Tech variant).
 */
export function variantShipsOrUserEnabled(input: {
  variant: string;
  owningVariants: readonly string[];
  panelEnabled: boolean;
}): boolean {
  return input.owningVariants.includes(input.variant) || input.panelEnabled;
}
