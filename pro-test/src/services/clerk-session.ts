function safeDecodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Strong "is this visitor signed in right now" signal for the public welcome
 * page: true only when a live Clerk `__session` token (a JWT) is present AND
 * not expired. Deliberately ignores `__client_uat` — a longer-lived "last
 * auth" timestamp that can outlive the session — so a stale cookie cannot
 * divert an anonymous visitor away from the landing page.
 *
 * This lets the welcome page redirect a returning, actively-signed-in visitor
 * to /dashboard WITHOUT loading the ~3MB Clerk SDK on the critical path
 * (issue #4428). Idle signed-in users (expired `__session`) simply stay on the
 * landing page and use the Launch CTA — the destination still validates auth.
 */
export function hasLiveSessionJwt(cookieHeader: string): boolean {
  const match = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
  if (!match) return false;
  const exp = decodeJwtExp(safeDecodeCookieValue(match[1]).trim());
  return exp !== null && exp * 1000 > Date.now();
}
