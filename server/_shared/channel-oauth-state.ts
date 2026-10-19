/**
 * State record for the Slack and Discord webhook OAuth popups.
 *
 * `start` stores the state keyed by a random token and `callback` consumes it.
 * The state used to hold only the userId, so it was bound to the account that
 * started the flow but not to the browser: a Pro user could send someone else
 * their `oauthUrl`, and that person's approval would attach THEIR Slack or
 * Discord channel to the sender's account (and its alert rules).
 *
 * The record now also carries:
 * - `bindHash`: SHA-256 of a random value held in a flow-specific HttpOnly cookie. The callback refuses a request that does not present it.
 * - `openerOrigin`: the app origin that called `start`. The callback posts its
 *   result only to that origin instead of `'*'`, so a page that opened the
 *   popup itself cannot read the channel and workspace names.
 */

// @ts-expect-error — JS module, no declaration file
import { isDisallowedOrigin } from '../../api/_cors.js';

export type ChannelOAuthProvider = 'slack' | 'discord';

export interface ChannelOAuthState {
  userId: string;
  bindHash: string;
  openerOrigin: string;
  cookieName?: string;
}

const COOKIE_MAX_AGE_SECONDS = 600; // matches the state TTL
const BIND_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_OPENER_ORIGIN = 'https://worldmonitor.app';

export function channelOAuthCookieName(provider: ChannelOAuthProvider): string {
  return `__Secure-wm_${provider}_oauth`;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hashBindValue(provider: ChannelOAuthProvider, value: string): Promise<string> {
  return sha256Hex(`${provider}-oauth-bind:${value}`);
}

function cookieDomainAttr(req: Request): string {
  const host = (req.headers.get('host') ?? new URL(req.url).host).toLowerCase().replace(/:\d+$/, '');
  return host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app') ? '; Domain=worldmonitor.app' : '';
}

/** The trusted app origin that called `start`. */
function resolveOpenerOrigin(req: Request): string {
  const origin = req.headers.get('origin');
  if (!origin) return DEFAULT_OPENER_ORIGIN;
  if (!isDisallowedOrigin(req) || origin === new URL(req.url).origin) return origin;
  return DEFAULT_OPENER_ORIGIN;
}

/**
 * Builds the record `start` stores and the Set-Cookie header it returns.
 * Each flow owns a separate cookie, including simultaneous first requests.
 * The binding value also goes to the authenticated caller for a top-level
 * popup POST, where browsers can store it without third-party cookies.
 */
export async function createChannelOAuthState(
  provider: ChannelOAuthProvider,
  req: Request,
  userId: string,
): Promise<{ record: string; setCookie: string; bindValue: string }> {
  const bindValue = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const cookieName = `${channelOAuthCookieName(provider)}_${crypto.randomUUID()}`;
  const state: ChannelOAuthState = {
    userId,
    cookieName,
    bindHash: await hashBindValue(provider, bindValue),
    openerOrigin: resolveOpenerOrigin(req),
  };
  const setCookie = channelOAuthCookieHeader(req, state, bindValue);
  return { record: JSON.stringify(state), setCookie, bindValue };
}

export function parseChannelOAuthState(raw: string | null): ChannelOAuthState | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const { userId, bindHash, openerOrigin, cookieName } = parsed as Record<string, unknown>;
  if (typeof userId !== 'string' || !userId) return null;
  if (typeof bindHash !== 'string' || !/^[0-9a-f]{64}$/.test(bindHash)) return null;
  if (typeof openerOrigin !== 'string' || !/^https?:\/\/[^/]+$/.test(openerOrigin)) return null;
  if (cookieName !== undefined && (typeof cookieName !== 'string' || !/^__Secure-wm_(slack|discord)_oauth_[a-f0-9-]{36}$/.test(cookieName))) return null;
  return { userId, bindHash, openerOrigin, ...(typeof cookieName === 'string' ? { cookieName } : {}) };
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return BIND_VALUE_RE.test(value) ? value : null;
  }
  return null;
}

export async function callbackMatchesBrowser(
  provider: ChannelOAuthProvider,
  req: Request,
  state: ChannelOAuthState,
): Promise<boolean> {
  const name = state.cookieName ?? channelOAuthCookieName(provider);
  if (!name.startsWith(channelOAuthCookieName(provider))) return false;
  const value = readCookie(req, name);
  return channelOAuthBindingMatches(provider, value, state);
}

export function channelOAuthCookieHeader(req: Request, state: ChannelOAuthState, value: string): string {
  return `${state.cookieName}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/${cookieDomainAttr(req)}; Secure; HttpOnly; SameSite=Lax`;
}

export async function channelOAuthBindingMatches(
  provider: ChannelOAuthProvider,
  value: string | null,
  state: ChannelOAuthState,
): Promise<boolean> {
  if (!value || !BIND_VALUE_RE.test(value)) return false;
  const actual = await hashBindValue(provider, value);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ state.bindHash.charCodeAt(i);
  return diff === 0;
}
