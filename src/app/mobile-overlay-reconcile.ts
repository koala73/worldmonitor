import type { OverlayId } from '@/utils/overlay-history';

/**
 * Effects `reconcileOverlayForTab` may perform. Passed in rather than reached
 * through `this` so the decision AND its effect sequence can be exercised
 * against a recorder — the order matters (a dirty Settings overlay must be
 * closed by its own handler before the tab bar moves), and a decision-only
 * extraction would not pin that.
 */
export interface OverlayReconcileHandlers {
  /** Overlay currently on top of the history stack, or null when none is. */
  top(): OverlayId | null;
  dismiss(id: OverlayId): void;
  /** True when Settings holds an unsaved draft. */
  settingsHasPendingChanges(): boolean;
  /** Close Settings through its own handler, which prompts about the draft. */
  closeSettings(): void;
  setActive(tab: string): void;
}

const SEARCH_OVERLAYS: ReadonlySet<string> = new Set(['search', 'search-pending']);
const MORE_OVERLAYS: ReadonlySet<string> = new Set([
  'menu',
  'region',
  'settings',
  'settings-pending',
]);

/**
 * Decide what happens to the open overlay when a primary tab is tapped.
 *
 * Returns the overlay id the caller should replace in place, `null` when the
 * overlay was handled here (dismissed or closed) and the caller must not open
 * anything, or `undefined` when no overlay was open.
 */
export function reconcileOverlayForTab(
  tab: string,
  handlers: OverlayReconcileHandlers,
): OverlayId | undefined | null {
  const top = handlers.top();
  if (!top) return undefined;

  // Never replace or dismiss a dirty Settings overlay: those paths call
  // close('replacement') and would discard the draft without confirmation.
  if (top === 'settings' && handlers.settingsHasPendingChanges()) {
    handlers.closeSettings();
    handlers.setActive('more');
    return null;
  }

  const reTappedOwnTab =
    (tab === 'search' && SEARCH_OVERLAYS.has(top)) ||
    (tab === 'more' && MORE_OVERLAYS.has(top));
  if (reTappedOwnTab) {
    handlers.dismiss(top);
    handlers.setActive('today');
    return null;
  }

  // Search and More replace the open overlay in place; every other tab is a
  // navigation away from it.
  if (tab === 'search' || tab === 'more') return top;
  handlers.dismiss(top);
  return undefined;
}
