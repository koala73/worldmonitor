/**
 * What a premium endpoint's denial actually means for the UI (#5608).
 *
 * A 403 has more than one cause, and they need opposite treatments:
 *
 *   - The account really is on the free plan  → upsell. Retrying is futile.
 *   - The server's entitlement source glitched → transient. Retrying wins,
 *     and an upsell is actively wrong: during the #5600 entitlement-cache
 *     poison window a user who had paid minutes earlier was told to
 *     "Upgrade to unlock today's issue".
 *   - The request never reached the entitlement check at all (rejected
 *     origin, WAF) → transient, and not a statement about the plan.
 *
 * The discriminator for the middle case is the client's own entitlement
 * state. It is NOT authoritative — the server always wins on whether to
 * serve content — but a client that affirmatively believes the user is Pro
 * while the server denies is evidence of a desync, and the honest render is
 * "temporarily unavailable", not an upsell.
 *
 * Zero-import leaf so it stays unit-testable under `tsx --test`. Call sites
 * build the belief snapshot via `readClientEntitlementBelief` in
 * `panel-gating.ts`.
 */

/** Minimum entitlement tier that counts as Pro (mirrors api/latest-brief.ts). */
export const PRO_TIER = 1;

export type PremiumDenialVerdict =
  /** 401 — the session is gone. Re-auth, don't retry. */
  | 'sign_in_required'
  /** 403 entitlement denial the client agrees with. Terminal; show the upsell. */
  | 'upgrade_required'
  /** 403 entitlement denial the client's own state contradicts. Transient; retry. */
  | 'entitlement_desync'
  /** 403 that never reached the entitlement check (origin/WAF). Transient; retry. */
  | 'access_denied';

/**
 * Snapshot of what the CLIENT believes about the user's plan, independent of
 * the server's answer.
 */
export interface ClientEntitlementBelief {
  /** `features.tier` from the Convex entitlement snapshot; null when none has arrived. */
  entitlementTier: number | null;
  /** `role` on the Clerk session; null when signed out or unset. */
  authRole: string | null;
}

export interface PremiumDenialInput {
  status: number;
  /** The `error` field of the response body, when it parsed as a string. */
  errorCode: string | null;
  belief: ClientEntitlementBelief;
}

/**
 * Lowercase and collapse `_`/`-` to spaces so the several spellings the
 * backends use (`pro_required`, `Pro subscription required`, `INSUFFICIENT_TIER`)
 * compare as one vocabulary.
 */
function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Codes that are a genuine "this account is not on the required plan" verdict,
 * as opposed to a 403 raised before entitlement was ever consulted.
 *
 *   api/latest-brief.ts:201                 → pro_required
 *   api/chat-analyst.ts:126                 → Pro subscription required
 *   server/_shared/entitlement-check.ts:556 → Upgrade required
 *   api/internal/mcp-grant-*.ts             → INSUFFICIENT_TIER
 *
 * Deliberately excludes `Unable to verify entitlements`
 * (entitlement-check.ts:527): that 403 is a fail-closed lookup error, so it
 * states nothing about the plan and must never produce an upsell.
 * `Subscription lapsed` is excluded too — see BILLING_TERMINAL_CODES below.
 *
 * The vocabulary is pinned against the real server sources by a contract test
 * in tests/premium-denial.test.mts, so a backend rename fails CI instead of
 * silently rerouting a denial.
 */
const ENTITLEMENT_DENIAL_CODES = new Set([
  'pro required',
  'pro subscription required',
  'upgrade required',
  'insufficient tier',
]);

/**
 * Billing verdicts the client has no standing to contradict.
 *
 * `Subscription lapsed` (entitlement-check.ts:446) comes from
 * `entitlements.billingStatus` — the payment provider confirmed coverage
 * ended. That is a different question from the tier check, and it is not the
 * cache-poisonable path. The client cannot disagree with it either way:
 * `EntitlementState` carries planKey/features/validUntil and no billingStatus,
 * so `clientBelievesPro` would still say "Pro" from a row whose validUntil has
 * not yet passed. Routing it through the desync branch would retry a lapsed
 * subscriber forever instead of giving them a way back.
 */
const BILLING_TERMINAL_CODES = new Set(['subscription lapsed']);

/**
 * Codes that mean "we could not identify you", which the shared gateway
 * serves as a 403 rather than a 401 (entitlement-check.ts:508). The fix is a
 * session, not a purchase.
 */
const AUTHENTICATION_CODES = new Set([
  'authentication required',
  'unauthenticated',
  'sign in required',
]);

/**
 * Does the client affirmatively believe this user is Pro?
 *
 * Deliberately excludes the desktop `WORLDMONITOR_API_KEY` and the browser
 * tester keys that `hasPremiumAccess` also honours: those unlock panels
 * locally but say nothing about the signed-in Clerk account's plan, so an
 * API-key user with a free account should still get the upsell.
 */
