/**
 * Brief carousel image endpoint (Phase 8).
 *
 * GET /api/brief/carousel/{userId}/{issueSlot}/{page}?t={token}
 *   -> 200 image/png   cover | threads | story page. Cached 7d
 *                      immutable (CDN + Telegram) — safe because the
 *                      underlying envelope is immutable for the life
 *                      of the brief key.
 *   -> 403 on bad token (shared signer with the magazine route)
 *   -> 404 on Redis miss (no brief composed for that user/slot)
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
 * per-(userId, issueSlot) binding. URLs go out over already-authed
 * channels (Telegram, Slack, Discord, email, push).
 *
 * Runtime: Edge (via @vercel/og). Earlier attempts — direct satori +
 * @resvg/resvg-wasm and satori + @resvg/resvg-js native binding —
 * each hit a different Vercel bundler footgun (asset-URL refusal
 * on one path, nft missing the conditional native peer on the
 * other). @vercel/og is the first-party wrapper that handles both.
 * Cold start ~300ms, warm ~30ms.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../../../../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash } from '../../../../_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../_sentry-edge.js';
import { verifyBriefToken, BriefUrlError } from '../../../../../server/_shared/brief-url';
import { renderCarouselImageResponse, pageFromIndex } from '../../../../../server/_shared/brief-carousel-render';

// Matches the signer's slot format (YYYY-MM-DD-HHMM).
const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

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
      ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
      ...cors,
    },
  });
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
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

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // parts = ['api', 'brief', 'carousel', userId, issueSlot, page]
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

  let envelope;
  try {
    envelope = await readRawJsonFromUpstash(`brief:${userId}:${issueDate}`);
  } catch (err) {
    console.error('[api/brief/carousel] Upstash read failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/brief/carousel', step: 'envelope-read' }, ctx });
    return jsonError('service_unavailable', 503, cors);
  }
  if (!envelope) return jsonError('not_found', 404, cors);

  // @vercel/og sets its own default Cache-Control
  // (`public, immutable, no-transform, max-age=31536000`). Passing
  // another Cache-Control via extraHeaders would APPEND rather than
  // override, producing a comma-joined duplicate. The default 1-year
  // immutable is fine here — the underlying envelope is immutable
  // for the life of its 7d Redis TTL, and stale-past-TTL requests
  // just 404 at the route before reaching render. Browsers +
  // Telegram's media cache happily reuse.
  const extraHeaders: Record<string, string> = {
    ...cors,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  try {
    const response = await renderCarouselImageResponse(envelope, page, extraHeaders);
    if (req.method === 'HEAD') {
      // ImageResponse doesn't expose a HEAD mode, so echo the status
      // and headers without the body. Telegram's preflight + CDN
      // validation both respect this.
      return new Response(null, { status: 200, headers: response.headers });
    }
    return response;
  } catch (err) {
    console.error(
      `[api/brief/carousel] render failed for ${userId}/${issueDate}/${page}:`,
      (err as Error).message,
    );
    captureSilentError(err, {
      tags: { route: 'api/brief/carousel', step: 'render', page: String(page) },
      ctx,
    });
    return jsonError('render_failed', 503, cors, { noStore: true });
  }
}
