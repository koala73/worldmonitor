/**
 * Signed-out header auth layout thresholds (#10464).
 *
 * CSS cannot import these — media queries keep literals. Pin them with
 * `tests/header-auth-layout-alignment.test.mjs`.
 */

/** Floor width for `#authWidgetMount` so Sign In alone still fits. */
export const HEADER_AUTH_SLOT_MIN_WIDTH_PX = 72;

/** Preferred max width for Sign In + free-reason cluster. */
export const HEADER_AUTH_SLOT_MAX_WIDTH_PX = 200;

/**
 * Viewport band where left chrome (variant switcher) returns and the
 * free-reason ellipsis collapses — hide the reason and keep Sign In.
 */
export const HEADER_AUTH_FREE_REASON_HIDE_MIN_PX = 981;
export const HEADER_AUTH_FREE_REASON_HIDE_MAX_PX = 1199;
