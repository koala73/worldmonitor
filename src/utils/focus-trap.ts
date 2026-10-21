/**
 * Shared modal focus trap.
 *
 * Keeps Tab / Shift+Tab cycling inside an overlay while it is open and
 * restores focus to the element that opened it on close — the two halves of
 * the dialog contract that `aria-modal="true"` promises but does not provide.
 *
 * Modeled on the per-surface implementations in confirm-dialog.ts,
 * market-chart-interactions.ts, and CountryDeepDivePanel.ts; new overlays
 * should use this instead of hand-rolling another copy.
 */

import { getFocusableElements } from './dom-utils';

/**
 * Every trap listens on `document`, so several can hear the same keypress once
 * overlays stack. Only the most recently activated one may act on it.
 */
const activeTraps: FocusTrap[] = [];

export interface FocusTrapOptions {
  /**
   * Called on Escape. When omitted the trap leaves Escape alone so a
   * surface's existing close handler keeps working.
   */
  onEscape?: () => void;
  /** Element to focus on activate; defaults to the first focusable child. */
  initialFocus?: HTMLElement | null | (() => HTMLElement | null);
}

export interface FocusTrap {
  activate(): void;
  deactivate(options?: { restoreFocus?: boolean }): void;
}

export function createFocusTrap(container: HTMLElement, options: FocusTrapOptions = {}): FocusTrap {
  let active = false;
  let returnFocus: HTMLElement | null = null;

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' && event.key !== 'Tab') return;
    // Another trap opened on top of this one and owns the keyboard until it
    // deactivates. Without this, the oldest trap wins every keypress that
    // reaches document while focus sits on <body>.
    if (activeTraps[activeTraps.length - 1] !== trap) return;

    const current = document.activeElement;
    // An overlay this module does not manage (confirm-dialog.ts,
    // market-chart-interactions.ts, CountryDeepDivePanel.ts) can still stack on
    // top with its own handlers — while focus is inside it, leave both keys to it.
    if (current && current !== document.body && !container.contains(current)) return;

    if (event.key === 'Escape') {
      if (!options.onEscape) return;
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
      return;
    }

    const focusable = getFocusableElements(container);
    // A hidden or detached container has nothing to hold. Let Tab through
    // rather than stranding the whole page with no reachable focus target.
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const shouldWrap = !focusable.includes(current as HTMLElement)
      || (event.shiftKey && current === first)
      || (!event.shiftKey && current === last);
    if (!shouldWrap) return;

    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };

  const trap: FocusTrap = {
    activate(): void {
      if (active) return;
      active = true;
      activeTraps.push(trap);
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener('keydown', onKeydown, true);
      const requested = typeof options.initialFocus === 'function' ? options.initialFocus() : options.initialFocus;
      (requested ?? getFocusableElements(container)[0] ?? container).focus();
    },
    deactivate({ restoreFocus = true } = {}): void {
      if (!active) return;
      active = false;
      const index = activeTraps.lastIndexOf(trap);
      if (index !== -1) activeTraps.splice(index, 1);
      document.removeEventListener('keydown', onKeydown, true);
      if (restoreFocus && returnFocus?.isConnected) {
        returnFocus.focus();
      }
      returnFocus = null;
    },
  };

  return trap;
}
