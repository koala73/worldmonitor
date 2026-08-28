/**
 * Notification channel management edge function.
 *
 * GET  /api/notification-channels → { channels, alertRules }
 * POST /api/notification-channels → various actions (see below)
 *
 * Authenticates the caller via Clerk JWKS (bearer token), then forwards
 * to the Convex /relay/notification-channels HTTP action using the
 * RELAY_SHARED_SECRET — no Convex-specific JWT template required.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureEdgeException, captureSilentError } from './_sentry-edge.js';
import {
  beginStandaloneIdempotency,
  completeStandaloneIdempotency,
  getIdempotencyKey,
} from './_idempotency.js';
import { assertNotificationWebhookRegistrationUrlSafe } from './_notification-webhook-ssrf';
import { validateBearerToken } from '../server/auth-session';
import { getBillingVerificationDenial, getEntitlements } from '../server/_shared/entitlement-check';

// Prefer explicit CONVEX_SITE_URL; fall back to deriving from CONVEX_URL (same pattern as notification-relay.cjs).
const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET ?? '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

type NotificationChannelsDeps = {
  validateBearerToken: typeof validateBearerToken;
  getEntitlements: typeof getEntitlements;
  fetch: typeof fetch;
  // Injected so the billing-denial capture is observable in tests. It cannot be
  // asserted through the real transport: api/_sentry-common.js's parseDsn()
  // returns early when process.env.NODE_TEST_CONTEXT is set (which node:test
  // always sets), so captureSilentError is a no-op under the test runner and
  // the whole branch below could be deleted with every case still green.
  captureSilentError: typeof captureSilentError;
};

function createDefaultNotificationChannelsDeps(): NotificationChannelsDeps {
  return {
    validateBearerToken,
    getEntitlements,
    fetch: (...args) => globalThis.fetch(...args),
    captureSilentError,
  };
}

// Per-code dedup window for the billing-denial capture. The capture sits
// downstream of the entitlement cache (server/_shared/entitlement-check.ts
// serves a billing marker straight from Redis), so without this a Convex
// brownout emits one Sentry event per denied POST per affected user rather than
// one per incident. Module-level state is per-isolate, so this degrades with
// edge fan-out instead of scaling with traffic.
const DENIAL_CAPTURE_DEDUP_WINDOW_MS = 60_000;
const lastDenialCaptureAtByCode = new Map<string, number>();

function shouldCaptureDenial(code: string | null, now: number): boolean {
  // `subscription_lapsed` is a confirmed terminal answer already visible in
  // Convex — eventing it would turn ordinary churn into a permanent Sentry
  // stream and bury the anomaly.
  if (!code || code === 'subscription_lapsed') return false;
  const last = lastDenialCaptureAtByCode.get(code);
  if (last !== undefined && now - last < DENIAL_CAPTURE_DEDUP_WINDOW_MS) return false;
  lastDenialCaptureAtByCode.set(code, now);
  return true;
}

/** Test-only reset so dedup state cannot leak between cases. */
export function __resetDenialCaptureDedupForTests(): void {
  lastDenialCaptureAtByCode.clear();
}

let notificationChannelsDeps = createDefaultNotificationChannelsDeps();

export function __setNotificationChannelsDepsForTests(
  overrides: Partial<NotificationChannelsDeps> | null,
): void {
  notificationChannelsDeps = overrides
    ? { ...createDefaultNotificationChannelsDeps(), ...overrides }
    : createDefaultNotificationChannelsDeps();
}

// AES-256-GCM encryption using Web Crypto (matches Node crypto.cjs decrypt format).
// Format stored: v1:<base64(iv[12] || tag[16] || ciphertext)>
async function encryptSlackWebhook(webhookUrl: string): Promise<string> {
  const rawKey = process.env.NOTIFICATION_ENCRYPTION_KEY;
  if (!rawKey) throw new Error('NOTIFICATION_ENCRYPTION_KEY not set');
  const keyBytes = Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(webhookUrl);
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encoded));
  const ciphertext = result.slice(0, -16);
  const tag = result.slice(-16);
  const payload = new Uint8Array(12 + 16 + ciphertext.length);
  payload.set(iv, 0);
  payload.set(tag, 12);
  payload.set(ciphertext, 28);
  const binary = Array.from(payload, (b) => String.fromCharCode(b)).join('');
  return `v1:${btoa(binary)}`;
}

