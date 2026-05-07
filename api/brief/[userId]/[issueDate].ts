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
import { captureSilentError } from '../../_sentry-edge.js';
import { renderBriefMagazine } from '../../../server/_shared/brief-render.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash, redisPipeline } from '../../_upstash-json.js';
import { verifyBriefToken, BriefUrlError } from '../../../server/_shared/brief-url';
import {
  BRIEF_PUBLIC_POINTER_PREFIX,
  buildPublicBriefUrl,
  encodePublicPointer,
} from '../../../server/_shared/brief-share-url';

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, max-age=0, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function htmlResponse(
  req: Request,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Response {
  // HEAD must carry the same headers as GET but with an empty body
  // (RFC 7231 §4.3.2). We do this at the response-layer instead of
  // every call site to prevent drift.
  const isHead = req.method === 'HEAD';
  return new Response(isHead ? null : body, {
    status,
    headers: { ...HTML_HEADERS, ...extraHeaders },
  });
}

const ERROR_PAGE_STYLES = (
  'body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; '
  + 'font-family: Georgia, serif; background: #0a0a0a; color: #f2ede4; text-align: center; padding: 2rem; } '
  + 'h1 { font-size: clamp(28px, 5vw, 64px); margin: 0 0 1rem; font-weight: 900; letter-spacing: -0.02em; } '
  + 'p { max-width: 48ch; opacity: 0.8; line-height: 1.5; font-size: clamp(16px, 2vw, 20px); } '
  + 'a { color: inherit; text-decoration: underline; }'
);

function renderErrorPage(heading: string, body: string): string {
  return (
    '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${heading} · WorldMonitor</title>`
    + `<style>${ERROR_PAGE_STYLES}</style>`
    + '</head><body><div>'
    + `<h1>${heading}</h1>`
    + `<p>${body}</p>`
    + '<p><a href="https://worldmonitor.app">Return to WorldMonitor</a></p>'
    + '</div></body></html>'
  );
}

const EXPIRED_PAGE = renderErrorPage(
  'This brief has expired.',
  'Briefs are kept for seven days after they are issued. Your next brief will be delivered on schedule.',
);

const FORBIDDEN_PAGE = renderErrorPage(
  'This link is no longer valid.',
  "The brief link you followed is incomplete or has been tampered with. Open the most recent notification from WorldMonitor to read today's brief.",
);

const UNAVAILABLE_PAGE = renderErrorPage(
  'Service temporarily unavailable.',
  'The brief service is not fully configured. Please try again shortly.',
);

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
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
    return htmlResponse(req, 503, UNAVAILABLE_PAGE);
  }

  // Extract path params from URL. Vercel edge functions surface them
  // via the URL pathname; we parse directly to avoid a runtime dep on
  // a route-params helper that may not be available.
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Expect: ['api', 'brief', '{userId}', '{issueDate}']
  const [root, route, rawUserId, rawIssueDate] = parts;
  if (parts.length !== 4 || root !== 'api' || route !== 'brief' || !rawUserId || !rawIssueDate) {
    return htmlResponse(req, 404, EXPIRED_PAGE);
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
      return htmlResponse(req, 503, UNAVAILABLE_PAGE);
    }
    throw err;
  }
  if (!verified) {
    return htmlResponse(req, 403, FORBIDDEN_PAGE);
  }

  // The helper throws on infrastructure failure (Upstash down, config
  // missing, parse failure). Only a genuine miss returns null. We must
  // distinguish those two — a reader with a valid brief deserves a
  // "service unavailable" state during outages, not a misleading
  // "expired" page.
  let envelope: unknown;
  try {
    envelope = await readRawJsonFromUpstash(`brief:${userId}:${issueDate}`);
  } catch (err) {
    console.error('[api/brief] Upstash read failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/brief', step: 'envelope-read' }, ctx });
    return htmlResponse(req, 503, UNAVAILABLE_PAGE);
  }
  if (!envelope) {
    return htmlResponse(req, 404, EXPIRED_PAGE);
  }

  // Prepare the share URL (if BRIEF_SHARE_SECRET is set) so the Share
  // button in the rendered magazine can navigator.share / clipboard
  // the URL without having to make an authenticated fetch at click
  // time. The HMAC token already verified this reader legitimately
  // holds the per-user magazine URL, so deriving + materialising the
  // share pointer here is as safe as rendering the magazine at all.
  //
  // If the secret isn't configured or the pointer write fails, we
  // still render the magazine — the Share button just gracefully
  // hides (renderer requires options.shareUrl to emit the button).
  let shareUrl: string | undefined;
  const shareSecret = process.env.BRIEF_SHARE_SECRET;
  if (shareSecret) {
    try {
      const built = await buildPublicBriefUrl({
        userId,
        issueDate,
        baseUrl: new URL(req.url).origin,
        secret: shareSecret,
      });
      // Idempotent pointer write: same hash every call, so SET just
      // refreshes the TTL. JSON-stringify so readRawJsonFromUpstash
      // (which always JSON.parses) round-trips cleanly on the public
      // route — a bare string would throw at parse and 503 there.
      const pointerKey = `${BRIEF_PUBLIC_POINTER_PREFIX}${built.hash}`;
      const pointerValue = JSON.stringify(encodePublicPointer(userId, issueDate));
      const writeResult = await redisPipeline([
        ['SET', pointerKey, pointerValue, 'EX', '604800'],
      ]);
      if (writeResult != null) {
        shareUrl = built.url;
      } else {
        console.warn('[api/brief] pointer write failed; Share button will be hidden');
      }
    } catch (err) {
      console.warn('[api/brief] share URL derive failed:', (err as Error).message);
      captureSilentError(err, { tags: { route: 'api/brief', step: 'share-url-derive', severity: 'warn' }, ctx });
    }
  }

  // Cast to BriefEnvelope; renderBriefMagazine runs its own
  // assertBriefEnvelope at the top and will throw on any shape
  // mismatch, which we catch below.
  let html: string;
  try {
    html = renderBriefMagazine(
      envelope as Parameters<typeof renderBriefMagazine>[0],
      { shareUrl },
    );
  } catch (err) {
    // Malformed envelope in Redis (composer bug, version drift, etc.)
    // We treat this as an expired brief from the reader's perspective
    // and log the details server-side. The renderer's assertion
    // message is safe to log (no secrets, no user content).
    console.error('[api/brief] malformed envelope for brief:*:*:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/brief', step: 'malformed-envelope' }, ctx });
    // Distinct log tag so ops can grep composer-bug vs Redis-miss. User
    // still sees the neutral "expired" page.
    return htmlResponse(req, 404, EXPIRED_PAGE);
  }

  return htmlResponse(req, 200, html);
}
