/**
 * Latest-brief preview endpoint.
 *
 * GET /api/latest-brief (Clerk JWT required, PRO tier gated)
 *   -> 200 { status: 'ready', issueDate, issueSlot, dateLong, greeting,
 *      threadCount, magazineUrl } when a composed brief exists for this
 *      user's current/requested slot.
 *   -> 200 { status: 'composing', issueDate, issueSlot? } when the
 *      current/requested slot has not been composed yet. `issueSlot` is
 *      present when the caller requested a specific ?slot= value. The
 *      dashboard panel uses this to render an empty state instead of an
 *      error.
 *   -> 401 UNAUTHENTICATED on missing/bad JWT
 *   -> 403 pro_required for non-PRO users
 *   -> 503 if BRIEF_URL_SIGNING_SECRET is not configured
 *
 * The returned magazineUrl is freshly signed per request. It is safe
 * to expose to the authenticated client — the HMAC binds {userId,
 * issueSlot} so it is only useful to the owner.
 *
 * The route does NOT drive composition. It reads the
 * brief:latest:{userId} pointer written by the digest cron to locate
 * the most recent slot, then returns that slot's envelope preview.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash } from './_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import { validateBearerToken } from '../server/auth-session';
import { getEntitlements } from '../server/_shared/entitlement-check';
import { signBriefUrl, BriefUrlError } from '../server/_shared/brief-url';
import { assertBriefEnvelope } from '../server/_shared/brief-render.js';

// Slot format written by the digest cron. Must match ISSUE_DATE_RE in
// server/_shared/brief-url.ts — the signer rejects anything else.
const ISSUE_SLOT_RE = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

// Per-attempt timeouts for the cache-read retry helper. Worst-case wall
// time = FIRST_ATTEMPT_MS + RETRY_ATTEMPT_MS per read × 2 reads = 18s,
// which leaves headroom under Vercel Edge's ~25s initial-response cap
// after `validateBearerToken` + `getEntitlements` preflight. Retry uses
// a shorter budget on the theory that a transient blip clears in <3s; a
// real Upstash outage will time out the retry quickly and fall through
// to the 503 fallback before the platform kills the function.
export const FIRST_ATTEMPT_MS = 6_000;
export const RETRY_ATTEMPT_MS = 3_000;

// Re-run an Upstash read once if the first attempt aborts on
// AbortSignal.timeout. Empirically (WORLDMONITOR-QJ — 4 events / 19 days,
// including a 2026-05-13 same-minute double-fire across us-west + eu-central
// = real Upstash regional incident) the timeouts come in short clusters
// rather than sustained outages, so one retry converts the transient blip
// into a success. The first attempt gets a generous 6s budget; the retry
// shortens to 3s so total wall time stays bounded under the platform cap.
//
// Recovery telemetry: every retry attempt (regardless of outcome) fires
// a low-cardinality Sentry capture tagged `upstash-retry-attempt` so we
// retain visibility into "blipped but recovered" frequency. Without this,
// successful retries would only appear in Vercel logs and we'd lose the
// signal that informs whether the timeout budget is sized correctly.
//
// Duck-types on abort-like `err.name` values rather than
// `err instanceof DOMException` to survive cross-realm cases in test
// runners where undici's DOMException may differ from globalThis.
//
// Exported as a test seam (like `executeTool` in api/mcp/dispatch.ts) so
// the retry semantics can be asserted directly without standing up Clerk
// JWT validation + Convex entitlement reads.
export async function readWithOneRetry<T>(
  attempt: (timeoutMs: number) => Promise<T>,
  label: string,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<T> {
  try {
    return await attempt(FIRST_ATTEMPT_MS);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      console.warn(`[api/latest-brief] ${label} aborted on timeout — retrying once (${RETRY_ATTEMPT_MS}ms)`);
      captureSilentError(err, {
        tags: { route: 'api/latest-brief', step: 'upstash-retry-attempt', label },
        ctx,
      });
      return await attempt(RETRY_ATTEMPT_MS);
    }
    throw err;
  }
}

function todayInUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

type BriefPreview = {
  issueDate: string;
  dateLong: string;
  greeting: string;
  threadCount: number;
};

async function readBriefPreview(
  userId: string,
  issueSlot: string,
  timeoutMs: number,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<BriefPreview | null> {
  const raw = await readRawJsonFromUpstash(`brief:${userId}:${issueSlot}`, timeoutMs);
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
      `[api/latest-brief] composer-bug: brief:${userId}:${issueSlot} failed envelope assertion: ${(err as Error).message}`,
    );
    captureSilentError(err, {
      tags: { route: 'api/latest-brief', step: 'envelope-assertion', issueSlot },
      ctx,
    });
    return null;
  }
  const { data } = raw;
  return {
    issueDate: data.date,
    dateLong: data.dateLong,
    greeting: data.digest.greeting,
    threadCount: data.stories.length,
  };
}

/**
 * Resolve the user's most recent brief slot. Reads the
 * brief:latest:{userId} pointer the digest cron writes alongside each
 * SETEX. Returns null when no pointer exists (user never received a
 * brief, or the pointer has expired past its 7d TTL).
 */