/**
 * Allow-list of hostnames every major browser's push service uses.
 *
 * A PushSubscription's endpoint URL is assigned by the browser's
 * push platform — users can't pick it. That means we CAN safely
 * constrain accepted endpoints to known push-service hosts and
 * reject anything else before it hits Convex storage (and later
 * the relay's outbound fetch). Without this allow-list the relay's
 * sendWebPush() becomes a server-side-request primitive for any
 * PRO user: they could submit `https://internal.example.com/admin`
 * as their endpoint and the relay would faithfully POST to it.
 *
 * Sources (verified 2026-04-18):
 *   - Chrome / Edge / Brave:  fcm.googleapis.com
 *   - Firefox:                updates.push.services.mozilla.com
 *   - Safari (macOS 13+):     web.push.apple.com
 *   - Windows Notification:   *.notify.windows.com (wns2-*, etc.)
 *
 * If a future browser ships a new push service we'll need to widen
 * this list — fail-closed is the right default.
 */
function isAllowedPushEndpointHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'fcm.googleapis.com') return true;
  if (h === 'updates.push.services.mozilla.com') return true;
  if (h === 'web.push.apple.com') return true;
  if (h.endsWith('.web.push.apple.com')) return true;
  if (h.endsWith('.notify.windows.com')) return true;
  return false;
}

async function publishWelcome(userId: string, channelType: string): Promise<void> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('[notification-channels] publishWelcome: UPSTASH env vars missing — welcome not queued');
    return;
  }
  const msg = JSON.stringify({ eventType: 'channel_welcome', userId, channelType });
  try {
    const res = await notificationChannelsDeps.fetch(
      `${UPSTASH_URL}/lpush/wm:events:queue/${encodeURIComponent(msg)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${UPSTASH_TOKEN}`,
          'User-Agent': 'worldmonitor-edge/1.0',
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      throw new Error(`publishWelcome: Upstash LPUSH returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[notification-channels] publishWelcome LPUSH failed:', (err as Error).message);
    await captureSilentError(err, {
      tags: { route: 'api/notification-channels', step: 'publish-welcome' },
    });
  }
}

async function publishFlushHeld(userId: string, variant: string): Promise<void> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const msg = JSON.stringify({ eventType: 'flush_quiet_held', userId, variant });
  try {
    await notificationChannelsDeps.fetch(`${UPSTASH_URL}/lpush/wm:events:queue/${encodeURIComponent(msg)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'User-Agent': 'worldmonitor-edge/1.0' },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn('[notification-channels] publishFlushHeld LPUSH failed:', (err as Error).message);
    // `level` (not the `severity` tag) is what buildEnvelope reads; without it
    // this warn-intent capture also shipped at error level.
    await captureSilentError(err, {
      level: 'warning',
      tags: { route: 'api/notification-channels', step: 'publish-flush-held', severity: 'warn' },
    });
  }
}

function json(body: unknown, status: number, cors: Record<string, string>, noCache = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(noCache ? { 'Cache-Control': 'no-store' } : {}),
      ...cors,
    },
  });
}

const CONVEX_RELAY_TIMEOUT_MS = 15_000;

async function convexRelay(
  body: Record<string, unknown>,
  signal = AbortSignal.timeout(CONVEX_RELAY_TIMEOUT_MS),
): Promise<Response> {
  return notificationChannelsDeps.fetch(`${CONVEX_SITE_URL}/relay/notification-channels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RELAY_SHARED_SECRET}`,
      'User-Agent': 'worldmonitor-edge/1.0',
    },
    body: JSON.stringify(body),
    // Matches the 15s timeout api/customer-portal.ts and
    // api/create-checkout.ts already use for the same Convex host.
    // Without this, a hung relay call outlives the edge runtime's invocation
    // budget before the handler's own catch can run finish() to release the
    // idempotency lock this endpoint holds across the call — leaving retries
    // 409ing for its full 180s TTL (#5426).
    signal,
  });
}

type WelcomeRelayResult = {
  response: Response;
  durableWelcomeScheduling: boolean;
};

