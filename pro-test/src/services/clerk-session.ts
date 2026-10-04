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
 *
 * A missing or non-string header is treated as "no session" instead of
 * throwing (Sentry WORLDMONITOR-17E).
 */
export function hasLiveSessionJwt(cookieHeader: string | null | undefined): boolean {
  if (typeof cookieHeader !== 'string') return false;
  const match = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
  if (!match) return false;
  const exp = decodeJwtExp(safeDecodeCookieValue(match[1]).trim());
  return exp !== null && exp * 1000 > Date.now();
}

/**
 * Read `document.cookie` without throwing. Chrome (and other engines) throw
 * `SecurityError: Failed to read the 'cookie' property from 'Document': The
 * document is sandboxed and lacks the 'allow-same-origin' flag.` when the
 * welcome bundle runs inside an iframe sandboxed without `allow-same-origin`
 * (Sentry WORLDMONITOR-14B). Treat that as "no cookies" — the redirect probe
 * simply keeps the visitor on the landing page.
 *
 * Some environments (headless crawlers, patched/stubbed `document` objects)
 * expose `document.cookie` as `undefined` or another non-string value without
 * throwing (Sentry WORLDMONITOR-17E), so coerce anything that is not a string
 * to "no cookies" as well.
 */
export function readDocumentCookie(): string {
  if (typeof document === 'undefined') return '';
  try {
    const cookie: unknown = document.cookie;
    return typeof cookie === 'string' ? cookie : '';
  } catch {
    return '';
  }
}

export function hasLiveClientSession(): boolean {
  return hasLiveSessionJwt(readDocumentCookie());
}
