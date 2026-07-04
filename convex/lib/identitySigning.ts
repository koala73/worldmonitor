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
 */

export const ANON_ID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANON_CLAIM_TOKEN_PREFIX = "v1.";

function getSigningKey(): string {
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

async function signPayload(payload: string): Promise<string> {
  const key = getSigningKey();
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

function timingSafeEqualHex(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Creates an HMAC-SHA256 signature of the userId.
 * Returns a hex-encoded string suitable for metadata values.
 */
export async function signUserId(userId: string): Promise<string> {
  return signPayload(userId);
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
 * wm_user_id_sig so it cannot be replayed as checkout identity metadata.
 */
export async function signAnonClaimToken(anonId: string): Promise<string> {
  if (!ANON_ID_V4_REGEX.test(anonId)) {
    throw new Error("[identity-signing] anonymous claim token requires a UUID-v4 anonId");
  }
  const signature = await signPayload(`anon-claim:v1:${anonId}`);
  return `${ANON_CLAIM_TOKEN_PREFIX}${signature}`;
}

/**
 * Verifies a browser-held anonymous claim token without trusting the bare UUID.
 */
export async function verifyAnonClaimToken(
  anonId: string,
  claimToken: string | undefined,
): Promise<boolean> {
  if (!claimToken || !ANON_ID_V4_REGEX.test(anonId)) return false;
  if (!claimToken.startsWith(ANON_CLAIM_TOKEN_PREFIX)) return false;
  try {
    const expected = await signPayload(`anon-claim:v1:${anonId}`);
    return timingSafeEqualHex(expected, claimToken.slice(ANON_CLAIM_TOKEN_PREFIX.length));
  } catch {
    return false;
  }
}
