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
import { getEntitlements } from '../server/_shared/entitlement-check';

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
};

function createDefaultNotificationChannelsDeps(): NotificationChannelsDeps {
  return {
    validateBearerToken,
    getEntitlements,
    fetch: (...args) => globalThis.fetch(...args),
  };
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
    await captureSilentError(err, {
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
    const ent = await notificationChannelsDeps.getEntitlements(session.userId);
    if (!ent || ent.features.tier < 1) {
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

        if (webhookEnvelope) {
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
