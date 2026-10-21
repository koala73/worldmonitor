/**
 * "Is a real modal open right now?" — the shared answer.
 *
 * Two questions live here, and conflating them shipped a regression
 * (WORLDMONITOR-15X). They differ in what they are protecting:
 *
 *   1. `isModalOpen` — is ANY focus-trapping overlay on screen? The passkey
 *      offer prompt asks this, because it must not mount beneath a focus trap
 *      where assistive technology announces it but the keyboard cannot reach it.
 *      A non-modal onboarding popover still traps nothing but still overlays,
 *      so it counts.
 *   2. `findReloadBlockingModal` — would an automatic reload destroy work the
 *      user cannot get back? The service-worker updater and the stale-bundle
 *      check ask this. An onboarding prompt that re-appears on the next load
 *      answers no; a half-filled sign-up form answers yes.
 *
 * The second is a subset of the first, expressed by a contract every
 * first-party overlay DECLARES on itself (`declareOverlay`). Declaring is not
 * optional: `scripts/enforce-overlay-reload-policy.mjs` fails the push when a
 * creation site has no declaration. Silence is reserved for DOM we do not own
 * (Clerk), and silence blocks. Twice now a surface shipped silent and wedged
 * both reload consumers for a whole session (#8593 fixed the mission-preset
 * popover; the SignalModal took over within an hour, WORLDMONITOR-15X/15Z).
 *
 * The contract is a property of what the surface can HOLD, not of who opened
 * it. A read-only display is safe on every path; a form is blocking on every
 * path. The Pro activation interstitial opens with no gesture and is a
 * multi-step flow, so unsolicited does not imply safe; a clicked SignalModal is
 * read-only, so solicited does not imply blocking. A surface whose contract
 * genuinely differs by open path re-declares in each path, because the
 * declaration is idempotent and the last call wins.
 *
 * Extracted rather than copied. A second copy of the selector drifts the moment
 * someone adds a modal, and the two failure modes are both silent: a stale copy
 * either blocks forever or misses an overlay entirely.
 */

/** Element surface the probes need. Structural so tests need no real DOM. */
export interface VisibleElementLike {
  checkVisibility?: () => boolean;
  getClientRects?: () => { length: number };
  tagName?: string;
  className?: string;
  getAttribute?: (name: string) => string | null;
}

/** Document surface the probes need. */
export interface ModalDocumentLike {
  querySelectorAll: (sel: string) => Iterable<Element & VisibleElementLike>;
}

/** Element surface `declareOverlay` needs. Structural for the same reason. */
export interface DeclarableElementLike {
  setAttribute: (name: string, value: string) => void;
}

/**
 * The one judgment only a surface can make about itself.
 *
 *   'blocking'  it can hold typed input, or a flow the user is mid-way through.
 *   'safe'      it holds nothing a reload would lose: a read-only display, a
 *               prompt that re-appears on the next load.
 */
export type ReloadPolicy = 'safe' | 'blocking';

/**
 * What a first-party overlay declares about itself. `reload` is required so the
 * compiler refuses a declaration that has not chosen.
 */
export interface OverlayContract {
  readonly reload: ReloadPolicy;
}

/**
 * Carries the contract into the DOM. The value is the `ReloadPolicy` literal.
 * Absent on anything undeclared, which the reload selector treats as blocking.
 * The DOM is the single source of truth: no registry, no second store, and
 * third-party DOM has no attribute and therefore blocks with no special case.
 */
export const RELOAD_POLICY_ATTR = 'data-reload-policy';

/**
 * Declare an overlay's reload contract on the element the reload guard will
 * see (the one carrying `role="dialog"` / `aria-modal` / `.modal-overlay`).
 *
 * Idempotent; the last call wins. Call once at creation when the contract is
 * constant, or in each open path when it depends on how the surface opened.
 * Sets nothing else: `role` and `aria-modal` remain the surface's own claims.
 */
export function declareOverlay(el: DeclarableElementLike, contract: OverlayContract): void {
  el.setAttribute(RELOAD_POLICY_ATTR, contract.reload);
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
 *
 * Exported for one reader only: the self-test of
 * `scripts/enforce-overlay-reload-policy.mjs` pins its creation-idiom table to
 * this list, so a clause added here without a matching idiom fails a test.
 * Consumers use the derived selector strings below, never this tuple.
 */
export const MODAL_SELECTORS = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '.cl-modalBackdrop',
  '.modal-overlay',
  'dialog[open]',
] as const;

