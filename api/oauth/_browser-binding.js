// Browser binding for the MCP OAuth consent nonce.
//
// `oauth:nonce:<n>` is minted on GET /oauth/authorize and then redeemed by
// whichever browser presents it: the API-key consent POST, or the Pro bridge
// at worldmonitor.app/mcp-grant (mint + authorize-pro). Without a binding, an
// attacker could start a flow on their own MCP client, copy the nonce out of
// the consent page, and send the victim the /mcp-grant?nonce=… link; the
// victim's approval would then deliver a code bound to the VICTIM's account to
// the attacker's redirect_uri and state.
//
// The GET sets a random first-party cookie and stores only its SHA-256 in the
// nonce record. Each flow has its own cookie name, so first-time parallel tabs
// cannot overwrite each other before either cookie reaches the browser.
//
// The cookie is scoped to Domain=worldmonitor.app because the flow crosses
// hosts (authorize can be served on apex/www/api, the native consent POST
// targets api.worldmonitor.app, the Pro bridge runs on the apex). SameSite=Lax
// is enough: every redemption is a same-site request.

import { sha256Hex } from '../_crypto.js';

export const OAUTH_BIND_COOKIE = '__Secure-wm_oauth_bind';
const BIND_MAX_AGE_SECONDS = 600; // matches the oauth:nonce TTL
const BIND_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function readOAuthBindCookie(req, name = OAUTH_BIND_COOKIE) {
  if (name !== OAUTH_BIND_COOKIE && (typeof name !== 'string' || !/^__Secure-wm_oauth_bind_[a-f0-9-]{36}$/.test(name))) return null;
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return BIND_VALUE_RE.test(value) ? value : null;
  }
  return null;
}

/** A fresh flow name cannot collide with another tab's first request. */
export function resolveOAuthBindValue(req, name = OAUTH_BIND_COOKIE) {
  return readOAuthBindCookie(req, name) ?? base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function oauthBindCookieHeader(value, req, name = OAUTH_BIND_COOKIE) {
  const host = (req.headers.get('host') ?? new URL(req.url).host).toLowerCase().replace(/:\d+$/, '');
  const domain = host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app') ? '; Domain=worldmonitor.app' : '';
  return `${name}=${value}; Max-Age=${BIND_MAX_AGE_SECONDS}; Path=/${domain}; Secure; HttpOnly; SameSite=Lax`;
}

export function hashOAuthBindValue(value) {
  return sha256Hex(`oauth-bind:${value}`);
}

/**
 * True when the request carries the cookie the nonce was bound to. Nonces
 * written before binding existed carry no `bind_hash` and expire within the
 * 10-minute nonce TTL, so they are accepted rather than failing in-flight
 * consents during a deploy.
 */
export async function requestMatchesOAuthBinding(req, nonceData) {
  const expected = nonceData?.bind_hash;
  if (expected === undefined) return true;
  if (typeof expected !== 'string' || expected.length !== 64) return false;
  const value = readOAuthBindCookie(req, nonceData.bind_cookie === undefined ? OAUTH_BIND_COOKIE : nonceData.bind_cookie);
  if (!value) return false;
  const actual = await hashOAuthBindValue(value);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
