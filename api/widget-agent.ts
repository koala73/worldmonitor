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
import { validateBearerToken } from '../server/auth-session';
import { getBillingVerificationDenial, getEntitlements } from '../server/_shared/entitlement-check';

const RELAY_BASE = 'https://proxy.worldmonitor.app';
const WIDGET_AGENT_KEY = process.env.WIDGET_AGENT_KEY ?? '';
const PRO_WIDGET_KEY = process.env.PRO_WIDGET_KEY ?? '';
const WORLDMONITOR_VALID_KEYS = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const WIDGET_AGENT_BODY_TIMEOUT_MS = Number(process.env.WIDGET_AGENT_BODY_TIMEOUT_MS) || 5_000;

async function readRequestBody(req: Request): Promise<string> {
  // Adversarial DoS guard: a POST body stream that never ends must not hold the
  // edge function open forever. Race text() against a tight budget.
  return Promise.race([
    req.text(),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('widget-agent body read timeout')), WIDGET_AGENT_BODY_TIMEOUT_MS),
    ),
  ]);
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

export default async function handler(req: Request): Promise<Response> {
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

  // ── Auth ──────────────────────────────────────────────────────────────────
  let isPro = false;

  const headerWorldMonitorKey =
    req.headers.get('X-WorldMonitor-Key') ??
    req.headers.get('X-Api-Key') ??
    '';
  const worldMonitorKey =
    headerWorldMonitorKey ||
    getCookie(req, 'wm-pro-key') ||
    getCookie(req, 'wm-widget-key');
  if (await hasValidWorldMonitorKey(worldMonitorKey)) {
    isPro = true;
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
      isPro = true;
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
    }
  }

  // Mirror the relay P2 fix: allow PRO-only deployments (no basic key, but PRO key present)
  if (!WIDGET_AGENT_KEY && !PRO_WIDGET_KEY) {
    return json({ error: 'Widget agent unavailable', ok: false, widgetKeyConfigured: false }, 503, corsHeaders);
  }

  // ── Build relay headers (server-side keys, never exposed to browser) ──────
  const relayHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'worldmonitor-widget-edge/1.0',
    ...(WIDGET_AGENT_KEY ? { 'X-Widget-Key': WIDGET_AGENT_KEY } : {}),
  };
  if (isPro && PRO_WIDGET_KEY) {
    relayHeaders['X-Pro-Key'] = PRO_WIDGET_KEY;
  }

  // ── Health check (GET) ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const healthRes = await fetch(`${RELAY_BASE}/widget-agent/health`, {
      method: 'GET',
      headers: relayHeaders,
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

  // ── Agent call (POST, SSE stream) ─────────────────────────────────────────
  let rawBody: string;
  try {
    rawBody = await readRequestBody(req);
  } catch {
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

  const relayRes = await fetch(`${RELAY_BASE}/widget-agent`, {
    method: 'POST',
    headers: relayHeaders,
    body: rawBody,
  });

  return new Response(relayRes.body, {
    status: relayRes.status,
    headers: {
      'Content-Type': relayRes.headers.get('Content-Type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    },
  });
}