export const OPEN_MODAL_SELECTOR = MODAL_SELECTORS.join(', ');

/**
 * The same candidates minus anything that declared itself reload-safe.
 * Derived rather than written out, so a new modal selector cannot be added to
 * one list and forgotten in the other. Only the literal 'safe' opts out;
 * 'blocking' and absence both block.
 */
export const RELOAD_BLOCKING_MODAL_SELECTOR = MODAL_SELECTORS
  .map((sel) => `${sel}:not([${RELOAD_POLICY_ATTR}="safe"])`)
  .join(', ');

/**
 * Who held the reload off, and whether they said they would.
 *
 *   'blocking'    a first-party surface declared it. A wedge here is a declared
 *                 judgment to revisit.
 *   'undeclared'  no contract on the element. Every first-party overlay is
 *                 declared, so this means third-party DOM (Clerk) or an idiom
 *                 the lint gate does not know. A non-`cl-` label with this
 *                 value is a gate escape.
 */
export interface ReloadBlocker {
  readonly label: string;
  readonly policy: 'blocking' | 'undeclared';
}

/**
 * Is this candidate actually rendered?
 *
 * Preferred: `element.checkVisibility()` (Chrome 105+, Safari 17.4+, FF 125+).
 * With default options it reports false for an element with no associated box
 * (`display: none`, detached) or under `content-visibility: hidden`, but NOT for
 * one hidden only by `opacity: 0` or `visibility: hidden` — so overlays must
 * hide by leaving layout.
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
function isRendered(el: VisibleElementLike): boolean {
  const checkVisibility = el.checkVisibility;
  if (typeof checkVisibility === 'function') return checkVisibility.call(el);
  const getClientRects = el.getClientRects;
  return typeof getClientRects === 'function' && getClientRects.call(el).length > 0;
}

/**
 * A short, bounded label naming which overlay blocked a reload.
 *
 * Exists because the first production report of a deferral said only that
 * *something* was open, leaving the element to be inferred from the geographic
 * spread of the affected users. Sanitised and truncated: it is published as a
 * Sentry tag, so it must stay a stable low-cardinality token rather than
 * arbitrary DOM text.
 *
 * Known limit: six surfaces put `modal-overlay` first in their class list, so
 * that label cannot tell Settings from the watchlist editor. The label is a
 * Sentry tag with alert rules on it, so changing what it emits is its own
 * change, not a side effect of this module.
 */
function describe(el: VisibleElementLike): string {
  const role = el.getAttribute?.('role') ?? '';
  const firstClass = (el.className ?? '').split(/\s+/).find((c) => c.length > 0) ?? '';
  const raw = firstClass || role || el.tagName || 'unknown';
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return safe.length > 0 ? safe : 'unknown';
}

/**
 * 'safe' never reaches here: the selector excluded it. Anything but the literal
 * 'blocking' is therefore undeclared, including a garbage value.
 */
function policyOf(el: VisibleElementLike): ReloadBlocker['policy'] {
  return el.getAttribute?.(RELOAD_POLICY_ATTR) === 'blocking' ? 'blocking' : 'undeclared';
}

/**
 * Any candidate that is actually rendered → a real open modal.
 *
 * Reload consumers want `findReloadBlockingModal` instead; this one answers the
 * broader "is an overlay on screen" question and deliberately ignores the
 * reload contract.
 */
export function isModalOpen(doc: ModalDocumentLike): boolean {
  for (const el of doc.querySelectorAll(OPEN_MODAL_SELECTOR)) {
    if (isRendered(el)) return true;
  }
  return false;
}

/**
 * The first rendered overlay that did NOT declare itself reload-safe,
 * described for telemetry — or null when an automatic reload is safe.
 *
 * Returns the label and whether the block was declared, so the caller can
 * report both; `null` is the "go ahead and reload" answer.
 */
export function findReloadBlockingModal(doc: ModalDocumentLike): ReloadBlocker | null {
  for (const el of doc.querySelectorAll(RELOAD_BLOCKING_MODAL_SELECTOR)) {
    if (isRendered(el)) return { label: describe(el), policy: policyOf(el) };
  }
  return null;
}
