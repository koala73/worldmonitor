const ANON_KEY = 'wm-anon-id';
const ANON_CLAIM_TOKEN_KEY = 'wm-anon-claim-token';
const ANON_CLAIM_TOKEN_VERSION = 'v2';
const HMAC_SHA256_HEX = /^[0-9a-f]{64}$/;

export function getStoredAnonId(): string | null {
  try {
    return localStorage.getItem(ANON_KEY);
  } catch {
    return null;
  }
}

export function saveAnonId(anonId: string): void {
  localStorage.setItem(ANON_KEY, anonId);
}

export function getStoredAnonClaimToken(): string | null {
  try {
    return localStorage.getItem(ANON_CLAIM_TOKEN_KEY);
  } catch {
    return null;
  }
}

function isFreshAnonClaimToken(token: string): boolean {
  const [version, expiresAtRaw, signature, ...extra] = token.split('.');
  if (version !== ANON_CLAIM_TOKEN_VERSION || extra.length > 0) return false;
  if (!expiresAtRaw || !signature || !/^\d+$/.test(expiresAtRaw)) return false;
  if (!HMAC_SHA256_HEX.test(signature)) return false;
  const expiresAt = Number(expiresAtRaw);
  return Number.isSafeInteger(expiresAt) && expiresAt > Date.now();
}

export function getFreshStoredAnonClaimToken(): string | null {
  const token = getStoredAnonClaimToken();
  if (!token) return null;
  if (isFreshAnonClaimToken(token)) return token;
  clearStoredAnonClaimToken();
  return null;
}

export function saveAnonClaimToken(token: string): void {
  try {
    localStorage.setItem(ANON_CLAIM_TOKEN_KEY, token);
  } catch {
    // Restricted storage contexts cannot preserve anonymous claim proof. The
    // server will fail closed if protected payment rows later need migration.
  }
}

export function clearStoredAnonClaimToken(): void {
  try {
    localStorage.removeItem(ANON_CLAIM_TOKEN_KEY);
  } catch {
    // Ignore restricted storage cleanup failures.
  }
}

export function clearStoredAnonIdentity(): void {
  try {
    localStorage.removeItem(ANON_KEY);
    clearStoredAnonClaimToken();
  } catch {
    // Ignore restricted storage cleanup failures.
  }
}
