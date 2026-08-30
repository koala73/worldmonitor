/**
 * A closed-vocabulary trace of why the passkey offer did or did not appear.
 *
 * When the offer fails to show, nothing today records which gate stopped it.
 * The only available diagnosis was elimination from a snapshot taken later, and
 * that is not proof: an empty ledger is equally consistent with a failed
 * platform-authenticator probe, an overlay, a superseded identity, a lost
 * single-flight claim, or a failed dynamic import. This records the outcome at
 * the moment it happens instead.
 *
 * The instrumentation deliberately spans BOTH halves of the feature. The eager
 * boot shim reports its own outcomes, because in the case we most need to
 * diagnose — the controller never loading — controller-side instrumentation
 * cannot run at all.
 *
 * ## The privacy constraint is the design
 *
 * Any same-origin script can read `window.__wmPasskeyOffer`, so the vocabulary
 * is CLOSED: `recordPasskeyOfferReason` silently drops anything that is not a
 * declared member. That is what makes it safe to expose — a future caller
 * cannot smuggle an account key, Clerk id, session id, or raw error message
 * through as a "reason", even by accident.
 *
 * Unlike `markLcpDebug`, this records unconditionally rather than behind an
 * opt-in flag, because the thing being diagnosed is a once-per-account event
 * that cannot be reproduced on demand — by the time you know you wanted the
 * trace, the offer has been spent. The cost is one array push per auth
 * emission, and no `performance.mark` is written, so the User Timing buffer
 * that RUM and Sentry read stays clean.
 */

/**
 * Every reason the offer can reach a decision, and nothing else.
 *
 * The first block is the eager shim's `BootDecision`; the rest mirror
 * `PasskeyEvaluationResult` in the controller. Both halves pass their result
 * straight to `recordPasskeyOfferReason`, whose parameter is this type, so
 * adding a decision without a vocabulary entry fails typecheck at that call
 * rather than silently recording nothing.
 *
 * `already-offered` (this device) and `offer-cap-reached` (this account) are
 * shared by both halves on purpose. The shim checks them too, cheaply, so it
 * can skip its dynamic import entirely rather than paying for a chunk that only
 * bails out.
 */
export const PASSKEY_OFFER_REASONS = [
  // Boot shim
  'clerk-absent',
  'signed-out-observed',
  'load-sign-in',
  'load-returning-session',
  'import-started',
  'import-failed',
  // Controller evaluation
  'not-armed',
  'not-ready',
  'ineligible-environment',
  'no-platform-authenticator',
  'offer-reservation-unavailable',
  'blocked-by-overlay',
  'superseded',
  'mounted',
  // Shared by both halves
  'already-offered',
  'offer-cap-reached',
] as const;

export type PasskeyOfferReason = (typeof PASSKEY_OFFER_REASONS)[number];

/** Bounded so a long-lived tab cannot grow the trace without limit. */
export const TRACE_LIMIT = 24;

const GLOBAL_KEY = '__wmPasskeyOffer';

type TraceState = {
  last?: PasskeyOfferReason;
  trace: PasskeyOfferReason[];
};

function traceHost(): Record<string, unknown> | null {
  return typeof window === 'undefined'
    ? null
    : (window as unknown as Record<string, unknown>);
}

function ensureState(): TraceState | null {
  const host = traceHost();
  if (!host) return null;
  const existing = host[GLOBAL_KEY] as TraceState | undefined;
  if (existing && Array.isArray(existing.trace)) return existing;
  const created: TraceState = { trace: [] };
  host[GLOBAL_KEY] = created;
  return created;
}

/**
 * Record one decision.
 *
 * Never throws and never records anything outside the vocabulary — both
 * properties matter, because this is called from inside an auth listener and
 * from a catch block.
 */
export function recordPasskeyOfferReason(reason: PasskeyOfferReason): void {
  if (!PASSKEY_OFFER_REASONS.includes(reason)) return;
  const state = ensureState();
  if (!state) return;
  state.trace.push(reason);
  state.last = reason;
  if (state.trace.length > TRACE_LIMIT) {
    state.trace.splice(0, state.trace.length - TRACE_LIMIT);
  }
}

/** The recorded sequence, oldest first. Empty when unavailable. */
export function getPasskeyOfferTrace(): readonly PasskeyOfferReason[] {
  const host = traceHost();
  const state = host?.[GLOBAL_KEY] as TraceState | undefined;
  return Array.isArray(state?.trace) ? state.trace : [];
}

/** The raw state, for the console one-liner. */
export function readPasskeyOfferTrace(): TraceState | null {
  const host = traceHost();
  const state = host?.[GLOBAL_KEY] as TraceState | undefined;
  return state && Array.isArray(state.trace) ? state : null;
}

/** Test-only reset. */
export function resetPasskeyOfferTrace(): void {
  const host = traceHost();
  if (host) delete host[GLOBAL_KEY];
}
