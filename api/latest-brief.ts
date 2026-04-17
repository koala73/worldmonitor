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
import { validateBearerToken } from '../server/auth-session';
import { getEntitlements } from '../server/_shared/entitlement-check';
import { signBriefUrl, BriefUrlError } from '../server/_shared/brief-url';

function todayInUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readBriefPreview(
  userId: string,
  issueDate: string,
): Promise<{ dateLong: string; greeting: string; threadCount: number } | null> {
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
    const envelope = JSON.parse(body.result) as {
      data?: {
        dateLong?: unknown;
        digest?: { greeting?: unknown };
        stories?: unknown[];
      };
    };
    const data = envelope?.data;
    if (
      !data
      || typeof data.dateLong !== 'string'
      || !data.digest
      || typeof data.digest.greeting !== 'string'
      || !Array.isArray(data.stories)
    ) {
      return null;
    }
    return {
      dateLong: data.dateLong,
      greeting: data.digest.greeting,
      threadCount: data.stories.length,
    };
  } catch {
    return null;
  }
}

function publicBaseUrl(req: Request): string {
  const forwardedHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  // Fallback to the request URL's origin if headers are missing.
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

  const issueDate = todayInUtc();
  const preview = await readBriefPreview(session.userId, issueDate);

  if (!preview) {
    return jsonResponse({ status: 'composing', issueDate }, 200, cors);
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
