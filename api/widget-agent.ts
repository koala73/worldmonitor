/**
 * Vercel edge proxy for the widget agent.
 *
 * Auth paths:
 *   1. Clerk JWT (Authorization: Bearer <token>) — validates plan === 'pro',
 *      then injects real server keys and proxies to the Railway relay.
 *   2. Browser tester key (X-WorldMonitor-Key) — validated against
 *      WORLDMONITOR_VALID_KEYS so one browser-held key can unlock premium
 *      testing paths across the app.
 *   3. Legacy tester keys (X-Widget-Key / X-Pro-Key) — validated directly here
 *      so the relay's WIDGET_AGENT_KEY / PRO_WIDGET_KEY are never exposed
 *      to the browser.
 *
 * GET  → proxy to relay /widget-agent/health
 * POST → proxy SSE stream to relay /widget-agent
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeEqualSecret, timingSafeIncludes } from './_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { isSessionTokenShape } from './_session.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import { validateBearerToken } from '../server/auth-session';
import { getBillingVerificationDenial, getEntitlements } from '../server/_shared/entitlement-check';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { getRelayHeaders } from './_relay.js';
import { ENDPOINT_RATE_POLICIES } from '../server/_shared/rate-limit';
import { runRedisPipeline } from '../server/_shared/redis';
import {
  DIRECT_LLM_DAILY_QUOTA_LIMIT,
  DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
  reserveDirectLlmQuota,
  resolveActiveDirectLlmLimit,
} from '../server/_shared/direct-llm-quota';

const RELAY_BASE = 'https://proxy.worldmonitor.app';
const WIDGET_AGENT_KEY = process.env.WIDGET_AGENT_KEY ?? '';
const PRO_WIDGET_KEY = process.env.PRO_WIDGET_KEY ?? '';
const WORLDMONITOR_VALID_KEYS = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const WIDGET_AGENT_BODY_TIMEOUT_MS = Number(process.env.WIDGET_AGENT_BODY_TIMEOUT_MS) || 5_000;
const WIDGET_AGENT_MAX_BODY_BYTES = 163_840;
const WIDGET_AGENT_SPEND_HEADER = 'X-WM-Widget-Spend-Id';
const WIDGET_AGENT_RATE_POLICY_LOOKUP = ENDPOINT_RATE_POLICIES['/api/widget-agent'];
if (!WIDGET_AGENT_RATE_POLICY_LOOKUP) {
  throw new Error("[widget-agent] missing ENDPOINT_RATE_POLICIES['/api/widget-agent']");
}
const WIDGET_AGENT_RATE_POLICY = WIDGET_AGENT_RATE_POLICY_LOOKUP;

/**
 * A timer budget from the environment, or the default.
 *
 * `Number(x) || fallback` alone accepts negatives, fractions, Infinity, and
 * values past the timer range — each of which turns a guard into an outage
 * (a negative or overflowing delay fires immediately, aborting every request;
 * `AbortSignal.timeout` throws `RangeError` on some of them). Only a positive
 * safe integer inside the platform timer range is honoured.
 *
 * Deliberately not the `parseTimeoutEnv` in server/_shared/redis.ts, despite
 * the near-identical job: importing it would pull that module's seed-envelope,
 * cache-contract, and Axiom usage dependencies into this EDGE bundle for the
 * sake of four lines. (It is also looser — `parseInt` there accepts fractional
 * and overflowing input.) If a third caller ever appears, lift a shared helper
 * into a dependency-free module rather than reaching into redis.ts.
 */
function timeoutFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed
    : fallback;
}

// The health check is a small JSON round-trip with no model call behind it, so
// it can carry a tight budget.
//
// POST connect time is bounded separately from model latency. The relay flushes
// response headers before the model turn (`res.flushHeaders()` in
// scripts/ais-relay.cjs), so `fetch` settles when the upstream accepts the
// call. The abort signal is cleared at that point and does not cancel the SSE
// body. A budget here only rejects a relay that never answers the handshake.
const WIDGET_AGENT_HEALTH_TIMEOUT_MS = timeoutFromEnv(process.env.WIDGET_AGENT_HEALTH_TIMEOUT_MS, 10_000);
const WIDGET_AGENT_CONNECT_TIMEOUT_MS = timeoutFromEnv(process.env.WIDGET_AGENT_CONNECT_TIMEOUT_MS, 15_000);

class WidgetBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'WidgetBodyTooLargeError';
  }
}

