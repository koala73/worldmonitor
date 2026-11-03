/**
 * One-click unsubscribe (RFC 8058) for recurring mail: the daily brief, the
 * real-time alert emails and the winback email.
 *
 * Token: `v1.<base64url(JSON {u, l})>.<hex HMAC-SHA256>` keyed by the
 * dedicated EMAIL_UNSUBSCRIBE_SECRET (Convex env only). Tokens carry a user id
 * and a list, never an email address, so the URL leaks no PII. They do not
 * expire: an unsubscribe link must keep working for as long as the mail sits
 * in an inbox. Rotating the secret invalidates every outstanding link.
 *
 * Tokens are minted only inside Convex: winback signs in-process, and the
 * Railway digest/relay workers receive pre-built URLs on the email channels
 * returned by /relay/channels, so the secret never leaves Convex.
 *
 * The URL points at the Convex HTTP route /email/unsubscribe. GET renders a
 * confirm page and never changes state (link scanners prefetch GETs); POST
 * unsubscribes without a login, which is what mail clients send for
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
 */

export const EMAIL_UNSUBSCRIBE_SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
export const EMAIL_UNSUBSCRIBE_PATH = "/email/unsubscribe";
const TOKEN_VERSION = "v1";
const MAX_TOKEN_LENGTH = 512;

export const UNSUBSCRIBE_LISTS = ["brief", "alerts", "marketing"] as const;
export type UnsubscribeList = (typeof UNSUBSCRIBE_LISTS)[number];

export function isUnsubscribeList(value: unknown): value is UnsubscribeList {
  return typeof value === "string" && (UNSUBSCRIBE_LISTS as readonly string[]).includes(value);
}

function readSecret(): string | null {
  const secret = process.env[EMAIL_UNSUBSCRIBE_SECRET_ENV];
  return secret && secret.trim() === secret && secret.length >= 16 ? secret : null;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function hmacHex(key: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(`email-unsubscribe:${payload}`));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns null when EMAIL_UNSUBSCRIBE_SECRET is not configured. */
export async function signUnsubscribeToken(userId: string, list: UnsubscribeList): Promise<string | null> {
  const secret = readSecret();
  if (!secret || !userId) return null;
  const payload = base64UrlEncode(JSON.stringify({ u: userId, l: list }));
  return `${TOKEN_VERSION}.${payload}.${await hmacHex(secret, `${TOKEN_VERSION}.${payload}`)}`;
}

export async function verifyUnsubscribeToken(
  token: string | null | undefined,
): Promise<{ userId: string; list: UnsubscribeList } | null> {
  const secret = readSecret();
  if (!secret || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [version, payload, signature] = parts as [string, string, string];
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const expected = await hmacHex(secret, `${version}.${payload}`);
  if (!timingSafeEqual(expected, signature)) return null;
  const json = base64UrlDecode(payload);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { u?: unknown; l?: unknown };
    if (typeof parsed.u !== "string" || !parsed.u || !isUnsubscribeList(parsed.l)) return null;
    return { userId: parsed.u, list: parsed.l };
  } catch {
    return null;
  }
}

function siteOrigin(): string | null {
  const raw = process.env.CONVEX_SITE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Absolute https URL for the one-click endpoint, or null when the secret or
 * the Convex site URL is missing (callers then send without the header and
 * fall back to a settings link in the footer).
 */
export async function buildUnsubscribeUrl(userId: string, list: UnsubscribeList): Promise<string | null> {
  const origin = siteOrigin();
  if (!origin) return null;
  const token = await signUnsubscribeToken(userId, list);
  if (!token) return null;
  return `${origin}${EMAIL_UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
}

/** RFC 2369 + RFC 8058 headers for a one-click https unsubscribe URL. */
export function listUnsubscribeHeaders(url: string | null | undefined): Record<string, string> | undefined {
  if (!url || !url.startsWith("https://")) return undefined;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
