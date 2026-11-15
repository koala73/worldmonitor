/** 8-char Clerk referral codes are a different space from the 6-char registration codes. */

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
