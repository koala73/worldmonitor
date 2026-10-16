// Password gate for a hosted desk (a venue computer opens a URL and logs in).
// Off on the stage laptop: with no DESK_PASSWORD the desk stays localhost-only.
// The session cookie is an HMAC of its expiry, keyed by the password, so
// changing DESK_PASSWORD signs everyone out.

import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'desk_session';
const SESSION_MS = 12 * 60 * 60_000;

export const password = () => process.env.DESK_PASSWORD || '';
export const enabled = () => password().length > 0;

const sign = (expires) => createHmac('sha256', password()).update(`desk:${expires}`).digest('base64url');

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sessionCookie(now = Date.now(), secure = true) {
  const expires = now + SESSION_MS;
  return `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function authorized(req, now = Date.now()) {
  if (!enabled()) return true;
  const raw = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [expires, mac] = raw.slice(COOKIE.length + 1).split('.');
  return Number(expires) > now && same(mac ?? '', sign(expires));
}

export const passwordMatches = (given) => enabled() && same(given ?? '', password());

export const LOGIN_PAGE = (failed) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verification Desk</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070a;color:#e8edf2;font:16px/1.4 system-ui,sans-serif}
  form{display:grid;gap:12px;width:min(320px,90vw)}
  h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#8fa3b5;margin:0 0 8px}
  input,button{font:inherit;padding:12px;border-radius:6px;border:1px solid #2a3540;background:#0d1217;color:inherit}
  button{background:#e8edf2;color:#05070a;border:0;cursor:pointer;font-weight:600}
  p{color:#ff7a6b;margin:0;font-size:14px}
</style></head>
<body><form method="post" action="/login">
  <h1>WorldMonitor · Verification Desk</h1>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
  <button type="submit">Open the desk</button>
  ${failed ? '<p>Wrong password.</p>' : ''}
</form></body></html>`;
