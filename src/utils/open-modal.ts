/**
 * "Is a real modal open right now?" — the shared answer.
 *
 * Two consumers want identical semantics: the service-worker updater (which
 * must not reload the page out from under an open dialog) and the passkey offer
 * prompt (which must not sit beneath a focus trap, announced to assistive
 * technology but unreachable by keyboard).
 *
 * Extracted rather than copied. A second copy of the selector drifts the moment
 * someone adds a modal, and the two failure modes are both silent: a stale copy
 * either blocks forever or misses an overlay entirely.
 */

/** Element surface this module needs. Structural so tests need no real DOM. */
export interface VisibleElementLike {
  checkVisibility?: () => boolean;
  getClientRects?: () => { length: number };
}

/** Document surface this module needs. */
export interface ModalDocumentLike {
  querySelectorAll: (sel: string) => Iterable<Element & VisibleElementLike>;
}

/**
 * Selectors that identify a modal/dialog candidate.
 *
 * Matching alone is NOT enough. Many site modals mount at app startup and stay
 * in the DOM — `UnifiedSettings` builds its `.modal-overlay` and appends it to
 * `document.body` in its constructor, then only toggles `.active` on open and
 * close. A raw selector match would therefore be permanently true once Settings
 * has been instantiated. Visibility is what makes the predicate real; see
 * `isModalOpen` below.
 */
export const OPEN_MODAL_SELECTOR =
  '[aria-modal="true"], [role="dialog"], .cl-modalBackdrop, .modal-overlay, dialog[open]';

/**
 * Any candidate that is actually rendered → a real open modal.
 *
 * Preferred: `element.checkVisibility()` (Chrome 105+, Safari 17.4+, FF 125+).
 *
 * Fallback for older engines: `getClientRects().length > 0`. That returns 0 for
 * a `display: none` element — exactly how persistent overlays hide (`main.css`
 * `.modal-overlay { display: none }` / `.active { display: flex }`) — and
 * non-zero for rendered elements including `position: fixed` overlays.
 *
 * `offsetParent` is unusable here: MDN specifies it returns `null` for every
 * `position: fixed` element regardless of visibility, so it would
 * false-negative on the Story overlay, the active Country Intel overlay, and
 * `.modal-overlay` itself — all fixed-positioned.
 */
export function isModalOpen(doc: ModalDocumentLike): boolean {
  for (const el of doc.querySelectorAll(OPEN_MODAL_SELECTOR)) {
    const checkVisibility = el.checkVisibility;
    if (typeof checkVisibility === 'function') {
      if (checkVisibility.call(el)) return true;
      continue;
    }
    const getClientRects = el.getClientRects;
    if (typeof getClientRects === 'function' && getClientRects.call(el).length > 0) {
      return true;
    }
  }
  return false;
}
