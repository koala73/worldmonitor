/**
 * HMAC signing/verification for checkout metadata identity.
 *
 * Prevents client-controlled userId from being blindly trusted by
 * the webhook. The createCheckout action signs the userId server-side;
 * the webhook verifies the signature before trusting metadata.wm_user_id.
 *
 * Uses DODO_IDENTITY_SIGNING_SECRET as the HMAC key — a dedicated secret
 * that is SEPARATE from DODO_PAYMENTS_WEBHOOK_SECRET. This ensures rotating
 * the webhook secret does not break identity verification, and vice versa.
 *
 * Company Monitoring owner fences use their own required
 * COMPANY_MONITORING_OWNER_FENCE_SECRET and rotation keyring. Fence identity
 * must remain stable when checkout/token signing keys rotate.
 */

export const ANON_ID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANON_CLAIM_TOKEN_VERSION = "v2";
const DEFAULT_ANON_CLAIM_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_ANON_CLAIM_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_ANON_CLAIM_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Business Pro seat-invite tokens (#4634/#4635). Fixed 14-day TTL — the locked
// pending-invite expiry (a pending grant counts against the owner's seat cap
// until it lapses, then frees the slot). Kept as a constant (not env-tunable)
// because it must stay in lockstep with the `businessProGrants.expiresAt` the
// issuing mutation stamps (U3).
const BUSINESS_INVITE_TOKEN_VERSION = "v1";
const BUSINESS_INVITE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const COMPANY_MONITORING_OWNER_FENCE_VERSION = "v1";
const COMPANY_MONITORING_OWNER_FENCE_SECRET_ENV = "COMPANY_MONITORING_OWNER_FENCE_SECRET";
const COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS_ENV =
  "COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS";

// Checkout login-email tokens (#6335). Carry the Clerk login email as it was at
// checkout time so the webhook does not have to trust `users.email`, which is
// only refreshed once per page load per userId.
const CHECKOUT_LOGIN_EMAIL_TOKEN_VERSION = "v1";

/**
 * How long a stamped login email stays authoritative, measured from the moment
 * the checkout session was created to the moment the activation webhook is
 * processed.
 *
 * Sized to cover the slowest legitimate checkout→activation path: a Dodo
 * checkout session's life plus a pending 3DS/SCA settlement.
 *
 * The upper bound is what keeps a REPLAY of old checkout metadata from
 * outranking the `users` row. Note what does NOT bound it: a
 * `subscription.updated`→active is Dodo's catch-all "any field changed" sync
 * event and can arrive minutes after checkout, re-delivering the original
 * metadata for the life of the subscription. What bounds it is that such an
 * event on an existing NON-LAPSED subscription sends no lifecycle email at all
 * (see the `else if (existing)` arm of handleSubscriptionActive). The only
 * replay that can actually address a customer is one on an existing LAPSED row,
 * and lapsing requires the paid period to have run out — at least one billing
 * period after checkout. Seven days sits comfortably inside that gap.
 *
 * Past this window the `users` row is the better guess, because it is rewritten
 * on every authenticated page load and the stamped value never is.
 */
export const CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reverse-skew allowance. The issuing clock is a Convex action host and the
 * verifying clock is the Dodo event timestamp, so a fresh token can legitimately
 * look very slightly future-dated. Mirrors Dodo's own ±5 minute webhook
 * signature tolerance (payments/webhookHandlers.ts).
 */
export const CHECKOUT_LOGIN_EMAIL_CLOCK_SKEW_MS = 5 * 60 * 1000;

function getDodoIdentitySigningKey(): string {
  const key = process.env.DODO_IDENTITY_SIGNING_SECRET;
  if (!key) {
    throw new Error(
      "[identity-signing] DODO_IDENTITY_SIGNING_SECRET not set. " +
      "Set it in the Convex dashboard environment variables. " +
      "This is SEPARATE from DODO_PAYMENTS_WEBHOOK_SECRET — do not reuse."
    );
  }
  return key;
}

function getCompanyMonitoringOwnerFenceKey(): string {
  const key = process.env[COMPANY_MONITORING_OWNER_FENCE_SECRET_ENV];
  if (!key) {
    throw new Error(
      `[identity-signing] ${COMPANY_MONITORING_OWNER_FENCE_SECRET_ENV} not set. ` +
      "Set it in the Convex dashboard environment variables. " +
      "Do not reuse DODO_IDENTITY_SIGNING_SECRET.",
    );
  }
  if (key.trim() !== key) {
    throw new Error(
      `[identity-signing] ${COMPANY_MONITORING_OWNER_FENCE_SECRET_ENV} is invalid`,
    );
  }
  return key;
}

async function signPayloadWithKey(payload: string, key: string): Promise<string> {
  const encoder = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(payload),
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signPayload(payload: string): Promise<string> {
  return signPayloadWithKey(payload, getDodoIdentitySigningKey());
}

function timingSafeEqualHex(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return result === 0;
}

function getAnonClaimTokenTtlMs(): number {
  const raw = process.env.DODO_ANON_CLAIM_TOKEN_TTL_MS;
  if (!raw) return DEFAULT_ANON_CLAIM_TOKEN_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_ANON_CLAIM_TOKEN_TTL_MS;
  return Math.min(
    Math.max(Math.trunc(parsed), MIN_ANON_CLAIM_TOKEN_TTL_MS),
    MAX_ANON_CLAIM_TOKEN_TTL_MS,
  );
}

/**
 * Creates an HMAC-SHA256 signature of the userId.
 * Returns a hex-encoded string suitable for metadata values.
 */
export async function signUserId(userId: string): Promise<string> {
  return signPayload(userId);
}

/**
 * Stable, keyed owner fence for Company Monitoring account roots.
 *
 * The domain separator prevents this value being replayed as checkout
 * metadata. Keeping the fence after owner/account deletion lets a delayed
 * entitlement activation find the terminal tombstone without retaining the
 * Clerk owner id on that tombstone.
 */
export interface CompanyMonitoringOwnerFenceCandidates {
  current: string;
  all: readonly string[];
}

/**
 * Returns the current fence first, followed by every explicitly configured
 * predecessor that must remain discoverable.
 *
 * Rotation order is deliberate: before rotating
 * COMPANY_MONITORING_OWNER_FENCE_SECRET, append its current value to the
 * comma-separated COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS keyring and
 * deploy that configuration. The current-key duplicate is deliberately
 * ignored during this preparation step. Then rotate the current secret.
 * Retain every historical key
 * while tombstones created with it must remain replay-fenced: ownerless
 * terminal rows cannot be bulk migrated without retaining reversible identity.
 * Nonterminal roots are opportunistically migrated by entitlement sync.
 */
export async function companyMonitoringOwnerFenceCandidates(
  userId: string,
): Promise<CompanyMonitoringOwnerFenceCandidates> {
  if (!userId) {
    throw new Error("[identity-signing] Company Monitoring owner fence requires a userId");
  }
  const currentKey = getCompanyMonitoringOwnerFenceKey();
  const previousKeysRaw = process.env[COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS_ENV];
  const previousKeys = previousKeysRaw === undefined ? [] : previousKeysRaw.split(",");
  if (
    previousKeysRaw !== undefined &&
    (!previousKeysRaw ||
      previousKeysRaw.trim() !== previousKeysRaw ||
      previousKeys.some((key) => !key || key.trim() !== key))
  ) {
    throw new Error(
      `[identity-signing] ${COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS_ENV} is invalid`,
    );
  }
  const seenPreviousKeys = new Set<string>();
  for (const previousKey of previousKeys) {
    if (seenPreviousKeys.has(previousKey)) {
      throw new Error(
        `[identity-signing] ${COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS_ENV} contains a duplicate key`,
      );
    }
    seenPreviousKeys.add(previousKey);
  }

  const payload = `company-monitoring-owner:${COMPANY_MONITORING_OWNER_FENCE_VERSION}:${userId}`;
  const keys = [currentKey, ...previousKeys.filter((key) => key !== currentKey)];
  const all = await Promise.all(keys.map((key) => signPayloadWithKey(payload, key)));
  const [current] = all;
  if (!current) {
    throw new Error("[identity-signing] Company Monitoring owner fence keyring is empty");
  }
  return { current, all };
}

export async function signCompanyMonitoringOwnerFence(userId: string): Promise<string> {
  return (await companyMonitoringOwnerFenceCandidates(userId)).current;
}

/**
 * Verifies that a userId + signature pair is valid.
 * Returns true if the signature matches, false otherwise.
 */
export async function verifyUserId(
  userId: string,
  signature: string,
): Promise<boolean> {
  try {
    const expected = await signUserId(userId);
    return timingSafeEqualHex(expected, signature);
  } catch {
    return false;
  }
}

/**
 * Creates a server-verifiable proof token for migrating anonymous checkout
 * records into a real Clerk account. The token is domain-separated from
 * wm_user_id_sig so it cannot be replayed as checkout identity metadata, and
 * expires after the checkout-to-sign-in linking window.
 */
export async function signAnonClaimToken(anonId: string): Promise<string> {
  if (!ANON_ID_V4_REGEX.test(anonId)) {
    throw new Error("[identity-signing] anonymous claim token requires a UUID-v4 anonId");
  }
  const expiresAt = Date.now() + getAnonClaimTokenTtlMs();
  const signature = await signPayload(`anon-claim:${ANON_CLAIM_TOKEN_VERSION}:${anonId}:${expiresAt}`);
  return `${ANON_CLAIM_TOKEN_VERSION}.${expiresAt}.${signature}`;
}

/**
 * Verifies a browser-held anonymous claim token without trusting the bare UUID.
 * Expired, malformed, legacy static, or wrong-anon tokens fail closed.
 */
export async function verifyAnonClaimToken(
  anonId: string,
  claimToken: string | undefined,
): Promise<boolean> {
  if (!claimToken || !ANON_ID_V4_REGEX.test(anonId)) return false;
  const [version, expiresAtRaw, signature, ...extra] = claimToken.split(".");
  if (version !== ANON_CLAIM_TOKEN_VERSION || extra.length > 0) return false;
  if (typeof expiresAtRaw !== "string" || typeof signature !== "string") return false;
  if (!/^\d+$/.test(expiresAtRaw) || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  try {
    const expected = await signPayload(`anon-claim:${ANON_CLAIM_TOKEN_VERSION}:${anonId}:${expiresAt}`);
    return timingSafeEqualHex(expected, signature);
  } catch {
    return false;
  }
}

/**
 * Signs a server-verifiable invite token for a business Pro seat grant. Mirrors
 * `signAnonClaimToken`: HMAC-SHA256 over a domain-separated payload
 * (`business-invite:` prefix so it cannot be replayed as an anon-claim token or
 * `wm_user_id_sig`), embedding the token version and expiry. The token binds to
 * the `businessProGrants` document id — the signature does not verify for any
 * other grantId — and expires after the 14-day pending-invite window.
 *
 * @throws If grantId is empty or contains a `.` (the token delimiter).
 */
export async function signBusinessInviteToken(grantId: string): Promise<string> {
  if (!grantId || grantId.length === 0) {
    throw new Error("[identity-signing] business invite token requires a non-empty grantId");
  }
  if (grantId.includes(".")) {
    throw new Error('[identity-signing] business invite grantId must not contain "."');
  }
  const expiresAt = Date.now() + BUSINESS_INVITE_TOKEN_TTL_MS;
  const signature = await signPayload(
    `business-invite:${BUSINESS_INVITE_TOKEN_VERSION}:${grantId}:${expiresAt}`,
  );
  return `${BUSINESS_INVITE_TOKEN_VERSION}.${expiresAt}.${signature}`;
}

/**
 * Verifies a business Pro seat-invite token against the expected grant id.
 * Expired, malformed, wrong-version, tampered, or wrong-grant tokens fail closed.
 */
export async function verifyBusinessInviteToken(
  grantId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token || !grantId || grantId.length === 0) return false;
  const [version, expiresAtRaw, signature, ...extra] = token.split(".");
  if (version !== BUSINESS_INVITE_TOKEN_VERSION || extra.length > 0) return false;
  if (typeof expiresAtRaw !== "string" || typeof signature !== "string") return false;
  if (!/^\d+$/.test(expiresAtRaw) || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  try {
    const expected = await signPayload(
      `business-invite:${BUSINESS_INVITE_TOKEN_VERSION}:${grantId}:${expiresAt}`,
    );
    return timingSafeEqualHex(expected, signature);
  } catch {
    return false;
  }
}

/**
 * The signing payload for a checkout login-email token.
 *
 * Domain-separated by the `checkout-email:` prefix (so it can never be replayed
 * as `wm_user_id_sig`, an anon-claim, or a business invite) and LENGTH-PREFIXED
 * on the userId, so no (userId, email) pair can be re-cut into a different pair
 * that hashes identically.
 *
 * The collision the length prefix closes needs a userId containing the `:`
 * separator: unprefixed, `("user:a", "b@x")` and `("user", "a:b@x")` both
 * concatenate to `user:a:b@x`. Every real Clerk id and anon UUID is colon-free,
 * so this is defense against a future id format rather than a live hole — which
 * is exactly why it is cheaper to encode unambiguously now than to audit id
 * formats forever. The email is last and unbounded, which is what makes a length
 * prefix on the preceding field sufficient.
 */
function checkoutLoginEmailPayload(
  userId: string,
  email: string,
  issuedAt: number,
): string {
  return `checkout-email:${CHECKOUT_LOGIN_EMAIL_TOKEN_VERSION}:${issuedAt}:${userId.length}:${userId}:${email}`;
}

/**
 * Signs the Clerk login email that was authenticated at checkout time, bound to
 * the buyer's userId (#6335).
 *
 * `issuedAt` is a REQUIRED parameter rather than an internal `Date.now()`: the
 * verifier ages the token against the webhook's own event clock, and a helper
 * that reads a live clock would make every boundary in that comparison
 * untestable. Callers pass `Date.now()`.
 *
 * @throws If userId or email is empty, or issuedAt is not an integer.
 */
export async function signCheckoutLoginEmail(
  userId: string,
  email: string,
  issuedAt: number,
): Promise<string> {
  if (!userId) {
    throw new Error("[identity-signing] checkout login-email token requires a non-empty userId");
  }
  if (!email) {
    throw new Error("[identity-signing] checkout login-email token requires a non-empty email");
  }
  // Negative is rejected as well as non-integer: the verifier's `^\d+$` parse
  // has no sign, so a negative issuedAt would mint a token this module's own
  // verifier always calls invalid. Unreachable from `Date.now()`, but a signer
  // that can emit a token its verifier rejects is a trap worth closing here.
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error("[identity-signing] checkout login-email token requires a non-negative integer issuedAt");
  }
  const signature = await signPayload(
    checkoutLoginEmailPayload(userId, email, issuedAt),
  );
  return `${CHECKOUT_LOGIN_EMAIL_TOKEN_VERSION}.${issuedAt}.${signature}`;
}

/**
 * Why a stamped login email was not usable.
 *
 * `expired` and `invalid` are split because they mean opposite things to an
 * operator. `expired` is the STEADY STATE for any mature subscription: a
 * `subscription.updated`→active re-delivers the original checkout's metadata
 * for the life of the subscription (subscriptionHelpers:handleSubscriptionUpdated),
 * so every such event on a subscription older than the window ages out by
 * design. `invalid` means the token did not come from us for this
 * (userId, email) — a forgery, a corrupted payload, or a stamping regression.
 * Logging both at the same volume would bury the second in the first.
 */
export type CheckoutLoginEmailVerdict = "valid" | "expired" | "invalid";

/**
 * Structural parse of a login-email token — shape only, no authenticity claim.
 *
 * Exported so a caller that needs the token's `issuedAt` (to compare the
 * stamped address's age against another source's) reads it through the SAME
 * parser `verifyCheckoutLoginEmail` uses, rather than re-splitting the string
 * and risking a divergent reading. Callers must treat the result as untrusted
 * until `verifyCheckoutLoginEmail` returns `valid` for the same token.
 */
export function parseCheckoutLoginEmailToken(
  token: string | undefined,
): { issuedAt: number; signature: string } | null {
  if (!token) return null;
  const [version, issuedAtRaw, signature, ...extra] = token.split(".");
  if (version !== CHECKOUT_LOGIN_EMAIL_TOKEN_VERSION || extra.length > 0) return null;
  if (typeof issuedAtRaw !== "string" || typeof signature !== "string") return null;
  if (!/^\d+$/.test(issuedAtRaw) || !signature) return null;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt)) return null;
  return { issuedAt, signature };
}