/**
 * Negotiate durable welcome scheduling before a first-connect mutation.
 *
 * Convex and Vercel deploy independently. New Convex only owns welcome
 * scheduling when the new edge explicitly opts in; old edge therefore keeps
 * its legacy publisher. New edge probes before opting in. An old Convex
 * deployment answers "Unknown action", so edge fails closed before sending a
 * mutation and releases the idempotency marker for retry. That short
 * availability tradeoff avoids both mixed-version duplicate welcomes and the
 * original timeout-after-commit ambiguity.
 */
async function convexRelayWithDurableWelcome(
  body: Record<string, unknown>,
): Promise<WelcomeRelayResult> {
  // One deadline covers both negotiation and mutation. Two independent 15s
  // waits can exceed the edge response-start budget before the handler reaches
  // finish() and releases its idempotency marker.
  const relaySignal = AbortSignal.timeout(CONVEX_RELAY_TIMEOUT_MS);
  const capability = await convexRelay({
    action: 'welcome-scheduling-capability',
    userId: body.userId,
  }, relaySignal);
  if (capability.ok) {
    const payload = await capability.json().catch(() => null) as {
      durableWelcomeScheduling?: boolean;
    } | null;
    if (payload?.durableWelcomeScheduling !== true) {
      throw new Error('Convex returned an invalid welcome scheduling capability response');
    }
    return {
      response: await convexRelay(
        { ...body, scheduleWelcome: true },
        relaySignal,
      ),
      durableWelcomeScheduling: true,
    };
  }

  const payload = await capability.clone().json().catch(() => null) as {
    error?: string;
  } | null;
  if (capability.status === 400 && payload?.error === 'Unknown action') {
    return {
      response: Response.json(
        { error: 'DURABLE_WELCOME_UNAVAILABLE' },
        { status: 503 },
      ),
      durableWelcomeScheduling: false,
    };
  }

  return { response: capability, durableWelcomeScheduling: false };
}

interface PostBody {
  action?: string;
  channelType?: string;
  email?: string;
  webhookEnvelope?: string;
  webhookLabel?: string;
  variant?: string;
  enabled?: boolean;
  eventTypes?: string[];
  sensitivity?: string;
  channels?: string[];
  // web_push subscription triple (Phase 6)
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  userAgent?: string;
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: string;
  digestMode?: string;
  digestHour?: number;
  digestTimezone?: string;
  aiDigestEnabled?: boolean;
  // Optional ISO-3166 alpha-2 country-scope; relay re-validates + normalizes.
  countries?: string[];
  // Optional watchlist ticker-scope (#4922 U3); relay re-validates + normalizes.
  tickers?: string[];
}