async function readLatestPointer(userId: string, timeoutMs: number): Promise<string | null> {
  const raw = await readRawJsonFromUpstash(`brief:latest:${userId}`, timeoutMs);
  if (raw == null) return null;
  const slot = (raw as { issueSlot?: unknown } | null)?.issueSlot;
  if (typeof slot !== 'string' || !ISSUE_SLOT_RE.test(slot)) return null;
  return slot;
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

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
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

  // Locate the user's most recent brief via the pointer the digest
  // cron writes. An optional ?slot=YYYY-MM-DD-HHMM lets the client
  // request a specific prior brief (e.g. the dashboard's "compare to
  // earlier" or tests); on malformed input we fall through to the
  // pointer path rather than 400, so a stale URL never hard-breaks
  // the panel.
  const url = new URL(req.url);
  const slotParam = url.searchParams.get('slot');
  const requestedSlot =
    slotParam !== null && ISSUE_SLOT_RE.test(slotParam) ? slotParam : null;

  // Hoist the narrowed userId so the retry-helper arrow closures capture a
  // `string` rather than `string | undefined` — TypeScript's narrowing on
  // `session.userId` (guarded above at the UNAUTHENTICATED gate) does not
  // survive into closure capture sites.
  const userId: string = session.userId;

  let issueSlot: string | null = null;
  let preview: BriefPreview | null = null;
  try {
    const targetSlot =
      requestedSlot ??
      (await readWithOneRetry(
        (timeoutMs) => readLatestPointer(userId, timeoutMs),
        'readLatestPointer',
        ctx,
      ));
    if (targetSlot) {
      const hit = await readWithOneRetry(
        (timeoutMs) => readBriefPreview(userId, targetSlot, timeoutMs, ctx),
        'readBriefPreview',
        ctx,
      );
      if (hit) {
        issueSlot = targetSlot;
        preview = hit;
      }
    }
  } catch (err) {
    // Upstash outage / config break / corrupt value — do NOT collapse
    // this into "composing", which would falsely signal empty state
    // to the dashboard panel. 503 lets the client show a retry path.
    console.error('[api/latest-brief] Upstash read failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/latest-brief', step: 'upstash-read' }, ctx });
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  if (!preview || !issueSlot) {
    // Two miss cases with different semantics:
    //   (a) Caller asked for a specific ?slot= that doesn't exist →
    //       report that slot back as missing, NOT "today is composing".
    //       Otherwise a client probing a known slot gets a misleading
    //       "composing today" signal that has nothing to do with what
    //       they asked about.
    //   (b) No ?slot= given and no latest pointer → truly "no brief
    //       yet today". Keep the UTC-today placeholder the panel uses
    //       to render its empty-state title.
    if (requestedSlot) {
      return jsonResponse(
        { status: 'composing', issueSlot: requestedSlot, issueDate: requestedSlot.slice(0, 10) },
        200,
        cors,
      );
    }
    return jsonResponse(
      { status: 'composing', issueDate: todayInUtc() },
      200,
      cors,
    );
  }

  let magazineUrl: string;
  try {
    magazineUrl = await signBriefUrl({
      userId: session.userId,
      issueDate: issueSlot,
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
      issueDate: preview.issueDate,
      issueSlot,
      dateLong: preview.dateLong,
      greeting: preview.greeting,
      threadCount: preview.threadCount,
      magazineUrl,
    },
    200,
    cors,
  );
}
