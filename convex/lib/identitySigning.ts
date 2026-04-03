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

/**
 * Creates an HMAC-SHA256 signature of the userId.
 * Returns a hex-encoded string suitable for metadata values.
 */
export async function signUserId(userId: string): Promise<string> {
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
    encoder.encode(userId),
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    // Constant-time comparison (length check + byte-by-byte)
    if (expected.length !== signature.length) return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
      result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
  } catch {
    return false;
  }
}