export default async function handler(req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      },
    });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const session = await notificationChannelsDeps.validateBearerToken(token);
  if (!session.valid || !session.userId) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const idempotencyRequest = req.method === 'POST' ? req.clone() : null;

  if (!CONVEX_SITE_URL || !RELAY_SHARED_SECRET) {
    return json({ error: 'Service unavailable' }, 503, corsHeaders);
  }

  if (req.method === 'GET') {
    try {
      const resp = await convexRelay({ action: 'get', userId: session.userId });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('[notification-channels] GET relay error:', resp.status, errText);
        return json({ error: 'Failed to fetch' }, 500, corsHeaders);
      }
      const data = await resp.json();
      return json(data, 200, corsHeaders, true);
    } catch (err) {
      console.error('[notification-channels] GET error:', err);
      captureEdgeException(err, { handler: 'notification-channels', method: 'GET' }, ctx);
      return json({ error: 'Failed to fetch' }, 500, corsHeaders);
    }
  }

  if (req.method === 'POST') {
    // WHY notification writes require a BILLED entitlement row, and do NOT honor
    // the Clerk `role === 'pro'` allowance that checkEntitlementDetailed grants
    // for tier <= 1 (#5622 asked for this decision to be made either way):
    //
    // Because this gate is not the only one. Convex enforces `tier >= 1` against
    // the entitlements table independently, inside the mutations themselves —
    // assertProEntitlement in convex/alertRules.ts:36 and its twin in
    // convex/notificationChannels.ts:64. A role-only Pro account has no
    // entitlements row, so relaxing THIS gate does not grant access. It only
    // moves the denial one hop later and degrades it:
    //
    //   set-channel             Convex 402 is not the 503 case below, so it
    //                           falls through to `500 Operation failed` — and
    //                           set-channel is what the day-0 wizard calls
    //   set-alert-rules,        402 PRO_REQUIRED passes through structurally,
    //   set-notification-config which the client surfaces as a generic failure
    //
    // Both are strictly worse for the user than the clean `403 pro_required`
    // with an upgradeUrl this gate returns. An edge-only allowance was written
    // and reverted for exactly that reason, verified against both Convex gates
    // rather than assumed.
    //
    // So: notification delivery is gated on a billed row at the DATA layer, and
    // this gate exists to say so cleanly and early. Granting it to complimentary
    // / tester / legacy Clerk-role accounts is a real product decision that must
    // change the Convex gates too — see #5646.
    //
    // The client agrees with this gate, which is why a role-only account gets a
    // coherent experience rather than a dead end: renderNotificationsSettings
    // (src/services/notifications-settings.ts) gates its content on
    // `hasTier(1)` — the Convex entitlement snapshot, NOT the Clerk role — and
    // renders the upgrade CTA otherwise. So such a user sees an upsell here and
    // an upsell from this endpoint. (Note `isProUser()` in
    // src/services/widget-store.ts DOES accept the Clerk role alone, but the
    // notifications surface deliberately does not use it.)
    //
    // #5650 settled the same question for the sibling JSON gates on the same
    // line this one draws: content reads (latest-brief, brief/share-url) accept
    // either signal, while anything that creates a delivery obligation or a
    // third-party grant (notify, slack/discord oauth-start) requires the billed
    // row — as this endpoint does.
    const ent = await notificationChannelsDeps.getEntitlements(session.userId);
    if (!ent || ent.features.tier < 1) {
      // #5600: an entitlement the backend could not VERIFY (Convex 5xx/timeout,
      // or a renewal re-check in flight) is not a confirmed free user. Answer
      // it with the shared retryable contract — 503 + Retry-After +
      // X-Billing-Verification — the same way the gateway, widget-agent, and
      // MCP surfaces do, so the client can retry instead of rendering a
      // terminal "upgrade to Pro".
      //
      // Scope note: this does NOT cover the day-0 poisoned-marker cohort. That
      // one arrives as a plain tier-0 answer (no billingStatus, no
      // verificationUnavailable), so the helper returns null and the buyer
      // still gets the 403 below — bounded to
      // NOT_APPLICABLE_VERIFICATION_TTL_SECONDS by the other half of this fix.
      // Making that state 503 instead would hand every never-subscribed free
      // user a retryable error in place of a clean upsell.
      const billingDenial = getBillingVerificationDenial(ent, corsHeaders, 1);
      if (billingDenial) {
        const code = billingDenial.headers.get('X-Billing-Verification');
        console.warn('[notification-channels] billing-verification denial', JSON.stringify({
          status: billingDenial.status,
          code,
          userId: session.userId,
        }));
        // Match this file's own convention (publishWelcome / publishFlushHeld
        // above): a console.warn alone is a Sentry breadcrumb, not an event, so
        // it would be invisible in exactly the way #5600's activation failures
        // were. Tagged so these group with the wizard-side captures.
        //
        // Transient states only, and at most one event per code per
        // DENIAL_CAPTURE_DEDUP_WINDOW_MS — see shouldCaptureDenial.
        //
        // `level: 'warning'` is load-bearing, not decorative: buildEnvelope in
        // api/_sentry-common.js derives the Sentry level ONLY from ctx.level and
        // defaults to 'error'. A `severity` TAG does not set it, so without this
        // an expected transient denial pages on-call at error level — the exact
        // "drowns real bugs in dashboards/alerting" outcome that file warns about.
        //
        // NOT awaited: makeCaptureSilentError registers ctx.waitUntil(promise)
        // (api/_sentry-common.js), so the capture is guaranteed to run without
        // holding the denial response open for its 2s transport timeout.
        if (shouldCaptureDenial(code, Date.now())) {
          void notificationChannelsDeps.captureSilentError(
            new Error(`notification-channels billing-verification denial: ${code}`),
            {
              level: 'warning',
              tags: {
                route: 'api/notification-channels',
                step: 'billing-verification-denial',
                code: code as string,
                severity: 'warn',
              },
              ctx,
            },
          );
        }
        return billingDenial;
      }
      return json({
        error: 'pro_required',
        message: 'Real-time alerts are available on the Pro plan.',
        upgradeUrl: 'https://worldmonitor.app/pro',
      }, 403, corsHeaders);
    }

    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    const idempotencyKey = getIdempotencyKey(req);
    const idempotency = idempotencyKey
      ? await beginStandaloneIdempotency({
        request: idempotencyRequest ?? req,
        pathname: '/api/notification-channels',
        scope: `user:${session.userId}`,
        idempotencyKey,
        corsHeaders,
      })
      : null;
    if (
      idempotency &&
      idempotency.kind !== 'proceed' &&
      idempotency.kind !== 'disabled'
    ) {
      return idempotency.response;
    }
    const finish = (response: Response): Promise<Response> =>
      completeStandaloneIdempotency(idempotency, response);

    const { action } = body;

    // session.userId is narrowed to string by the auth guard above, but
    // property narrowing does not flow into closures — capture it once.
    const welcomeUserId = session.userId;
    // Shared tail for the two durable-welcome mutations (set-channel,
    // set-web-push): map relay failures (503 deploy-window fail-closed vs
    // generic 500), then publish the legacy welcome only when Convex did not
    // acknowledge scheduling ownership. Requiring the mutation response to
    // re-acknowledge protects the success path even if Convex rolls back
    // between the capability probe and the mutation.
    const finishDurableWelcomeRelay = async (
      relay: WelcomeRelayResult,
      relayAction: string,
      welcomeChannelType: string,
    ): Promise<Response> => {
      const resp = relay.response;
      if (!resp.ok) {
        console.error(`[notification-channels] POST ${relayAction} relay error:`, resp.status);
        if (resp.status === 503) {
          return finish(json({ error: 'Service unavailable' }, 503, corsHeaders));
        }
        return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
      }
      const result = await resp.json() as {
        isNew?: boolean;
        durableWelcomeScheduling?: boolean;
      };
      if (
        result.isNew &&
        (!relay.durableWelcomeScheduling ||
          result.durableWelcomeScheduling !== true)
      ) {
        ctx.waitUntil(publishWelcome(welcomeUserId, welcomeChannelType));
      }
      return finish(json({ ok: true }, 200, corsHeaders));
    };

    try {
      if (action === 'create-pairing-token') {
        const relayBody: Record<string, unknown> = { action: 'create-pairing-token', userId: session.userId };
        if (body.variant) relayBody.variant = body.variant;
        const resp = await convexRelay(relayBody);
        if (!resp.ok) {
          console.error('[notification-channels] POST create-pairing-token relay error:', resp.status);
          return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
        }
        return finish(json(await resp.json(), 200, corsHeaders));
      }

      if (action === 'set-channel') {
        const { channelType, email, webhookEnvelope, webhookLabel } = body;
        if (!channelType) return finish(json({ error: 'channelType required' }, 400, corsHeaders));

        // Same predicate as the persist guard below (#7207): these two
        // conditions guarded the same variable with different tests
        // (truthiness here, definedness below), so webhookEnvelope: ''
        // skipped validation entirely and was encrypted + stored as a junk
        // channel config. The validator rejects empty/blank itself, so the
        // gap value now 400s instead of persisting.
        if (webhookEnvelope !== undefined) {
          try {
            await assertNotificationWebhookRegistrationUrlSafe(webhookEnvelope);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Webhook URL is not allowed';
            return finish(json({ error: message }, 400, corsHeaders));
          }
        }

        const relayBody: Record<string, unknown> = { action: 'set-channel', userId: session.userId, channelType };
        if (email !== undefined) relayBody.email = email;
        if (webhookLabel !== undefined) relayBody.webhookLabel = String(webhookLabel).slice(0, 100);
        if (webhookEnvelope !== undefined) {
          try {
            relayBody.webhookEnvelope = await encryptSlackWebhook(webhookEnvelope);
          } catch {
            return finish(json({ error: 'Encryption unavailable' }, 503, corsHeaders));
          }
        }
        const relay = await convexRelayWithDurableWelcome(relayBody);
        return finishDurableWelcomeRelay(relay, 'set-channel', channelType);
      }

      if (action === 'set-web-push') {
        const { endpoint, p256dh, auth, userAgent } = body;
        if (!endpoint || !p256dh || !auth) {
          return finish(json({ error: 'endpoint, p256dh, auth required' }, 400, corsHeaders));
        }
        // SSRF defence. The relay later POSTs to whatever endpoint we
        // persist here, so an unvalidated user-submitted URL is a
        // server-side-request primitive bounded only by the relay's
        // network egress. Browsers always produce endpoints at one
        // of a small set of push-service hosts (FCM, Mozilla, Apple,
        // Windows Notification Service); anything else is either an
        // exotic browser (rare) or an attack. Allow-list the known
        // hosts and reject everything else.
        try {
          const u = new URL(endpoint);
          if (u.protocol !== 'https:') {
            return finish(json({ error: 'endpoint must be https' }, 400, corsHeaders));
          }
          if (!isAllowedPushEndpointHost(u.hostname)) {
            return finish(json(
              { error: 'endpoint host is not a recognised push service' },
              400,
              corsHeaders,
            ));
          }
        } catch {
          return finish(json({ error: 'invalid endpoint' }, 400, corsHeaders));
        }
        const relay = await convexRelayWithDurableWelcome({
          action: 'set-web-push',
          userId: session.userId,
          endpoint,
          p256dh,
          auth,
          // Trim user agent; it's cosmetic for the settings UI, not identity.
          userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : undefined,
        });
        return finishDurableWelcomeRelay(relay, 'set-web-push', 'web_push');
      }

      if (action === 'delete-channel') {
        const { channelType } = body;
        if (!channelType) return finish(json({ error: 'channelType required' }, 400, corsHeaders));
        const resp = await convexRelay({ action: 'delete-channel', userId: session.userId, channelType });
        if (!resp.ok) {
          console.error('[notification-channels] POST delete-channel relay error:', resp.status);
          return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
        }
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'set-alert-rules') {
        const { variant, enabled, eventTypes, sensitivity, channels, aiDigestEnabled, countries, tickers } = body;
        if (tickers !== undefined && !Array.isArray(tickers)) {
          return finish(json({ error: 'TICKERS_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        const resp = await convexRelay({
          action: 'set-alert-rules',
          userId: session.userId,
          variant,
          enabled,
          eventTypes,
          sensitivity,
          channels,
          aiDigestEnabled,
          countries,
          tickers,
        });
        if (!resp.ok) {
          // A 400 carries a structured validation code (TICKERS_LIMIT_EXCEEDED /
          // COUNTRIES_LIMIT_EXCEEDED); 402 is the paywall (PRO_REQUIRED). Pass
          // both through with body intact so the client renders the real reason
          // instead of a generic toast — mirrors set-notification-config below.
          if (resp.status === 400 || resp.status === 402) {
            const text = await resp.text().catch(() => '');
            let payload: unknown = { error: 'Validation failed' };
            if (text) {
              try { payload = JSON.parse(text); } catch { /* keep default */ }
            }
            return finish(json(payload, resp.status, corsHeaders));
          }
          console.error('[notification-channels] POST set-alert-rules relay error:', resp.status);
          return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
        }
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'set-quiet-hours') {
        const VALID_OVERRIDE = new Set(['critical_only', 'silence_all', 'batch_on_wake']);
        const { variant, quietHoursEnabled, quietHoursStart, quietHoursEnd, quietHoursTimezone, quietHoursOverride, countries } = body;
        if (!variant || quietHoursEnabled === undefined) {
          return finish(json({ error: 'variant and quietHoursEnabled required' }, 400, corsHeaders));
        }
        if (quietHoursOverride !== undefined && !VALID_OVERRIDE.has(quietHoursOverride)) {
          return finish(json({ error: 'invalid quietHoursOverride' }, 400, corsHeaders));
        }
        const resp = await convexRelay({
          action: 'set-quiet-hours',
          userId: session.userId,
          variant,
          quietHoursEnabled,
          quietHoursStart,
          quietHoursEnd,
          quietHoursTimezone,
          quietHoursOverride,
          countries,
        });
        if (!resp.ok) {
          console.error('[notification-channels] POST set-quiet-hours relay error:', resp.status);
          return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
        }
        // If quiet hours were disabled or override changed away from batch_on_wake,
        // flush any held events so they're delivered rather than expiring silently.
        const abandonsBatch = !quietHoursEnabled || quietHoursOverride !== 'batch_on_wake';
        if (abandonsBatch) ctx.waitUntil(publishFlushHeld(session.userId, variant));
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      if (action === 'set-digest-settings') {
        const VALID_DIGEST_MODE = new Set(['realtime', 'daily', 'twice_daily', 'weekly']);
        const { variant, digestMode, digestHour, digestTimezone, countries } = body;
        if (!variant || !digestMode || !VALID_DIGEST_MODE.has(digestMode)) {
          return finish(json({ error: 'variant and valid digestMode required' }, 400, corsHeaders));
        }
        const resp = await convexRelay({
          action: 'set-digest-settings',
          userId: session.userId,
          variant,
          digestMode,
          digestHour,
          digestTimezone,
          countries,
        });
        if (!resp.ok) {
          console.error('[notification-channels] POST set-digest-settings relay error:', resp.status);
          return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
        }
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      // Atomic update of (digestMode, sensitivity) and any subset of the alert-rule
      // fields. The UI's delivery-mode change flow uses this to avoid the two-call
      // race against the cross-field validator.
      // Critical: 400 responses from the relay must pass through with their body
      // intact so the client can render INCOMPATIBLE_DELIVERY helper text.
      // See docs/archive/plans/forbid-realtime-all-events.md §1f.
      if (action === 'set-notification-config') {
        const VALID_SENSITIVITY = new Set(['all', 'high', 'critical']);
        const VALID_DIGEST_MODE = new Set(['realtime', 'daily', 'twice_daily', 'weekly']);
        const { variant, enabled, eventTypes, sensitivity, channels, aiDigestEnabled, digestMode, digestHour, digestTimezone, countries, tickers } = body;
        if (!variant) return finish(json({ error: 'variant required' }, 400, corsHeaders));
        if (sensitivity !== undefined && !VALID_SENSITIVITY.has(sensitivity)) {
          return finish(json({ error: 'invalid sensitivity' }, 400, corsHeaders));
        }
        if (digestMode !== undefined && !VALID_DIGEST_MODE.has(digestMode)) {
          return finish(json({ error: 'invalid digestMode' }, 400, corsHeaders));
        }
        if (countries !== undefined && !Array.isArray(countries)) {
          return finish(json({ error: 'COUNTRIES_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        if (tickers !== undefined && !Array.isArray(tickers)) {
          return finish(json({ error: 'TICKERS_MUST_BE_ARRAY' }, 400, corsHeaders));
        }
        const resp = await convexRelay({
          action: 'set-notification-config',
          userId: session.userId,
          variant,
          enabled,
          eventTypes,
          sensitivity,
          channels,
          aiDigestEnabled,
          digestMode,
          digestHour,
          digestTimezone,
          countries,
          tickers,
        });
        if (!resp.ok) {
          // 400 from convex/http means user-facing validation failure (e.g.
          // INCOMPATIBLE_DELIVERY). 402 means paywall (PRO_REQUIRED). Both
          // must pass through with body intact so the client renders the
          // real reason — inline helper text for 400, upgrade-flow modal
          // for 402 — instead of a generic toast.
          if (resp.status === 400 || resp.status === 402) {
            const text = await resp.text().catch(() => '');
            let payload: unknown = { error: 'Validation failed' };
            if (text) {
              try { payload = JSON.parse(text); } catch { /* keep default */ }
            }
            return finish(json(payload, resp.status, corsHeaders));
          }
          console.error('[notification-channels] POST set-notification-config relay error:', resp.status);
          return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
        }
        return finish(json({ ok: true }, 200, corsHeaders));
      }

      return finish(json({ error: 'Unknown action' }, 400, corsHeaders));
    } catch (err) {
      console.error('[notification-channels] POST error:', err);
      captureEdgeException(err, { handler: 'notification-channels', method: 'POST' }, ctx);
      return finish(json({ error: 'Operation failed' }, 500, corsHeaders));
    }
  }

  return json({ error: 'Method not allowed' }, 405, corsHeaders);
}