/**
 * Verifies a stamped login email against the userId the webhook actually
 * resolved and the event's own clock. Anything other than `valid` fails closed —
 * the caller falls back to the `users` row, so a rejection costs freshness,
 * never delivery.
 *
 * The signature is checked BEFORE the age window, which costs one HMAC on
 * tokens the window would have rejected anyway. That ordering is what makes the
 * `expired` verdict worth trusting: it can only be returned for a token we
 * genuinely signed for this exact (userId, email), so a forged token can never
 * launder itself into the quiet bucket by carrying an old issuedAt.
 *
 * `email` must be the value EXACTLY as stamped (the signature covers those
 * bytes, including case and surrounding whitespace).
 */
export async function verifyCheckoutLoginEmail(
  userId: string,
  email: string,
  token: string | undefined,
  nowMs: number,
): Promise<CheckoutLoginEmailVerdict> {
  if (!token || !userId || !email) return "invalid";
  if (!Number.isFinite(nowMs)) return "invalid";
  const parsed = parseCheckoutLoginEmailToken(token);
  if (!parsed) return "invalid";
  const { issuedAt, signature } = parsed;
  try {
    const expected = await signPayload(
      checkoutLoginEmailPayload(userId, email, issuedAt),
    );
    if (!timingSafeEqualHex(expected, signature)) return "invalid";
  } catch {
    return "invalid";
  }
  const age = nowMs - issuedAt;
  if (age > CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS) return "expired";
  // Implausibly future-dated: only our own signer could have produced this, so
  // it is a clock problem worth surfacing rather than an ordinary expiry.
  if (age < -CHECKOUT_LOGIN_EMAIL_CLOCK_SKEW_MS) return "invalid";
  return "valid";
}
