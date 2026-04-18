/**
 * Brief carousel image endpoint (Phase 8).
 *
 * GET /api/brief/carousel/{userId}/{issueDate}/{page}?t={token}
 *   -> 200 image/png   cover | threads | story page. Cached 7d
 *                      immutable (CDN + Telegram) — safe because the
 *                      underlying envelope is immutable for the life
 *                      of the brief key.
 *   -> 403 on bad token (shared signer with the magazine route)
 *   -> 404 on Redis miss (no brief composed for that user/date)
 *   -> 404 on invalid page (must be one of 0, 1, 2)
 *   -> 503 on any renderer/runtime/font failure, with
 *      Cache-Control: no-store. NEVER returns a placeholder PNG —
 *      a 1x1 blank cached 7d immutable by Telegram + CDN is worse
 *      than a clean 503 that sendMediaGroup skips. The digest cron
 *      treats carousel failure as best-effort and still sends the
 *      long-form text message, and the next cron tick re-renders
 *      with a fresh cold start.
 *
 * The HMAC-signed `?t=` token is the sole credential — same token
 * pattern as the magazine HTML route, same signer secret, same
 * per-(userId, issueDate) binding. URLs go out over already-authed
 * channels (Telegram, Slack, Discord, email, push).
 *
 * Runtime: Node 20. The renderer uses @resvg/resvg-js (native
 * binding) — the WASM variant requires a `?url` asset import that
 * Vercel's edge bundler refuses ("Edge Function is referencing
 * unsupported modules"), blocking deploys. Node sidesteps the
 * bundler issue and is also faster per request. Cold start is
 * ~700ms, warm ~40ms — carousel images are not latency-critical.
 */

// Vercel functions accept only 'edge' | 'experimental-edge' | 'nodejs'
// as the runtime value. An unversioned 'nodejs' resolves to the
// project's default Node version (Node 20 here); a versioned
// 'nodejs20.x' is rejected at build time ("unsupported runtime
// value in config").
export const config = { runtime: 'nodejs' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../../../../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash } from '../../../../_upstash-json.js';
import { verifyBriefToken, BriefUrlError } from '../../../../../server/_shared/brief-url';
import { renderCarouselPng, pageFromIndex } from '../../../../../server/_shared/brief-carousel-render';

const PAGE_CACHE_TTL = 60 * 60 * 24 * 7; // 7 days — matches brief key TTL

const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonError(
  msg: string,
  status: number,
  cors: Record<string, string>,
  { noStore = false }: { noStore?: boolean } = {},
): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // On server-side errors we explicitly suppress caching so a
      // transient Google-Fonts / WASM-init / render glitch doesn't
      // get cached by Vercel's CDN or Telegram's media fetcher for
      // the life of the brief. Next request re-renders.
      ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
      ...cors,
    },
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
    // Render failures (WASM init, Satori, Google Fonts fetch, etc.)
    // MUST NOT return a placeholder 200. A 1x1 blank cached 7d
    // immutable by Telegram's media fetcher + Vercel's CDN would
    // lock in a broken preview for the full brief TTL per chat
    // message. sendMediaGroup will drop the whole carousel on a
    // non-2xx, but the digest cron's best-effort path continues
    // with the long-form text message, and the next cron tick
    // re-renders with a fresh cold start.
    console.error(
      `[api/brief/carousel] render failed for ${userId}/${issueDate}/${page}:`,
      (err as Error).message,
    );
    return jsonError('render_failed', 503, cors, { noStore: true });
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
