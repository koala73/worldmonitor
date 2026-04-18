/**
 * Latest-brief preview endpoint.
 *
 * GET /api/latest-brief (Clerk JWT required, PRO tier gated)
 *   -> 200 { issueDate, dateLong, greeting, threadCount, magazineUrl }
 *      when a composed brief exists for this user.
 *   -> 200 { status: 'composing' }  when the composer has not yet
 *      produced today's brief. The dashboard panel uses this to
 *      render an empty state instead of an error.
 *   -> 401 UNAUTHENTICATED on missing/bad JWT
 *   -> 403 pro_required for non-PRO users
 *   -> 503 if BRIEF_URL_SIGNING_SECRET is not configured
 *
 * The returned magazineUrl is freshly signed per request. It is safe
 * to expose to the authenticated client — the HMAC binds {userId,
 * issueDate} so it is only useful to the owner.
 *
 * The route does NOT drive composition. It is a read-only mirror of
 * whatever brief:{userId}:{issueDate} Redis happens to hold.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash } from './_upstash-json.js';
import { validateBearerToken } from '../server/auth-session';
import { getEntitlements } from '../server/_shared/entitlement-check';
import { signBriefUrl, BriefUrlError } from '../server/_shared/brief-url';
import { assertBriefEnvelope } from '../server/_shared/brief-render.js';

const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayInUtc(): string {
  return utcDateOffset(0);
}

async function readBriefPreview(
  userId: string,
  issueDate: string,
): Promise<{ dateLong: string; greeting: string; threadCount: number } | null> {
  const raw = await readRawJsonFromUpstash(`brief:${userId}:${issueDate}`);
  if (raw == null) return null;
  // Reuse the renderer's strict validator so a "ready" preview never
  // points at an envelope that the hosted magazine route will reject.
  // A Redis-resident key that fails assertion is a composer bug — log
  // and treat as a miss so the dashboard panel shows "composing"
  // rather than "ready with a broken link".
  try {
    assertBriefEnvelope(raw);
  } catch (err) {
    console.error(
      `[api/latest-brief] composer-bug: brief:${userId}:${issueDate} failed envelope assertion: ${(err as Error).message}`,
    );
    return null;
  }
  const { data } = raw;
  return {
    dateLong: data.dateLong,
    greeting: data.digest.greeting,
    threadCount: data.stories.length,
  };
}

/**
 * Public base URL for signed magazine links. Pinned to
 * WORLDMONITOR_PUBLIC_BASE_URL in production to prevent host-header
 * reflection from minting URLs pointing at preview deploys or other
 * non-canonical origins. Falls back to the request origin only in
 * dev-ish contexts where the env var is absent.
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

  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const session = await validateBearerToken(jwt);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const ent = await getEntitlements(session.userId);
  if (!ent || ent.features.tier < 1) {
    return jsonResponse(
      {
        error: 'pro_required',
        message: 'The Brief is available on the Pro plan.',
        upgradeUrl: 'https://worldmonitor.app/pro',
      },
      403,
      cors,
    );
  }

  const secret = process.env.BRIEF_URL_SIGNING_SECRET ?? '';
  if (!secret) {
    console.error('[api/latest-brief] BRIEF_URL_SIGNING_SECRET is not configured');
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  // Determine which issue slot to probe.
  //  - If the client passes ?date=YYYY-MM-DD, use that verbatim. The
  //    dashboard panel should always take this path — it knows the
  //    user's local tz and computes the local date exactly.
  //  - Otherwise walk [tomorrow, today, yesterday] UTC in that order.
  //    The composer writes per user tz; a user at UTC+14 has today's
  //    brief under tomorrow UTC, a user at UTC-12 has it under
  //    yesterday UTC. Three candidates cover the full tz range
  //    without needing a tz database in the edge runtime. The order
  //    (tomorrow-first) naturally prefers the most recently composed
  //    slot.
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  if (dateParam !== null && !ISSUE_DATE_RE.test(dateParam)) {
    return jsonResponse({ error: 'invalid_date_shape' }, 400, cors);
  }
  const todayUtc = todayInUtc();
  const candidates = dateParam
    ? [dateParam]
    : [utcDateOffset(1), todayUtc, utcDateOffset(-1)];

  let issueDate: string | null = null;
  let preview: { dateLong: string; greeting: string; threadCount: number } | null = null;
  try {
    for (const slot of candidates) {
      const hit = await readBriefPreview(session.userId, slot);
      if (hit) {
        issueDate = slot;
        preview = hit;
        break;
      }
    }
  } catch (err) {
    // Upstash outage / config break / corrupt value — do NOT collapse
    // this into "composing", which would falsely signal empty state
    // to the dashboard panel. 503 lets the client show a retry path.
    console.error('[api/latest-brief] Upstash read failed:', (err as Error).message);
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  if (!preview || !issueDate) {
    // Echo the caller's date on miss when they supplied one — the
    // client cares about THAT slot's status, not today UTC. Default
    // to today UTC only when no date was given.
    return jsonResponse(
      { status: 'composing', issueDate: dateParam ?? todayUtc },
      200,
      cors,
    );
  }

  let magazineUrl: string;
  try {
    magazineUrl = await signBriefUrl({
      userId: session.userId,
      issueDate,
      baseUrl: publicBaseUrl(req),
      secret,
    });
  } catch (err) {
    if (err instanceof BriefUrlError && err.code === 'invalid_user_id') {
      // Clerk userId should always match our shape, but if it does
      // not we want to log and fail clean rather than expose the raw
      // id in a stack trace.
      console.error('[api/latest-brief] Clerk userId failed shape check');
      return jsonResponse({ error: 'service_unavailable' }, 503, cors);
    }
    throw err;
  }

  return jsonResponse(
    {
      status: 'ready',
      issueDate,
      dateLong: preview.dateLong,
      greeting: preview.greeting,
      threadCount: preview.threadCount,
      magazineUrl,
    },
    200,
    cors,
  );
}
