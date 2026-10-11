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
// nonce record. Redemption requires the same cookie. One cookie value is reused
// across concurrent flows in a browser, so parallel tabs keep working.
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

export function readOAuthBindCookie(req) {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== OAUTH_BIND_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return BIND_VALUE_RE.test(value) ? value : null;
  }
  return null;
}

/** Reuses the browser's existing binding value, or mints a fresh one. */
export function resolveOAuthBindValue(req) {
  return readOAuthBindCookie(req) ?? base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function oauthBindCookieHeader(value, req) {
  const host = (req.headers.get('host') ?? new URL(req.url).host).toLowerCase().replace(/:\d+$/, '');
  const domain = host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app') ? '; Domain=worldmonitor.app' : '';
  return `${OAUTH_BIND_COOKIE}=${value}; Max-Age=${BIND_MAX_AGE_SECONDS}; Path=/${domain}; Secure; HttpOnly; SameSite=Lax`;
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
  const value = readOAuthBindCookie(req);
  if (!value) return false;
  const actual = await hashOAuthBindValue(value);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
