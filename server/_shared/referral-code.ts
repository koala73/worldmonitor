/**
 * Deterministic referral code generation (Phase 9 / Todo #223).
 *
 * Signed-in Clerk users don't have a storage-backed referral code the
 * way the pre-signup `registrations` table does — Clerk userId is the
 * only stable identifier we have. Rather than provisioning a new
 * `userReferrals` table, we derive an 8-char code from
 * HMAC(secret, userId) so:
 *
 *   - the code is stable for the life of the Clerk account
 *   - the same user sees the same code across devices with no sync
 *   - nothing needs to be written on login
 *   - a guessed code can only fish for a user's invite count, not
 *     anything identifying — the reverse lookup is a Convex query
 *     keyed on email, not on the code itself
 *
 * Collision risk is negligible at our scale (8 hex chars = 4B slots)
 * but we reject the 3 codes that conflict with reserved keywords to
 * keep the landing-page share URLs clean.
 *
 * NOTE: this is a DIFFERENT code space than the `registrations` table's
 * referralCode column. Those are 6-char codes keyed to an email row
 * (pre-signup). Clerk codes are 8-char (to separate the namespaces at
 * a glance). The register-interest.js endpoint already accepts
 * `referredBy` as an arbitrary string, so the two code spaces merge
 * cleanly at attribution time.
 */

function hexHmac(secret: string, message: string): Promise<string> {
  return (async () => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    const bytes = new Uint8Array(sig);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
    return hex;
  })();
}

export async function getReferralCodeForUser(
  userId: string,
  secret: string,
): Promise<string> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('invalid_user_id');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('missing_secret');
  }
  const hex = await hexHmac(secret, `referral:v1:${userId}`);
  // 8 hex chars = 32-bit namespace. Plenty for the lifetime of the
  // product; rotate the secret + migrate if we ever approach the
  // birthday-collision zone (~65k users).
  //
  // Note: the output alphabet is [0-9a-f] so there's no risk of the
  // code colliding with URL-path keywords like 'admin' / 'robots'
  // — those contain non-hex characters. (An earlier draft carried
  // a RESERVED_CODES guard for this case; it was dead code and was
  // removed after review.)
  return hex.slice(0, 8);
}

export function buildShareUrl(baseUrl: string, code: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/pro?ref=${encodeURIComponent(code)}`;
}
