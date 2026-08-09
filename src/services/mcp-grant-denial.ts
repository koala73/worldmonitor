/**
 * How the apex `/mcp-grant` consent page reacts to a denial from
 * `api/internal/mcp-grant-{context,mint}`.
 *
 * Extracted from `src/mcp-grant-main.ts` as a zero-import leaf (same reason as
 * `src/services/premium-denial.ts`): the page module boots Clerk and touches
 * `window`/`localStorage` at import time, so its decision logic was
 * unreachable from a test. The decision that matters here — is this denial
 * terminal, or should the user be allowed to try again — was previously a
 * `switch` with a terminal `default`, so #5622's new retryable 503 would have
 * been rendered as "could not be completed. Start over from your MCP client."
 * and destroyed the consent card.
 */

/** What the page should do with a denial. */
export type GrantDenialAction =
  /** Terminal: replace the consent card with the error view. */
  | 'terminal'
  /** Transient: keep the consent card, surface the message, re-enable Authorize. */
  | 'retryable'
  /** The Clerk token is stale — re-prompt for sign-in. */
  | 'sign_in';

export interface GrantDenialVerdict {
  action: GrantDenialAction;
  message: string;
  /**
   * Heading for the error view, derived from the same code as `message`.
   *
   * Carried on the verdict rather than left to the page because the page had a
   * single hardcoded heading — "Authorization request expired" — rendered above
   * every terminal body. A caller with no Pro subscription read "expired" above
   * "a WorldMonitor Pro subscription is required", which points at the wrong
   * remedy, and the anti-phishing redirect-host refusal was labelled an expiry
   * too. Deriving both strings together is what keeps them from disagreeing.
   */
  title: string;
}

/** Mint lifecycle relevant to a concurrent Clerk-triggered context refresh. */
export type GrantMintPhase = 'idle' | 'in_flight' | 'retry_cooldown';

/** What a context denial should do after classification. */
export type GrantContextDenialAction =
  | 'sign_in'
  | 'retry'
  | 'preserve_consent'
  | 'show_retry'
  | 'terminal';

/**
 * `TIER_VERIFICATION_UNAVAILABLE` (server/_shared/pro-mcp-gate.ts) is the ONE
 * retryable entitlement code the handshake emits. `SERVICE_UNAVAILABLE` (Redis
 * transport) is retryable for the same reason, and was already worded that way
 * — it just had no way to say so to the caller.
 */
const RETRYABLE_CODES = new Set(['TIER_VERIFICATION_UNAVAILABLE', 'SERVICE_UNAVAILABLE']);

const MESSAGES: Record<string, string> = {
  INVALID_NONCE: 'This authorization request expired or is invalid. Start over from your MCP client.',
  UNKNOWN_CLIENT: 'The OAuth client is no longer registered. Start over from your MCP client.',
  INVALID_REDIRECT_URI: 'The redirect destination is not allowed. Start over from your MCP client.',
  INSUFFICIENT_TIER: 'A WorldMonitor Pro subscription is required to authorize MCP clients.',
  NONCE_CLAIMED_BY_OTHER_USER:
    'This authorization request has already been claimed by another account. Start over from your MCP client.',
  CONFIGURATION_ERROR: 'MCP authorization is temporarily unavailable. Please try again later.',
  SERVICE_UNAVAILABLE: 'The authorization service is temporarily unavailable. Please try again in a moment.',
  TIER_VERIFICATION_UNAVAILABLE:
    'We could not confirm your Pro subscription just now. This is temporary — try again in a moment.',
};

const FALLBACK_MESSAGE =
  'This authorization request could not be completed. Start over from your MCP client.';

/**
 * Heading per code. Only `INVALID_NONCE` is actually an expiry — the page used
 * to say so above all of them.
 */
const TITLES: Record<string, string> = {
  INVALID_NONCE: 'Authorization request expired',
  UNKNOWN_CLIENT: 'Unknown OAuth client',
  INVALID_REDIRECT_URI: 'Redirect destination not allowed',
  INSUFFICIENT_TIER: 'Pro subscription required',
  NONCE_CLAIMED_BY_OTHER_USER: 'Claimed by another account',
  CONFIGURATION_ERROR: 'Authorization temporarily unavailable',
  SERVICE_UNAVAILABLE: 'Authorization temporarily unavailable',
  TIER_VERIFICATION_UNAVAILABLE: 'Verifying your subscription',
};

const FALLBACK_TITLE = 'Authorization failed';

/**
 * Heading for a handshake error code. Same prototype-safe lookup as
 * `grantErrorMessage` — `code` is server-supplied, so a bare index could
 * resolve `toString` to a Function and render it as a heading.
 */
