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

export type CompanyMonitoringOwnerFenceResolution =
  | { ok: true; fence: CompanyMonitoringOwnerFenceCandidates }
  | { ok: false; reason: string };

/**
 * Non-throwing variant for callers that must not abort their transaction when
 * the fence keyring is misconfigured.
 *
 * `companyMonitoringOwnerFenceCandidates` throws for pure configuration
 * reasons — an unset or whitespace-padded COMPANY_MONITORING_OWNER_FENCE_SECRET,
 * or a malformed COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS keyring. Its
 * one production caller runs inside the entitlement transaction, so an
 * unhandled throw there rolls back a paying customer's entitlement write and
 * keeps doing so on every Dodo retry, because a config fault is not transient.
 *
 * The try/catch lives HERE, wrapping a pure function, rather than at the call
 * site: Convex has no savepoints, so catching around code that has already
 * written would commit that partial state. Wrapping a function that never
 * touches `ctx` makes the degrade path free of that hazard.
 */
export async function tryCompanyMonitoringOwnerFenceCandidates(
  userId: string,
): Promise<CompanyMonitoringOwnerFenceResolution> {
  try {
    return { ok: true, fence: await companyMonitoringOwnerFenceCandidates(userId) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
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