async function readRequestBody(req: Request): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const decoder = new TextDecoder();
        let total = 0;
        let text = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          total += value.byteLength;
          if (total > WIDGET_AGENT_MAX_BODY_BYTES) throw new WidgetBodyTooLargeError();
          text += decoder.decode(value, { stream: true });
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('widget-agent body read timeout')), WIDGET_AGENT_BODY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Do not let a stalled producer's cancellation hold the response open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function hasValidWorldMonitorKey(key: string): Promise<boolean> {
  return timingSafeIncludes(key, WORLDMONITOR_VALID_KEYS);
}

function getCookie(req: Request, name: string): string {
  const raw = req.headers.get('Cookie') || req.headers.get('cookie') || '';
  if (!raw) return '';
  const prefix = `${name}=`;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(trimmed.slice(prefix.length));
    } catch {
      return trimmed.slice(prefix.length);
    }
  }
  return '';
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

type WidgetAgentSpendDeps = {
  checkRateLimit: typeof checkRateLimit;
  runRedisPipeline: typeof runRedisPipeline;
};

function defaultWidgetAgentSpendDeps(): WidgetAgentSpendDeps {
  return { checkRateLimit, runRedisPipeline };
}

let widgetAgentSpendDeps: WidgetAgentSpendDeps = defaultWidgetAgentSpendDeps();

export function __setWidgetAgentSpendDepsForTests(
  overrides: Partial<WidgetAgentSpendDeps> | null,
): void {
  widgetAgentSpendDeps = overrides
    ? { ...defaultWidgetAgentSpendDeps(), ...overrides }
    : defaultWidgetAgentSpendDeps();
}

async function spendToken(material: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

function directLlmQuotaError(
  status: 429 | 503,
  retryAfterSec: number,
  cors: Record<string, string>,
  limit = DIRECT_LLM_DAILY_QUOTA_LIMIT,
): Response {
  const body = status === 429
    ? {
        error: 'Direct LLM daily quota exceeded',
        limit,
        resetsAt: 'next UTC midnight',
      }
    : { error: 'Direct LLM quota unavailable' };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(retryAfterSec),
      ...cors,
    },
  });
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return json({ error: 'Origin not allowed' }, 403, {});
  }

  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key',
      },
    });
  }

  // Top-level error boundary (#7204). Every other exit on this route carries
  // `corsHeaders`; an uncaught throw does not — it becomes an opaque Vercel
  // platform 5xx with no CORS headers at all, so the browser reports a CORS
  // error instead of a readable status and the widget cannot tell "relay is
  // down" from "you are not allowed". The relay fetches are the realistic
  // source (DNS failure, connection reset, TLS error, hung upstream), but the
  // pre-relay auth lookups are network-backed too, so the boundary sits at the
  // handler edge rather than around the fetch alone. Mirrors the sibling
  // premium edge routes api/chat-analyst.ts and api/latest-brief.ts: capture
  // server-side for a real trace, and answer with a CORS-correct transient
  // 503 — never 403, so a relay blip can never read as an entitlement denial.
  //
  // `proxyWidgetAgent` is a separate function purely so this boundary does not
  // reindent 130 lines of unchanged routing logic.
  try {
    return await proxyWidgetAgent(req, corsHeaders, ctx);
  } catch (err) {
    // `name` + `message` are the phase discriminator on-call needs: an
    // unreachable relay reads `TypeError: … ENOTFOUND proxy.worldmonitor.app`,
    // a health check that outran its budget reads `TimeoutError` (the
    // DOMException `AbortSignal.timeout` throws), and an entitlement-lookup
    // blip reads as neither. Nothing here echoes a key or a token.
    console.error('[widget-agent] unhandled proxy failure', JSON.stringify({
      method: req.method,
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    }));
    void captureSilentError(err, {
      tags: { route: 'api/widget-agent', step: 'proxy' },
      extra: { method: req.method },
      ctx,
    });
    return json({ error: 'service_unavailable', ok: false }, 503, corsHeaders);
  }
}