export function clientBelievesPro(belief: ClientEntitlementBelief): boolean {
  if (belief.entitlementTier !== null && belief.entitlementTier >= PRO_TIER) return true;
  return belief.authRole === 'pro';
}

/**
 * Classify a premium endpoint's response. Returns null for any status that is
 * not an access denial — the caller keeps its own handling for those.
 */
export function classifyPremiumDenial(input: PremiumDenialInput): PremiumDenialVerdict | null {
  if (input.status === 401) return 'sign_in_required';
  if (input.status !== 403) return null;
  // Every entitlement 403 our handlers emit carries a JSON `error` string, so
  // a 403 without a parseable code did not come from our entitlement logic at
  // all — it is an intermediary (WAF, CDN, proxy). Same for an unrecognised
  // code (rejected origin, fail-closed lookup). Neither is a statement about
  // the plan, so neither may produce an upsell, whatever the client believes.
  if (input.errorCode === null) return 'access_denied';
  const code = normalizeCode(input.errorCode);
  if (AUTHENTICATION_CODES.has(code)) return 'sign_in_required';
  if (BILLING_TERMINAL_CODES.has(code)) return 'upgrade_required';
  if (!ENTITLEMENT_DENIAL_CODES.has(code)) return 'access_denied';
  return clientBelievesPro(input.belief) ? 'entitlement_desync' : 'upgrade_required';
}

/**
 * Should the client skip a fetch it believes is doomed and render the upgrade
 * CTA directly?
 *
 * Only when a snapshot has ARRIVED and nothing contradicts it. A snapshot that
 * says free while the Clerk session claims the Pro role is a contradiction, not
 * knowledge — let the server break the tie rather than painting an upsell over
 * it (#5608). With no snapshot at all the client has no opinion, so it must not
 * pre-empt the server either.
 *
 * Kept here, as a pure predicate over the two inputs, so the boolean
 * composition is directly testable — a source-level guard cannot verify it.
 */
export function shouldSkipDoomedFetch(
  hasEntitlementSnapshot: boolean,
  belief: ClientEntitlementBelief,
): boolean {
  return hasEntitlementSnapshot && !clientBelievesPro(belief);
}

/** Whether the verdict is worth retrying. Terminal verdicts need user action. */
export function isTransientDenial(verdict: PremiumDenialVerdict | null): boolean {
  return verdict === 'entitlement_desync' || verdict === 'access_denied';
}

/** What a panel should actually render for a denial. */
export type DenialAction =
  /** Terminal: the session is gone. */
  | 'sign_in'
  /** Terminal: the plan really is insufficient. The only honest upsell. */
  | 'upgrade'
  /** Transient: show the unavailable state and retry. */
  | 'retry'
  /** Transient budget spent: terminal, but NOT an upsell — we have no evidence
   *  the user needs to buy anything. */
  | 'give_up';

/**
 * Route a denial verdict to the render a panel should perform.
 *
 * Extracted as a pure function on purpose. This routing is the exact place the
 * #5608 bug lived — sending a transient verdict to the upsell — and a
 * source-level guard cannot prove a branch body is correct, only that certain
 * identifiers appear near each other. Keeping the truth table here makes it
 * executable, so a mutation that re-points the transient branch at the upsell
 * fails a real assertion instead of slipping past a regex.
 */
export function routeDenial(
  verdict: PremiumDenialVerdict,
  consecutiveTransientDenials: number,
  maxTransientDenials: number,
): DenialAction {
  if (verdict === 'sign_in_required') return 'sign_in';
  if (verdict === 'upgrade_required') return 'upgrade';
  return consecutiveTransientDenials > maxTransientDenials ? 'give_up' : 'retry';
}

/**
 * Pull the `error` string out of a denial response body for `errorCode`.
 * Every failure mode (non-JSON body, already-consumed stream, missing or
 * non-string field) collapses to null, which `classifyPremiumDenial` reads as
 * "not one of ours" — an intermediary's 403, never an upsell.
 *
 * Consumes the body — only call it on a response you are not going to read
 * again.
 */
export async function readDenialErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Classify a response end to end: gate on the denial statuses, read the body
 * only for those, and return the verdict. Returns null for anything that is
 * not an access denial, so callers keep their own handling for those.
 *
 * The status gate is what keeps this safe to call on every response: the body
 * is consumed ONLY on a 401/403, leaving the stream intact for the success
 * path (a JSON payload in LatestBriefPanel, an SSE stream in ChatAnalystPanel).
 */
export async function classifyDenialResponse(
  res: Response,
  belief: ClientEntitlementBelief,
): Promise<PremiumDenialVerdict | null> {
  if (res.status !== 401 && res.status !== 403) return null;
  return classifyPremiumDenial({
    status: res.status,
    errorCode: await readDenialErrorCode(res),
    belief,
  });
}
