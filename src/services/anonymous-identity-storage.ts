const ANON_KEY = 'wm-anon-id';
const ANON_CLAIM_TOKEN_KEY = 'wm-anon-claim-token';

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

export function saveAnonClaimToken(token: string): void {
  try {
    localStorage.setItem(ANON_CLAIM_TOKEN_KEY, token);
  } catch {
    // Restricted storage contexts cannot preserve anonymous claim proof. The
    // server will fail closed if protected payment rows later need migration.
  }
}

export function clearStoredAnonIdentity(): void {
  try {
    localStorage.removeItem(ANON_KEY);
    localStorage.removeItem(ANON_CLAIM_TOKEN_KEY);
  } catch {
    // Ignore restricted storage cleanup failures.
  }
}