export function grantErrorTitle(code: string | undefined): string {
  if (!code || !Object.prototype.hasOwnProperty.call(TITLES, code)) return FALLBACK_TITLE;
  return TITLES[code] ?? FALLBACK_TITLE;
}

/**
 * User-facing copy for a handshake error code.
 *
 * `Object.hasOwn` rather than a bare index: `code` arrives from a server JSON
 * body, and a plain-object lookup would resolve inherited names — a `code` of
 * `"constructor"` or `"toString"` returns a Function, which then renders as
 * source text in the error view.
 */
export function grantErrorMessage(code: string | undefined): string {
  // hasOwnProperty.call rather than Object.hasOwn: this module is compiled
  // against a pre-ES2022 lib target.
  if (!code || !Object.prototype.hasOwnProperty.call(MESSAGES, code)) return FALLBACK_MESSAGE;
  return MESSAGES[code] ?? FALLBACK_MESSAGE;
}

/** Server clamp is 1-60s; fall back to the server's own default when absent. */
const DEFAULT_GRANT_RETRY_SECONDS = 5;
const MAX_GRANT_RETRY_SECONDS = 60;

/**
 * Longest delay worth blocking the UI for, matching
 * `BILLING_RETRY_MAX_DELAY_MS` in src/services/notification-channels.ts.
 *
 * The server can legitimately ask for a full minute: `renewal_verification_failed`
 * carries the per-subscription provider cooldown, which
 * `ON_DEMAND_RENEWAL_FAILURE_COOLDOWN_MS` sets to 60s. Honoring that inline
 * means a spinner (or a dead "Retry shortly…" button) for a minute with no way
 * out. Above this threshold the page hands the decision back to the user
 * instead — which still honors `Retry-After`, because the user cannot click
 * faster than they can read.
 */
export const MAX_INLINE_GRANT_WAIT_MS = 10_000;

/** Whether the page should wait this delay out itself, or surface a manual retry. */
export function shouldWaitInline(delayMs: number): boolean {
  return delayMs <= MAX_INLINE_GRANT_WAIT_MS;
}

/** "about 60 seconds" / "about 5 seconds" — for copy that names the wait. */
export function describeGrantDelay(delayMs: number): string {
  const seconds = Math.max(1, Math.round(delayMs / 1_000));
  return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * How long the consent page should keep Authorize disabled after a retryable
 * denial, from the response's `Retry-After`.
 *
 * Re-enabling immediately would let the user reproduce the same failure by hand:
 * the server negative-caches a transient verification answer for a few seconds,
 * so a click inside that window is served the identical denial.
 */
export function retryableGrantDelayMs(retryAfterHeader: string | null): number {
  const parsed = Number(retryAfterHeader);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_GRANT_RETRY_SECONDS)
    : DEFAULT_GRANT_RETRY_SECONDS;
  return Math.ceil(seconds * 1_000);
}

/**
 * Classify a denial into what the page should do.
 *
 * A 401 is sign-in regardless of body, matching the page's existing behavior.
 * Everything else is terminal UNLESS the server named a retryable code — an
 * unrecognised code stays terminal so an unknown failure never becomes a retry
 * loop, which is why the retryable set is an explicit allowlist rather than a
 * status check. (A bare 503 with no/unparseable body is an intermediary, not the
 * handshake speaking.)
 */
export function classifyGrantDenial(status: number, code: string | undefined): GrantDenialVerdict {
  if (status === 401) {
    return { action: 'sign_in', message: grantErrorMessage(code), title: grantErrorTitle(code) };
  }
  return {
    action: code && RETRYABLE_CODES.has(code) ? 'retryable' : 'terminal',
    message: grantErrorMessage(code),
    title: grantErrorTitle(code),
  };
}

/**
 * Route a context denial without depending on the DOM.
 *
 * A transient Clerk subscription refresh must not replace consent while a mint
 * is either in flight or waiting out Retry-After. Outside those phases, the
 * first transient denial receives one caller-owned retry; spending that budget
 * exposes a manual retry action. Terminal denials never enter either retry
 * path.
 */
export function routeGrantContextDenial(
  denial: GrantDenialAction,
  mintPhase: GrantMintPhase,
  retriesRemaining: number,
): GrantContextDenialAction {
  if (denial === 'sign_in') return 'sign_in';
  if (denial === 'terminal') return 'terminal';
  if (mintPhase !== 'idle') return 'preserve_consent';
  return retriesRemaining > 0 ? 'retry' : 'show_retry';
}
