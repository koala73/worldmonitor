/**
 * POST /api/brief/share-url?date=YYYY-MM-DD
 *   -> 200 { shareUrl, hash, issueDate }           on success
 *   -> 401 UNAUTHENTICATED                         on missing/bad JWT
 *   -> 403 pro_required                            for non-PRO users
 *   -> 400 invalid_date_shape / invalid_payload    on bad inputs
 *   -> 404 brief_not_found                         when the per-user
 *            brief key is missing (reader can't share what doesn't exist)
 *   -> 503 service_unavailable                     on env/Upstash failure
 *
 * Materialises the brief:public:{hash} pointer used by the unauth'd
 * /api/brief/public/{hash} route. Idempotent — the hash is a pure
 * function of {userId, issueDate, BRIEF_SHARE_SECRET}, so repeated
 * calls for the same reader+date always return the same URL and
 * overwrite the pointer with the same value (refreshing its TTL).
 *
 * Writing the pointer LAZILY (on share, not on compose) keeps the
 * composer side-effect-free and means public URLs only exist for
 * briefs a user has actively chosen to share. A pointer that never
 * gets written simply means nobody shared that brief.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash, redisPipeline } from '../_upstash-json.js';
import { validateBearerToken } from '../../server/auth-session';
import { getEntitlements } from '../../server/_shared/entitlement-check';
import {
  BriefShareUrlError,
  BRIEF_PUBLIC_POINTER_PREFIX,
  buildPublicBriefUrl,
  encodePublicPointer,
} from '../../server/_shared/brief-share-url';

const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Public pointer lives as long as the brief key itself (7 days), so
// the share link works for the entire TTL window even if the user
// clicks Share on day 6. Using the same constant as the composer
// (see scripts/seed-digest-notifications.mjs BRIEF_TTL_SECONDS)
// keeps the two sides in lockstep.
const BRIEF_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Public base URL for the share links we mint. Pinned to
 * WORLDMONITOR_PUBLIC_BASE_URL in prod to prevent host-header
 * reflection from producing share URLs pointing at preview deploys
 * or other non-canonical origins.
 */
function publicBaseUrl(req: Request): string {
  const pinned = process.env.WORLDMONITOR_PUBLIC_BASE_URL;
  if (pinned) return pinned.replace(/\/+$/, '');
  return new URL(req.url).origin;
}

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);

  const session = await validateBearerToken(jwt);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const ent = await getEntitlements(session.userId);
  if (!ent || ent.features.tier < 1) {
    return jsonResponse(
      { error: 'pro_required', message: 'Sharing is available on the Pro plan.' },
      403,
      cors,
    );
  }

  const secret = process.env.BRIEF_SHARE_SECRET ?? '';
  if (!secret) {
    console.error('[api/brief/share-url] BRIEF_SHARE_SECRET is not configured');
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  // Date may come from ?date=YYYY-MM-DD OR from a JSON body. Supporting
  // both makes the call site in the magazine Share button trivial
  // (send a POST with an empty body + query param) and leaves room for
  // future extension (e.g. refCode) via the body.
  const url = new URL(req.url);
  let issueDate = url.searchParams.get('date');
  let refCode: string | undefined;
  if (!issueDate || req.headers.get('content-type')?.includes('application/json')) {
    try {
      const body = (await req.json().catch(() => null)) as
        | { date?: unknown; refCode?: unknown }
        | null;
      if (!issueDate && typeof body?.date === 'string') issueDate = body.date;
      if (typeof body?.refCode === 'string' && body.refCode.length > 0 && body.refCode.length <= 32) {
        refCode = body.refCode;
      }
    } catch {
      /* ignore — empty body is fine when ?date= carries the value */
    }
  }

  if (!issueDate || !ISSUE_DATE_RE.test(issueDate)) {
    return jsonResponse({ error: 'invalid_date_shape' }, 400, cors);
  }

  // Ensure the per-user brief actually exists before minting a share
  // URL — otherwise the public route would 404 on the recipient's
  // click and the sender wouldn't know why. A read-before-write also
  // gives a clean 503 path if Upstash is down.
  let existing: unknown;
  try {
    existing = await readRawJsonFromUpstash(`brief:${session.userId}:${issueDate}`);
  } catch (err) {
    console.error('[api/brief/share-url] Upstash read failed:', (err as Error).message);
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }
  if (existing == null) {
    return jsonResponse({ error: 'brief_not_found' }, 404, cors);
  }

  let shareUrl: string;
  let hash: string;
  try {
    const built = await buildPublicBriefUrl({
      userId: session.userId,
      issueDate,
      baseUrl: publicBaseUrl(req),
      secret,
      refCode,
    });
    shareUrl = built.url;
    hash = built.hash;
  } catch (err) {
    if (err instanceof BriefShareUrlError) {
      console.error(`[api/brief/share-url] ${err.code}: ${err.message}`);
      return jsonResponse({ error: 'service_unavailable' }, 503, cors);
    }
    throw err;
  }

  // Idempotent pointer write. Same {userId, issueDate, secret} always
  // produces the same hash, so this SET overwrites with an identical
  // value on repeat shares and resets the TTL window.
  //
  // CRITICAL: store as JSON-encoded so readRawJsonFromUpstash() on the
  // public route round-trips successfully. That helper always
  // JSON.parse's the Redis value; a bare colon-delimited string would
  // throw at parse time and the public route would 503 instead of
  // resolving the pointer.
  const pointerKey = `${BRIEF_PUBLIC_POINTER_PREFIX}${hash}`;
  const pointerValue = JSON.stringify(encodePublicPointer(session.userId, issueDate));
  const writeResult = await redisPipeline([
    ['SET', pointerKey, pointerValue, 'EX', String(BRIEF_TTL_SECONDS)],
  ]);
  if (writeResult == null) {
    console.error('[api/brief/share-url] pointer write failed');
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  return jsonResponse({ shareUrl, hash, issueDate }, 200, cors);
}
