/**
 * Shared pieces of the desktop browser sign-in flow (#9396 follow-up):
 * /api/desktop-auth/authorize binds a one-time code to the desktop's PKCE
 * challenge for the signed-in browser user; /api/desktop-auth/token redeems
 * it with the verifier for a Clerk sign-in ticket. The desktop receives the
 * code on a 127.0.0.1 loopback redirect (RFC 8252), so a phishing link that
 * starts the flow elsewhere never delivers the code to the attacker.
 * See docs/plans/2026-10-19-desktop-system-browser-sign-in.md.
 */

// @ts-expect-error JS module without declarations.
import { getClientIp } from './_client-ip.js';
// @ts-expect-error JS module without declarations.
import { sha256Hex } from './_crypto.js';

/** Code lifetime. The browser redirects to the desktop immediately. */
export const DESKTOP_AUTH_CODE_TTL_SECONDS = 60;
/** Sign-in ticket lifetime. The desktop redeems it immediately. */
export const DESKTOP_AUTH_TICKET_TTL_SECONDS = 60;

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const REDIS_TIMEOUT_MS = 3_000;
const CLERK_TIMEOUT_MS = 5_000;
const USER_AGENT = 'worldmonitor-gateway/1.0';

export interface DesktopAuthCodeRecord {
  userId: string;
  codeChallenge: string;
}

export type MintTicketResult =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'refused'; status: number };

export type DesktopAuthAuditEvent = Record<string, string | number | null>;

export function isCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE_RE.test(value);
}

export function isCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_RE.test(value);
}

export function isCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && VERIFIER_RE.test(value);
}

/** Codes are stored by hash so a Redis read never yields a redeemable code. */
export async function desktopAuthCodeKey(code: string): Promise<string> {
  return `desktop-auth:code:${await sha256Hex(`desktop-auth:${code}`)}`;
}

export function newDesktopAuthCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Caller IP for audit lines, from the hardened extractor (no spoofable headers). */
export function clientIp(request: Request): string {
  return getClientIp(request);
}

/** One structured log line per decision. Never carries a code, verifier or ticket. */
export function logDesktopAuthEvent(event: DesktopAuthAuditEvent): void {
  console.info(JSON.stringify({ event: 'desktop-auth', ...event }));
}

// Raw (unprefixed) Upstash REST, like the `oauth:*` keys: the record must be
// visible to every deployment that serves /api/desktop-auth/token.
function redisConfig(): { url: string; token: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  return { url, token };
}

/** SET NX EX. False when the key exists; throws on transport failure. */
export async function storeDesktopAuthCode(
  key: string,
  record: DesktopAuthCodeRecord,
  ttlSeconds: number,
): Promise<boolean> {
  const { url, token } = redisConfig();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify([['SET', key, JSON.stringify(record), 'EX', ttlSeconds, 'NX']]),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const results = await response.json() as Array<{ result?: unknown; error?: string }>;
  if (results[0]?.error) throw new Error(`Redis error: ${results[0].error}`);
  return results[0]?.result === 'OK';
}

/** GETDEL. Null on a miss; throws on transport failure. */
export async function takeDesktopAuthCode(key: string): Promise<DesktopAuthCodeRecord | null> {
  const { url, token } = redisConfig();
  const response = await fetch(`${url}/getdel/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const data = await response.json() as { result?: string | null };
  if (!data?.result) return null;
  try {
    const record = JSON.parse(data.result) as Partial<DesktopAuthCodeRecord>;
    return typeof record.userId === 'string' && isCodeChallenge(record.codeChallenge)
      ? { userId: record.userId, codeChallenge: record.codeChallenge }
      : null;
  } catch {
    return null;
  }
}

/**
 * Mint a Clerk sign-in token (a "ticket"). A 4xx means Clerk refuses this
 * user (banned, locked, deleted) and is the user's problem, not an outage;
 * anything else throws.
 */
export async function mintClerkSignInTicket(userId: string): Promise<MintTicketResult> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error('CLERK_SECRET_KEY is not configured');
  const response = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: DESKTOP_AUTH_TICKET_TTL_SECONDS }),
    signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
  });
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    return { kind: 'refused', status: response.status };
  }
  if (!response.ok) throw new Error(`Clerk sign-in token failed with ${response.status}`);
  const body = await response.json() as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token) throw new Error('Clerk sign-in token response had no token');
  return { kind: 'ticket', ticket: body.token };
}
