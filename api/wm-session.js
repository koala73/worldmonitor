// POST /api/wm-session — issues an HMAC-signed session token for anonymous
// browser access. The frontend calls this once at app boot, caches the token
// in sessionStorage, and includes it on subsequent API calls. See _session.js
// and the issue #3541 / #3554 discussion for the threat-model rationale.

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { checkRateLimit } from './_rate-limit.js';
import { issueSessionToken } from './_session.js';

export const config = { runtime: 'edge' };

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export default async function handler(req) {
  if (isDisallowedOrigin(req)) {
    return new Response('Forbidden', { status: 403 });
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  // Rate-limit per IP. Without this, an attacker can farm tokens cheaply.
  // Token TTL is 12h, so a sustained ~1 RPS yields 86400 tokens/day per IP —
  // the existing IP cap (600/min) keeps that bounded.
  const rl = await checkRateLimit(req, cors);
  if (rl) return rl;

  let issued;
  try {
    issued = await issueSessionToken();
  } catch {
    // WM_SESSION_SECRET missing — fail closed. 503 signals "configure me",
    // not "you're rejected." Operator-visible.
    return jsonResponse({ error: 'Session service not configured' }, 503, cors);
  }

  return jsonResponse({ token: issued.token, exp: issued.exp }, 200, cors);
}
