/**
 * Public shared-brief route.
 *
 * GET /api/brief/public/{hash}?ref={code}
 *   -> 200 text/html rendered in public mode (whyMatters stripped,
 *                    greeting & user name generic, Subscribe CTA)
 *   -> 404 on bad hash shape, missing pointer, or missing target brief
 *            (all "shared brief not found / expired" from the
 *            recipient's perspective; no distinguishing signal)
 *   -> 503 when Upstash is unreachable
 *
 * Unlike /api/brief/{userId}/{issueDate} which is HMAC-token-gated
 * and personalised, this route is unauth'd. The hash in the URL is
 * the credential — anyone holding a valid hash reads the public
 * mirror until the pointer expires (7 days).
 *
 * Robots: emits X-Robots-Tag: noindex, nofollow so search engines
 * never enumerate per-user shared briefs.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash } from '../../_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../_sentry-edge.js';
import { renderBriefMagazine } from '../../../server/_shared/brief-render.js';
import {
  BRIEF_PUBLIC_POINTER_PREFIX,
  decodePublicPointer,
  isValidShareHashShape,
} from '../../../server/_shared/brief-share-url';

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // Short edge cache — a shared brief rarely changes within the same
  // day and we want CDN absorption for viral traffic, but not so long
  // that a composer re-write (unusual) gets stuck.
  'Cache-Control': 'public, max-age=0, s-maxage=300, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Critical: keep shared briefs out of public indexes. A per-user
  // mirror leaking into Google search would be both a privacy
  // regression (shared ≠ public forever) and a UX embarrassment.
  'X-Robots-Tag': 'noindex, nofollow',
};

function htmlResponse(
  req: Request,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Response {
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
    + '<meta name="robots" content="noindex,nofollow">'
    + `<title>${heading} · WorldMonitor</title>`
    + `<style>${ERROR_PAGE_STYLES}</style>`
    + '</head><body><div>'
    + `<h1>${heading}</h1>`
    + `<p>${body}</p>`
    + '<p><a href="https://worldmonitor.app/pro">Start your own WorldMonitor Brief</a></p>'
    + '</div></body></html>'
  );
}

const NOT_FOUND_PAGE = renderErrorPage(
  'This brief is no longer available.',
  'Shared briefs are kept for up to seven days. The sender can generate a fresh link to today\'s issue.',
);

const UNAVAILABLE_PAGE = renderErrorPage(
  'Service temporarily unavailable.',
  'The brief service is having trouble right now. Please try again shortly.',
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

  // Extract the hash from the URL pathname. Expect:
  //   ['api', 'brief', 'public', '{hash}']
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    parts.length !== 4
    || parts[0] !== 'api'
    || parts[1] !== 'brief'
    || parts[2] !== 'public'
  ) {
    return htmlResponse(req, 404, NOT_FOUND_PAGE);
  }
  const rawHash = decodeURIComponent(parts[3] ?? '');
  if (!isValidShareHashShape(rawHash)) {
    return htmlResponse(req, 404, NOT_FOUND_PAGE);
  }

  // Pass-through for the optional ?ref= referral attribution. We only
  // interpolate it into the CTA link later; drop anything over 32
  // chars defensively so it can't be a smuggled payload.
  const refCodeRaw = url.searchParams.get('ref');
  const refCode = refCodeRaw && /^[A-Za-z0-9_-]{1,32}$/.test(refCodeRaw)
    ? refCodeRaw
    : undefined;

  // Step 1: resolve pointer → {userId, issueDate}.
  const pointerKey = `${BRIEF_PUBLIC_POINTER_PREFIX}${rawHash}`;
  let pointerRaw: unknown;
  try {
    pointerRaw = await readRawJsonFromUpstash(pointerKey);
  } catch (err) {
    console.error('[api/brief/public] pointer read failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/brief/public', step: 'pointer-read' }, ctx });
    return htmlResponse(req, 503, UNAVAILABLE_PAGE);
  }
  // The pointer is JSON-encoded at write time (both
  // api/brief/share-url.ts and api/brief/[userId]/[issueDate].ts
  // JSON.stringify the encoded string before SET). readRawJsonFromUpstash
  // parses it back to a bare JS string, which decodePublicPointer
  // handles directly. We also accept an object form ({userId, issueDate})
  // as defence-in-depth in case a future writer switches the wire
  // format — a non-string/non-object (or a string that fails to decode)
  // falls through to null and we 404.
  //
  // NOTE: if a v0-bug value ever lands in Redis (raw colon-delimited
  // string without JSON quotes), readRawJsonFromUpstash throws at
  // JSON.parse and the catch block above returns 503 — that is the
  // intended (loud) failure mode so the bug isn't silently served.
  const pointer =
    typeof pointerRaw === 'string'
      ? decodePublicPointer(pointerRaw)
      : decodePublicPointer(
          pointerRaw != null && typeof pointerRaw === 'object'
            ? `${(pointerRaw as { userId?: string }).userId}:${(pointerRaw as { issueDate?: string }).issueDate}`
            : null,
        );
  if (!pointer) {
    return htmlResponse(req, 404, NOT_FOUND_PAGE);
  }

  // Step 2: resolve the actual brief envelope.
  let envelope: unknown;
  try {
    envelope = await readRawJsonFromUpstash(`brief:${pointer.userId}:${pointer.issueDate}`);
  } catch (err) {
    console.error('[api/brief/public] envelope read failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/brief/public', step: 'envelope-read' }, ctx });
    return htmlResponse(req, 503, UNAVAILABLE_PAGE);
  }
  if (!envelope) {
    // Pointer out-lived the brief. Treat identically to the
    // recipient's "not found" experience rather than exposing the
    // (userId, date) pair this would represent.
    return htmlResponse(req, 404, NOT_FOUND_PAGE);
  }

  let html: string;
  try {
    html = renderBriefMagazine(
      envelope as Parameters<typeof renderBriefMagazine>[0],
      { publicMode: true, refCode },
    );
  } catch (err) {
    console.error('[api/brief/public] malformed envelope:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/brief/public', step: 'render' }, ctx });
    return htmlResponse(req, 404, NOT_FOUND_PAGE);
  }

  return htmlResponse(req, 200, html);
}