async function proxyWidgetAgent(
  req: Request,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  let isPro = false;
  let spendId = '';
  let quotaUserId = '';
  let directLlmDailyLimit: number | null = DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT;

  const headerWorldMonitorKey =
    req.headers.get('X-WorldMonitor-Key') ??
    req.headers.get('X-Api-Key') ??
    '';
  const explicitWorldMonitorKey = isSessionTokenShape(headerWorldMonitorKey)
    ? ''
    : headerWorldMonitorKey;
  const worldMonitorKey =
    explicitWorldMonitorKey ||
    getCookie(req, 'wm-pro-key') ||
    getCookie(req, 'wm-widget-key') ||
    headerWorldMonitorKey;
  if (await hasValidWorldMonitorKey(worldMonitorKey)) {
    isPro = true;
    spendId = `wm:${await spendToken(worldMonitorKey)}`;
    quotaUserId = spendId;
    directLlmDailyLimit = DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT;
  } else {
    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      // Clerk JWT path (web users with active subscription).
      //
      // Accept EITHER a Clerk 'pro' role OR a Convex Dodo entitlement with
      // tier >= 1. The Dodo webhook pipeline writes Convex entitlements but
      // does NOT sync Clerk publicMetadata.plan, so a paying subscriber's
      // session.role stays 'free' indefinitely (panel-gating.ts:11-27 documents
      // the same split at the frontend layer). A Clerk-role-only check here
      // would 403 every paying user despite a valid Dodo subscription, with
      // the modal then surfacing a misleading "PRO key rejected. Update
      // wm-pro-key…" message — these users have no tester key.
      //
      // This mirrors server/gateway.ts:521-526 (legacy bearer path) and
      // server/_shared/premium-check.ts::isCallerPremium so every Pro gate
      // agrees on who is premium.
      const session = await validateBearerToken(authHeader.slice(7));
      if (!session.valid) {
        return json({ error: 'Invalid or expired session' }, 401, corsHeaders);
      }
      let allowed = session.role === 'pro';
      let entitlementChecked = false;
      let entitlementTier: number | null = null;
      let ent: Awaited<ReturnType<typeof getEntitlements>> = null;
      if (!allowed && session.userId) {
        ent = await getEntitlements(session.userId);
        entitlementChecked = true;
        entitlementTier = ent ? ent.features.tier : null;
        allowed = !!ent && ent.features.tier >= 1;
      }
      if (!allowed) {
        // #4771: a paying user whose local renewal state is stale gets the
        // structured billing-verification denial (403/503 + stable `code` +
        // X-Billing-Verification header) instead of a misleading generic
        // "Pro subscription required" 403 — same wire contract as the
        // gateway and MCP surfaces (#5447/#5483). This also converts the
        // transient verificationUnavailable marker into a retryable 503
        // rather than a hard denial during Convex outages.
        const billingDenial = getBillingVerificationDenial(ent, corsHeaders, 1);
        if (billingDenial) {
          // Keep the on-call grep contract alive on this path too — the
          // early return would otherwise silence the denial entirely
          // (gateway pairs its denial with emitRequest the same way).
          console.warn('[widget-agent] billing-verification denial', JSON.stringify({
            status: billingDenial.status,
            code: billingDenial.headers.get('X-Billing-Verification'),
            userId: session.userId ?? null,
            clerkRole: session.role ?? null,
            entitlementTier,
          }));
          return billingDenial;
        }
        // Structured log so on-call can distinguish two distinct 403 causes
        // sharing one user-facing message:
        //   reason=not_entitled      — Convex returned a row, tier < 1 (real free user)
        //   reason=service_unavailable — entitlement lookup returned null.
        //                                Post-#5483 a Convex-unreachable/5xx
        //                                lookup returns the verificationUnavailable
        //                                marker (tier 0) and exits via the 503
        //                                above, so null here means the fail-closed
        //                                4xx path — rare, but still worth a
        //                                distinct grep handle.
        const reason = entitlementChecked && entitlementTier === null
          ? 'service_unavailable'
          : 'not_entitled';
        console.warn('[widget-agent] 403 pro-required', JSON.stringify({
          reason,
          userId: session.userId ?? null,
          clerkRole: session.role ?? null,
          entitlementChecked,
          entitlementTier,
        }));
        return json({ error: 'Pro subscription required' }, 403, corsHeaders);
      }
      if (!session.userId) {
        return json({ error: 'Invalid or expired session' }, 401, corsHeaders);
      }
      isPro = true;
      spendId = `user:${session.userId}`;
      quotaUserId = session.userId;
      directLlmDailyLimit = entitlementChecked
        ? resolveActiveDirectLlmLimit(ent)
        : DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT;
    } else {
      // Legacy tester key path (wm-widget-key / wm-pro-key)
      const widgetKey = req.headers.get('X-Widget-Key') || getCookie(req, 'wm-widget-key');
      const proKey = req.headers.get('X-Pro-Key') || getCookie(req, 'wm-pro-key');
      const hasWidgetKey = await timingSafeEqualSecret(widgetKey, WIDGET_AGENT_KEY);
      const hasProKey = await timingSafeEqualSecret(proKey, PRO_WIDGET_KEY);
      if (!hasWidgetKey && !hasProKey) {
        return json({ error: 'Forbidden' }, 403, corsHeaders);
      }
      isPro = hasProKey;
      spendId = hasProKey ? 'legacy-pro-key' : 'legacy-widget-key';
      quotaUserId = spendId;
      directLlmDailyLimit = DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT;
    }
  }

  // Mirror the relay P2 fix: allow PRO-only deployments (no basic key, but PRO key present)
  if (!WIDGET_AGENT_KEY && !PRO_WIDGET_KEY) {
    return json({ error: 'Widget agent unavailable', ok: false, widgetKeyConfigured: false }, 503, corsHeaders);
  }

  // ── Build relay headers (server-side keys, never exposed to browser) ──────
  const relayHeaders: Record<string, string> = getRelayHeaders({
    'Content-Type': 'application/json',
    'User-Agent': 'worldmonitor-widget-edge/1.0',
    ...(WIDGET_AGENT_KEY ? { 'X-Widget-Key': WIDGET_AGENT_KEY } : {}),
  });
  if (isPro && PRO_WIDGET_KEY) {
    relayHeaders['X-Pro-Key'] = PRO_WIDGET_KEY;
  }

  // ── Health check (GET) ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // No stream to protect here, so bound the whole exchange (headers AND the
    // small JSON body) rather than just the headers.
    const healthRes = await fetch(`${RELAY_BASE}/widget-agent/health`, {
      method: 'GET',
      headers: relayHeaders,
      signal: AbortSignal.timeout(WIDGET_AGENT_HEALTH_TIMEOUT_MS),
    });
    const body = await healthRes.text();
    return new Response(body, {
      status: healthRes.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  if (!spendId || !quotaUserId) {
    return json({ error: 'service_unavailable', ok: false }, 503, corsHeaders);
  }

  // Per-identity, fail-closed. The relay's in-memory bucket is keyed on the
  // TCP peer, which is this edge's egress IP for every browser — not the user.
  // A Redis outage must not open an uncapped frontier-model proxy.
  const limited = await widgetAgentSpendDeps.checkRateLimit(req, corsHeaders, {
    scope: 'widget-agent',
    identifier: spendId,
    limit: WIDGET_AGENT_RATE_POLICY.limit,
    window: WIDGET_AGENT_RATE_POLICY.window,
    failClosed: true,
    ctx,
  });
  if (limited) return limited;

  const declaredLength = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > WIDGET_AGENT_MAX_BODY_BYTES) {
    return json({ error: 'Request body too large' }, 413, corsHeaders);
  }

  // ── Agent call (POST, SSE stream) ─────────────────────────────────────────
  let rawBody: string;
  try {
    rawBody = await readRequestBody(req);
  } catch (err) {
    if (err instanceof WidgetBodyTooLargeError) {
      return json({ error: 'Request body too large' }, 413, corsHeaders);
    }
    return json({ error: 'Request body read timeout' }, 408, corsHeaders);
  }

  // Normalise tier in body to match the server-validated isPro flag.
  // Prevents the relay from seeing tier:pro without the matching X-Pro-Key.
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const expectedTier = isPro ? 'pro' : 'basic';
    if (parsed.tier !== expectedTier) {
      rawBody = JSON.stringify({ ...parsed, tier: expectedTier });
    }
  } catch { /* malformed body — relay will return 400 */ }

  // Reserve against the same daily meter as chat-analyst / gateway LLM routes
  // before any upstream call. Unlimited (null) entitlements stay metered by
  // the per-identity rate limit above.
  let rollbackQuota: (() => Promise<void>) | null = null;
  if (directLlmDailyLimit !== null) {
    const reservation = await reserveDirectLlmQuota({
      userId: quotaUserId,
      limit: directLlmDailyLimit,
      pipeline: (cmds) => widgetAgentSpendDeps.runRedisPipeline(cmds, true),
    });
    if (!reservation.ok) {
      return directLlmQuotaError(
        reservation.reason === 'cap-exceeded' ? 429 : 503,
        reservation.retryAfterSec,
        corsHeaders,
        reservation.floor ?? directLlmDailyLimit,
      );
    }
    rollbackQuota = reservation.rollback;
  }
  const releaseUnservedQuota = async () => {
    const rollback = rollbackQuota;
    rollbackQuota = null;
    if (rollback) await rollback();
  };

  relayHeaders[WIDGET_AGENT_SPEND_HEADER] = spendId;
  const connectAbort = new AbortController();
  const connectTimer = setTimeout(() => connectAbort.abort(), WIDGET_AGENT_CONNECT_TIMEOUT_MS);
  try {
    const relayRes = await fetch(`${RELAY_BASE}/widget-agent`, {
      method: 'POST',
      headers: relayHeaders,
      body: rawBody,
      signal: connectAbort.signal,
    });
    clearTimeout(connectTimer);
    if (!relayRes.ok) await releaseUnservedQuota();
    return new Response(relayRes.body, {
      status: relayRes.status,
      headers: {
        'Content-Type': relayRes.headers.get('Content-Type') ?? 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      },
    });
  } catch (err) {
    clearTimeout(connectTimer);
    await releaseUnservedQuota();
    throw err;
  }
}
