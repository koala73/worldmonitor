/**
 * Public brief magazine endpoint.
 *
 * GET /api/brief/{userId}/{issueDate}?t={token}
 *   -> 200 text/html (rendered magazine)
 *   -> 403 on bad token (generic message, no userId echo)
 *   -> 404 on Redis miss (minimal "expired" HTML)
 *   -> 503 if BRIEF_URL_SIGNING_SECRET is not configured
 *
 * The HMAC-signed token in `?t=` is the sole credential. The route is
 * auth-less in the Clerk sense — whoever holds a valid URL can read
 * the magazine. URLs are delivered to users via already-authenticated
 * channels (push, email, dashboard panel).
 *
 * The Redis key brief:{userId}:{issueDate} is per-user and written by
 * the Phase 3 composer (not yet shipped). Until then every request
 * will 404 with a neutral expired page. That is intentional and
 * correct behaviour — the route is safe to deploy ahead of the
 * composer.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { renderBriefMagazine } from '../../../shared/render-brief-magazine.js';
import { verifyBriefToken, BriefUrlError } from '../../../server/_shared/brief-url';

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, max-age=0, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function htmlResponse(status: number, body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...HTML_HEADERS, ...extraHeaders },
  });
}

const EXPIRED_PAGE = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brief unavailable · WorldMonitor</title>
<style>
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  font-family: Georgia, serif; background: #0a0a0a; color: #f2ede4; text-align: center; padding: 2rem; }
h1 { font-size: clamp(28px, 5vw, 64px); margin: 0 0 1rem; font-weight: 900; letter-spacing: -0.02em; }
p { max-width: 48ch; opacity: 0.8; line-height: 1.5; font-size: clamp(16px, 2vw, 20px); }
a { color: inherit; text-decoration: underline; }
</style></head><body><div>
<h1>This brief has expired.</h1>
<p>Briefs are kept for seven days after they are issued. Your next brief will be delivered on schedule.</p>
<p><a href="https://worldmonitor.app">Return to WorldMonitor</a></p>
</div></body></html>`;

const FORBIDDEN_PAGE = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not authorised · WorldMonitor</title>
<style>
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  font-family: Georgia, serif; background: #0a0a0a; color: #f2ede4; text-align: center; padding: 2rem; }
h1 { font-size: clamp(28px, 5vw, 64px); margin: 0 0 1rem; font-weight: 900; letter-spacing: -0.02em; }
p { max-width: 48ch; opacity: 0.8; line-height: 1.5; font-size: clamp(16px, 2vw, 20px); }
a { color: inherit; text-decoration: underline; }
</style></head><body><div>
<h1>This link is no longer valid.</h1>
<p>The brief link you followed is incomplete or has been tampered with. Open the most recent notification from WorldMonitor to read today's brief.</p>
<p><a href="https://worldmonitor.app">Return to WorldMonitor</a></p>
</div></body></html>`;

async function readBriefEnvelope(userId: string, issueDate: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const key = `brief:${userId}:${issueDate}`;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { result?: string | null };
    if (!body.result) return null;
    return JSON.parse(body.result);
  } catch {
    return null;
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return new Response('Origin not allowed', { status: 403 });
  }

  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  const secret = process.env.BRIEF_URL_SIGNING_SECRET ?? '';
  const prevSecret = process.env.BRIEF_URL_SIGNING_SECRET_PREV || undefined;
  if (!secret) {
    console.error('[api/brief] BRIEF_URL_SIGNING_SECRET is not configured');
    return htmlResponse(503, '<h1>Service temporarily unavailable.</h1>');
  }

  // Extract path params from URL. Vercel edge functions surface them
  // via the URL pathname; we parse directly to avoid a runtime dep on
  // a route-params helper that may not be available.
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Expect: ['api', 'brief', '{userId}', '{issueDate}']
  const [root, route, rawUserId, rawIssueDate] = parts;
  if (parts.length !== 4 || root !== 'api' || route !== 'brief' || !rawUserId || !rawIssueDate) {
    return htmlResponse(404, EXPIRED_PAGE);
  }
  const userId = decodeURIComponent(rawUserId);
  const issueDate = decodeURIComponent(rawIssueDate);
  const token = url.searchParams.get('t') ?? '';

  let verified: boolean;
  try {
    verified = await verifyBriefToken(userId, issueDate, token, secret, prevSecret);
  } catch (err) {
    if (err instanceof BriefUrlError && err.code === 'missing_secret') {
      console.error('[api/brief] secret missing after handler start — env misconfigured');
      return htmlResponse(503, '<h1>Service temporarily unavailable.</h1>');
    }
    throw err;
  }
  if (!verified) {
    return htmlResponse(403, FORBIDDEN_PAGE);
  }

  const envelope = await readBriefEnvelope(userId, issueDate);
  if (!envelope) {
    return htmlResponse(404, EXPIRED_PAGE);
  }

  let html: string;
  try {
    html = renderBriefMagazine(envelope);
  } catch (err) {
    // Malformed envelope in Redis (composer bug, version drift, etc.)
    // We treat this as an expired brief from the reader's perspective
    // and log the details server-side. The renderer's assertion
    // message is safe to log (no secrets, no user content).
    console.error('[api/brief] renderBriefMagazine failed:', (err as Error).message);
    return htmlResponse(404, EXPIRED_PAGE);
  }

  return htmlResponse(200, html);
}
