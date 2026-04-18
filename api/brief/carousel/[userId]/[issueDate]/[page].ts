/**
 * Brief carousel image endpoint (Phase 8).
 *
 * GET /api/brief/carousel/{userId}/{issueDate}/{page}?t={token}
 *   -> 200 image/png  (cover | threads | story page of the brief)
 *   -> 403 on bad token (shared signer with the magazine route)
 *   -> 404 on Redis miss (no brief composed for that user/date)
 *   -> 404 on invalid page (must be one of 0, 1, 2)
 *   -> 503 if BRIEF_URL_SIGNING_SECRET is not configured
 *
 * The HMAC-signed `?t=` token is the sole credential — same token
 * pattern as the magazine HTML route, same signer secret, same
 * per-(userId, issueDate) binding. URLs go out over already-authed
 * channels (Telegram, Slack, Discord, email, push).
 *
 * Node runtime is used rather than Edge because @resvg/resvg-wasm
 * needs a real Uint8Array buffer for the Noto Serif font fetch, and
 * Vercel Edge's fetch response buffer semantics around WASM init are
 * fussier than Node's. Cold start is ~700ms, warm ~40ms — carousel
 * images aren't latency-critical.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../../../../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash } from '../../../../_upstash-json.js';
import { verifyBriefToken, BriefUrlError } from '../../../../../server/_shared/brief-url';
import { renderCarouselPng, pageFromIndex } from '../../../../../server/_shared/brief-carousel-render';

const PAGE_CACHE_TTL = 60 * 60 * 24 * 7; // 7 days — matches brief key TTL

const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function errorPng(): Uint8Array {
  // 1×1 transparent PNG — placeholder so the channel's preview
  // collapses gracefully on any unrecoverable error. Avoids
  // "broken image" icons while we log and alert server-side.
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

function jsonError(msg: string, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return new Response('Origin not allowed', { status: 403 });
  }
  const cors = getCorsHeaders(req, 'GET, OPTIONS') as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return jsonError('Method not allowed', 405, cors);
  }

  const secret = process.env.BRIEF_URL_SIGNING_SECRET ?? '';
  if (!secret) {
    console.error('[api/brief/carousel] BRIEF_URL_SIGNING_SECRET is not configured');
    return jsonError('service_unavailable', 503, cors);
  }

  // Parse URL: /api/brief/carousel/{userId}/{issueDate}/{page}
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // parts = ['api', 'brief', 'carousel', userId, issueDate, page]
  if (parts.length < 6) return jsonError('bad_path', 400, cors);
  const userId = parts[3]!;
  const issueDate = parts[4]!;
  const pageRaw = parts[5]!;

  if (!ISSUE_DATE_RE.test(issueDate)) return jsonError('invalid_issue_date', 400, cors);

  const pageIdx = Number.parseInt(pageRaw, 10);
  const page = pageFromIndex(pageIdx);
  if (!page) return jsonError('invalid_page', 404, cors);

  const token = url.searchParams.get('t') ?? '';
  const prev = process.env.BRIEF_URL_SIGNING_SECRET_PREV ?? undefined;
  try {
    const ok = await verifyBriefToken(userId, issueDate, token, secret, prev);
    if (!ok) return jsonError('forbidden', 403, cors);
  } catch (err) {
    if (err instanceof BriefUrlError) {
      return jsonError('forbidden', 403, cors);
    }
    throw err;
  }

  // Load the envelope — same Redis key the magazine route reads.
  let envelope;
  try {
    envelope = await readRawJsonFromUpstash(`brief:${userId}:${issueDate}`);
  } catch (err) {
    console.error('[api/brief/carousel] Upstash read failed:', (err as Error).message);
    return jsonError('service_unavailable', 503, cors);
  }
  if (!envelope) return jsonError('not_found', 404, cors);

  let png: Uint8Array;
  try {
    png = await renderCarouselPng(envelope, page);
  } catch (err) {
    console.error(`[api/brief/carousel] render failed for ${userId}/${issueDate}/${page}:`, (err as Error).message);
    // Serve a 1x1 transparent PNG so Telegram's sendMediaGroup call
    // doesn't choke on an HTML error body. 503 is still wrong here —
    // the client channel can't retry a push anyway. Log and move on.
    png = errorPng();
  }

  const headers: Record<string, string> = {
    ...cors,
    'Content-Type': 'image/png',
    // Long cache: the envelope behind the image is immutable for the
    // life of that brief key. If the composer rewrites the brief, the
    // key's TTL doesn't change, so the image is still valid. Browsers
    // and Telegram caches will happily reuse.
    'Cache-Control': `public, max-age=${PAGE_CACHE_TTL}, s-maxage=${PAGE_CACHE_TTL}, immutable`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  if (req.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  // Cast to BodyInit-compatible buffer view. Vercel edge + Node runtimes
  // both accept a Uint8Array at runtime; lib.dom's BodyInit union is
  // narrower than the actual accepted set.
  return new Response(png as unknown as BodyInit, { status: 200, headers });
}
