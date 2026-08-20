import { anyApi, httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { TOUCH_DEBOUNCE_MS } from "./apiKeys";
import {
  CHECKOUT_RATE_LIMITED,
  isCheckoutRateLimitedOutcome,
} from "./payments/checkoutRateLimit";
import { webhookHandler } from "./payments/webhookHandlers";
import { resendWebhookHandler } from "./resendWebhookHandler";
import { USER_PREFS_WRITE_RATE_LIMIT } from "./constants";
import {
  INTEL_HISTORY_EMBED_DIMS,
  INTEL_HISTORY_MAX_APPEND_RECORDS,
  INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS,
} from "./intelHistory";

const TRUSTED = [
  "https://worldmonitor.app",
  "*.worldmonitor.app",
  "http://localhost:3000",
];

const EXPOSED_HEADERS = [
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
].join(", ");

function matchOrigin(origin: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return origin.endsWith(pattern.slice(1));
  }
  return origin === pattern;
}

function allowedOrigin(origin: string | null, trusted: string[]): string | null {
  if (!origin) return null;
  return trusted.some((p) => matchOrigin(origin, p)) ? origin : null;
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  const allowed = allowedOrigin(origin, TRUSTED);
  if (allowed) {
    headers.set("Access-Control-Allow-Origin", allowed);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(a)),
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i]! ^ bArr[i]!;
  return diff === 0;
}

/** Parse a request body only when JSON produced an object (never null or an array). */
async function parseJsonObjectBody<T extends object>(request: Request): Promise<T | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as T
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract a stable error `code` from a thrown ConvexError.
 *
 * Convex's runtime serializes `error.data` to a JSON string before re-throwing
 * across the function boundary (see registration_impl::serializeConvexErrorData),
 * so by the time an http action's catch block sees the error, `err.data` is a
 * JSON-encoded string. Both shapes are handled:
 *   - `throw new ConvexError("PRO_REQUIRED")`  → data = '"PRO_REQUIRED"' → "PRO_REQUIRED"
 *   - `throw new ConvexError({code: "X", ...})` → data = '{"code":"X",…}'  → "X"
 */
function parseConvexErrorData(err: unknown): unknown {
  const raw = (err as { data?: unknown } | undefined)?.data;
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractConvexErrorCode(err: unknown): string | null {
  const parsed = parseConvexErrorData(err);
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    const data = parsed as Record<string, unknown>;
    const code = data.code ?? data.kind;
    if (typeof code === "string") return code;
  }
  return null;
}

function readConvexErrorNumber(err: unknown, field: string): number | null {
  const parsed = parseConvexErrorData(err);
  if (!parsed || typeof parsed !== "object") return null;
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "number" ? value : null;
}

type SetPreferencesResult =
  | { ok: true; syncVersion: number }
  | { ok: false; reason: "CONFLICT"; actualSyncVersion: number }
  | { ok: false; reason: "BLOB_TOO_LARGE"; size: number; max: number }
  | { ok: false; reason: "RATE_LIMITED"; limit: number; reset: number };

function setRateLimitResponseHeaders(headers: Headers, limit: number, reset: number): void {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  headers.set("X-RateLimit-Limit", String(limit));
  headers.set("X-RateLimit-Remaining", "0");
  headers.set("X-RateLimit-Reset", String(reset));
  headers.set("Retry-After", String(retryAfter));
}

export async function internalEntitlementsHttpHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      typeof body.userId !== "string" ||
      body.userId.length === 0 ||
      body.userId.length > 256
    ) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let result = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId: body.userId },
    );
    let billingStatus:
      | "subscription_lapsed"
      | "renewal_verification_pending"
      | "renewal_verification_failed"
      | undefined;
    let retryAfterSeconds: number | undefined;
    let renewalVerificationFreshness:
      | { status: "not_applicable"; checkedAt: number }
      | undefined;

    // Expired stored entitlements are deliberately returned as free-tier
    // defaults by the query. Before the gateway turns that into a hard denial,
    // give a recently-stale active subscription one bounded provider re-check.
    if (result.features.tier === 0) {
      const verification = await ctx.runAction(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        { userId: body.userId },
      );
      if (verification.status === "not_applicable") {
        // Reached only when the user has NO subscription row at all
        // (claimRecentlyStaleSubscriptionForVerification: any billing history
        // yields `lapsed` instead). That cohort includes a buyer whose Dodo
        // webhook has not landed yet, so the edge deliberately serves this
        // marker for a short window only — see
        // NOT_APPLICABLE_VERIFICATION_TTL_SECONDS in
        // server/_shared/entitlement-check.ts (#5600). Widening the cases that
        // produce this marker means revisiting that TTL.
        renewalVerificationFreshness = {
          status: "not_applicable",
          checkedAt: Date.now(),
        };
      } else {
        // The provider action and a webhook can interleave. Always re-read the
        // source of truth before attaching a denial marker so a concurrent
        // renewal wins over a stale action result.
        result = await ctx.runQuery(
          internal.entitlements.getEntitlementsByUserId,
          { userId: body.userId },
        );
        // A stale materialized entitlement can point at the stronger row under
        // verification even while another lower-plan subscription is still
        // current. Preserve that known-good coverage in this response; the
        // billing marker remains attached so callers deny only capabilities
        // the fallback plan does not authorize.
        const fallbackState = await ctx.runQuery(
          internal.payments.billing.getOnDemandRenewalFallbackState,
          { userId: body.userId, now: Date.now() },
        );
        if (
          result.features.tier === 0 &&
          fallbackState?.currentEntitlement
        ) {
          result = fallbackState.currentEntitlement;
        }
        const staleFeatures = fallbackState?.strongestRecentlyStaleFeatures;
        const verificationCouldExpandCoverage = !!staleFeatures && (
          staleFeatures.tier > result.features.tier ||
          (staleFeatures.apiAccess && !result.features.apiAccess) ||
          (staleFeatures.mcpAccess && !result.features.mcpAccess)
        );
        if (
          verification.status !== "active" &&
          (
            result.features.tier === 0 ||
            verificationCouldExpandCoverage
          )
        ) {
          billingStatus = verification.status;
          if ("retryAfterSeconds" in verification) {
            retryAfterSeconds = verification.retryAfterSeconds;
          }
        }
      }
    }

    return new Response(JSON.stringify({
      ...result,
      ...(billingStatus ? { billingStatus } : {}),
      ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}),
      ...(renewalVerificationFreshness ? { renewalVerificationFreshness } : {}),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

const http = httpRouter();

http.route({
  path: "/api/internal-entitlements",
  method: "POST",
  handler: httpAction(internalEntitlementsHttpHandler),
});

http.route({
  path: "/api/user-prefs",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const headers = corsHeaders(request.headers.get("Origin"));
    return new Response(null, { status: 204, headers });
  }),
});

http.route({
  path: "/api/user-prefs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const headers = corsHeaders(request.headers.get("Origin"));
    headers.set("Content-Type", "application/json");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return new Response(JSON.stringify({ error: "UNAUTHENTICATED" }), {
        status: 401,
        headers,
      });
    }

    const body = await parseJsonObjectBody<{
      variant?: string;
      data?: unknown;
      expectedSyncVersion?: number;
      schemaVersion?: number;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers,
      });
    }

    if (
      typeof body.variant !== "string" ||
      body.data === undefined ||
      typeof body.expectedSyncVersion !== "number"
    ) {
      return new Response(JSON.stringify({ error: "MISSING_FIELDS" }), {
        status: 400,
        headers,
      });
    }

    try {
      const result = (await ctx.runMutation(
        anyApi.userPreferences!.setPreferences as any,
        {
          variant: body.variant,
          data: body.data,
          expectedSyncVersion: body.expectedSyncVersion,
          schemaVersion: body.schemaVersion,
        },
      )) as SetPreferencesResult;
      // Expected write denials return as a discriminated result so Convex can
      // commit limiter bookkeeping and duplicate-counter cleanup. Mirror the
      // wire shape from api/user-prefs.ts (Vercel) regardless of host.
      if (result.ok === false) {
        if (result.reason === "BLOB_TOO_LARGE") {
          return new Response(JSON.stringify({ error: "BLOB_TOO_LARGE" }), {
            status: 400,
            headers,
          });
        }
        if (result.reason === "RATE_LIMITED") {
          setRateLimitResponseHeaders(headers, result.limit, result.reset);
          return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
            status: 429,
            headers,
          });
        }
        return new Response(
          JSON.stringify({
            error: "CONFLICT",
            actualSyncVersion: result.actualSyncVersion,
          }),
          { status: 409, headers },
        );
      }
      return new Response(
        JSON.stringify({ syncVersion: result.syncVersion }),
        { status: 200, headers },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = extractConvexErrorCode(err);
      // Defensive: keep CONFLICT-throw fallback for the deploy-ordering
      // window where this http action may run against an older Convex
      // deployment that still throws. Once both layers have soaked, this
      // branch is unreachable and can be removed.
      if (code === "CONFLICT" || msg.includes("CONFLICT")) {
        return new Response(JSON.stringify({ error: "CONFLICT" }), {
          status: 409,
          headers,
        });
      }
      if (code === "BLOB_TOO_LARGE" || msg.includes("BLOB_TOO_LARGE")) {
        return new Response(JSON.stringify({ error: "BLOB_TOO_LARGE" }), {
          status: 400,
          headers,
        });
      }
      if (code === "RATE_LIMITED" || msg.includes("RATE_LIMITED")) {
        const limit = readConvexErrorNumber(err, "limit") ?? USER_PREFS_WRITE_RATE_LIMIT;
        const reset = readConvexErrorNumber(err, "reset") ?? Date.now() + 60_000;
        setRateLimitResponseHeaders(headers, limit, reset);
        return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
          status: 429,
          headers,
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/api/telegram-pair-callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Always return 200 — non-200 triggers Telegram retry storm.
    // Fail closed: drop the update unless the request carries the secret
    // header set when we registered the webhook. Returning 200 without
    // processing keeps Telegram from retrying spoofed requests while still
    // refusing to run the pairing-token claim path on unauthenticated input.
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    if (!secret) {
      console.error(
        "[telegram-webhook] TELEGRAM_WEBHOOK_SECRET not configured — rejecting all requests",
      );
      return new Response("OK", { status: 200 });
    }
    const provided =
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!provided) {
      // Helps ops spot webhook re-registration drift (Telegram dropped the
      // header) without re-enabling the bypass.
      console.warn(
        "[telegram-webhook] secret header absent — rejecting request",
      );
      return new Response("OK", { status: 200 });
    }
    if (!(await timingSafeEqualStrings(provided, secret))) {
      return new Response("OK", { status: 200 });
    }

    const update = await parseJsonObjectBody<{
      message?: {
        chat?: { type?: string; id?: number };
        text?: string;
        date?: number;
      };
    }>(request);
    if (!update) {
      return new Response("OK", { status: 200 });
    }

    const msg = update.message;
    if (!msg) return new Response("OK", { status: 200 });

    if (msg.chat?.type !== "private") return new Response("OK", { status: 200 });

    if (!msg.date || Math.abs(Date.now() / 1000 - msg.date) > 900) {
      return new Response("OK", { status: 200 });
    }

    const text = msg.text?.trim() ?? "";
    const chatId = String(msg.chat.id);

    const match = text.match(/^\/start\s+([A-Za-z0-9_-]{40,50})$/);
    if (!match) return new Response("OK", { status: 200 });

    const claimed = await ctx.runMutation(anyApi.notificationChannels!.claimPairingToken as any, {
      token: match[1],
      chatId,
    });

    // Send welcome on successful first/re-pair — must be awaited in HTTP actions
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    if (claimed.ok && botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "worldmonitor-convex/1.0" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "✅ WorldMonitor connected! You'll receive breaking news alerts here.",
        }),
        signal: AbortSignal.timeout(8000),
      }).catch((err: unknown) => {
        console.error("[telegram-webhook] sendMessage failed:", err);
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

http.route({
  path: "/relay/deactivate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");

    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: string; channelType?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      typeof body.userId !== "string" || !body.userId ||
      (body.channelType !== "telegram" && body.channelType !== "slack" && body.channelType !== "email" && body.channelType !== "discord" && body.channelType !== "web_push")
    ) {
      return new Response(JSON.stringify({ error: "MISSING_FIELDS" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await ctx.runMutation((internal as any).notificationChannels.deactivateChannelForUser, {
      userId: body.userId,
      channelType: body.channelType,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/relay/channels",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");

    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || !body.userId) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const channels = await ctx.runQuery((internal as any).notificationChannels.getChannelsByUserId, {
      userId: body.userId,
    });

    return new Response(JSON.stringify(channels ?? []), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service notification channel management (no user JWT required).
// Authenticated via RELAY_SHARED_SECRET; caller supplies the validated userId.
http.route({
  path: "/relay/notification-channels",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{
      action?: string;
      userId?: string;
      channelType?: string;
      chatId?: string;
      webhookEnvelope?: string;
      webhookLabel?: string;
      email?: string;
      variant?: string;
      enabled?: boolean;
      eventTypes?: string[];
      sensitivity?: string;
      channels?: string[];
      slackChannelName?: string;
      slackTeamName?: string;
      slackConfigurationUrl?: string;
      discordGuildId?: string;
      discordChannelId?: string;
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
      countries?: string[];
      tickers?: string[];
      scheduleWelcome?: boolean;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { action = "get", userId } = body;
    if (typeof userId !== "string" || !userId) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      if (action === "get") {
        const [channels, alertRules] = await Promise.all([
          ctx.runQuery((internal as any).notificationChannels.getChannelsByUserId, { userId }),
          ctx.runQuery((internal as any).alertRules.getAlertRulesByUserId, { userId }),
        ]);
        return new Response(JSON.stringify({ channels: channels ?? [], alertRules: alertRules ?? [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "welcome-scheduling-capability") {
        return new Response(
          JSON.stringify({ durableWelcomeScheduling: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (action === "create-pairing-token") {
        const result = await ctx.runMutation((internal as any).notificationChannels.createPairingTokenForUser, {
          userId,
          variant: body.variant,
        });
        return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-channel") {
        if (!body.channelType) {
          return new Response(JSON.stringify({ error: "channelType required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const setResult = await ctx.runMutation((internal as any).notificationChannels.setChannelForUser, {
          userId,
          channelType: body.channelType as "telegram" | "slack" | "email" | "webhook",
          chatId: body.chatId,
          webhookEnvelope: body.webhookEnvelope,
          email: body.email,
          webhookLabel: body.webhookLabel,
          scheduleWelcome: body.scheduleWelcome === true,
        });
        return new Response(JSON.stringify({
          ok: true,
          isNew: setResult.isNew,
          durableWelcomeScheduling: body.scheduleWelcome === true,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-slack-oauth") {
        if (!body.webhookEnvelope) {
          return new Response(JSON.stringify({ error: "webhookEnvelope required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const oauthResult = await ctx.runMutation((internal as any).notificationChannels.setSlackOAuthChannelForUser, {
          userId,
          webhookEnvelope: body.webhookEnvelope,
          slackChannelName: body.slackChannelName,
          slackTeamName: body.slackTeamName,
          slackConfigurationUrl: body.slackConfigurationUrl,
        });
        return new Response(JSON.stringify({ ok: true, isNew: oauthResult.isNew }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-discord-oauth") {
        if (!body.webhookEnvelope) {
          return new Response(JSON.stringify({ error: "webhookEnvelope required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const discordResult = await ctx.runMutation((internal as any).notificationChannels.setDiscordOAuthChannelForUser, {
          userId,
          webhookEnvelope: body.webhookEnvelope,
          discordGuildId: body.discordGuildId,
          discordChannelId: body.discordChannelId,
        });
        return new Response(JSON.stringify({ ok: true, isNew: discordResult.isNew }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-web-push") {
        if (!body.endpoint || !body.p256dh || !body.auth) {
          return new Response(JSON.stringify({ error: "endpoint, p256dh, auth required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const webPushResult = await ctx.runMutation((internal as any).notificationChannels.setWebPushChannelForUser, {
          userId,
          endpoint: body.endpoint,
          p256dh: body.p256dh,
          auth: body.auth,
          userAgent: body.userAgent,
          scheduleWelcome: body.scheduleWelcome === true,
        });
        return new Response(JSON.stringify({
          ok: true,
          isNew: webPushResult.isNew,
          durableWelcomeScheduling: body.scheduleWelcome === true,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "delete-channel") {
        if (!body.channelType) {
          return new Response(JSON.stringify({ error: "channelType required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await ctx.runMutation((internal as any).notificationChannels.deleteChannelForUser, {
          userId,
          channelType: body.channelType as "telegram" | "slack" | "email" | "discord",
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-alert-rules") {
        const VALID_SENSITIVITY = new Set(["all", "high", "critical"]);
        if (
          typeof body.variant !== "string" || !body.variant ||
          typeof body.enabled !== "boolean" ||
          !Array.isArray(body.eventTypes) ||
          !Array.isArray(body.channels) ||
          (body.sensitivity !== undefined && !VALID_SENSITIVITY.has(body.sensitivity as string)) ||
          (body.countries !== undefined && !Array.isArray(body.countries)) ||
          (body.tickers !== undefined && !Array.isArray(body.tickers))
        ) {
          return new Response(JSON.stringify({ error: "MISSING_REQUIRED_FIELDS" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        try {
          await ctx.runMutation((internal as any).alertRules.setAlertRulesForUser, {
            userId,
            variant: body.variant,
            enabled: body.enabled,
            eventTypes: body.eventTypes as string[],
            // Pass body.sensitivity through unchanged (may be undefined).
            // setAlertRulesForUser now accepts optional sensitivity and uses
            // resolveEffectivePair to preserve existing.sensitivity on patch and
            // default to 'high' only on fresh insert. A blind '?? "all"' fallback
            // here would silently narrow existing daily+all digest users to
            // daily+high whenever a caller omits the field.
            // See docs/archive/plans/forbid-realtime-all-events.md §1c.
            sensitivity: body.sensitivity as "all" | "high" | "critical" | undefined,
            channels: body.channels as Array<"telegram" | "slack" | "email">,
            aiDigestEnabled: typeof body.aiDigestEnabled === "boolean" ? body.aiDigestEnabled : undefined,
            // ISO-3166 alpha-2 country-scope; mutation re-validates + normalizes.
            countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
            // Watchlist ticker-scope (#4922 U3); mutation re-validates + normalizes.
            tickers: Array.isArray(body.tickers) ? (body.tickers as string[]) : undefined,
          });
        } catch (err: unknown) {
          // normalizeTickers/normalizeCountries throw ConvexError with a
          // structured code (TICKERS_LIMIT_EXCEEDED / COUNTRIES_LIMIT_EXCEEDED)
          // when a caller exceeds the 50-entry cap. Surface those as a 400 with
          // the machine-readable code — matching the set-notification-config
          // path below — instead of letting them fall to the outer catch as a
          // generic 500, which the client can't route on.
          const code = extractConvexErrorCode(err);
          if (code === "TICKERS_LIMIT_EXCEEDED" || code === "COUNTRIES_LIMIT_EXCEEDED") {
            return new Response(JSON.stringify({ error: code }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          throw err;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-quiet-hours") {
        const VALID_OVERRIDE = new Set(["critical_only", "silence_all", "batch_on_wake"]);
        if (typeof body.variant !== "string" || !body.variant || typeof body.quietHoursEnabled !== "boolean") {
          return new Response(JSON.stringify({ error: "variant and quietHoursEnabled required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.quietHoursOverride !== undefined && !VALID_OVERRIDE.has(body.quietHoursOverride)) {
          return new Response(JSON.stringify({ error: "invalid quietHoursOverride" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await ctx.runMutation((internal as any).alertRules.setQuietHoursForUser, {
          userId,
          variant: body.variant,
          quietHoursEnabled: body.quietHoursEnabled,
          quietHoursStart: body.quietHoursStart,
          quietHoursEnd: body.quietHoursEnd,
          quietHoursTimezone: body.quietHoursTimezone,
          quietHoursOverride: body.quietHoursOverride as "critical_only" | "silence_all" | "batch_on_wake" | undefined,
          countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (action === "set-digest-settings") {
        const VALID_DIGEST_MODE = new Set(["realtime", "daily", "twice_daily", "weekly"]);
        if (
          typeof body.variant !== "string" || !body.variant ||
          !VALID_DIGEST_MODE.has(body.digestMode as string)
        ) {
          return new Response(JSON.stringify({ error: "MISSING_REQUIRED_FIELDS" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await ctx.runMutation((internal as any).alertRules.setDigestSettingsForUser, {
          userId,
          variant: body.variant,
          digestMode: body.digestMode as "realtime" | "daily" | "twice_daily" | "weekly",
          digestHour: typeof body.digestHour === "number" ? body.digestHour : undefined,
          digestTimezone: typeof body.digestTimezone === "string" ? body.digestTimezone : undefined,
          countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Atomic update of (digestMode, sensitivity) and any subset of the alert-rule /
      // digest-schedule fields. Used by the settings UI's delivery-mode change flow
      // to avoid the two-call race that the legacy set-alert-rules + set-digest-settings
      // pair has against the cross-field validator.
      // See docs/archive/plans/forbid-realtime-all-events.md §1d, §1f.
      if (action === "set-notification-config") {
        const VALID_SENSITIVITY = new Set(["all", "high", "critical"]);
        const VALID_DIGEST_MODE = new Set(["realtime", "daily", "twice_daily", "weekly"]);
        if (typeof body.variant !== "string" || !body.variant) {
          return new Response(JSON.stringify({ error: "MISSING_VARIANT" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.sensitivity !== undefined && !VALID_SENSITIVITY.has(body.sensitivity as string)) {
          return new Response(JSON.stringify({ error: "INVALID_SENSITIVITY" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.digestMode !== undefined && !VALID_DIGEST_MODE.has(body.digestMode as string)) {
          return new Response(JSON.stringify({ error: "INVALID_DIGEST_MODE" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.countries !== undefined && !Array.isArray(body.countries)) {
          return new Response(JSON.stringify({ error: "COUNTRIES_MUST_BE_ARRAY" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (body.tickers !== undefined && !Array.isArray(body.tickers)) {
          return new Response(JSON.stringify({ error: "TICKERS_MUST_BE_ARRAY" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        try {
          await ctx.runMutation((internal as any).alertRules.setNotificationConfigForUser, {
            userId,
            variant: body.variant,
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
            eventTypes: Array.isArray(body.eventTypes) ? (body.eventTypes as string[]) : undefined,
            sensitivity: body.sensitivity as "all" | "high" | "critical" | undefined,
            channels: Array.isArray(body.channels) ? (body.channels as Array<"telegram" | "slack" | "email" | "discord" | "webhook" | "web_push">) : undefined,
            aiDigestEnabled: typeof body.aiDigestEnabled === "boolean" ? body.aiDigestEnabled : undefined,
            digestMode: body.digestMode as "realtime" | "daily" | "twice_daily" | "weekly" | undefined,
            digestHour: typeof body.digestHour === "number" ? body.digestHour : undefined,
            digestTimezone: typeof body.digestTimezone === "string" ? body.digestTimezone : undefined,
            countries: Array.isArray(body.countries) ? (body.countries as string[]) : undefined,
            tickers: Array.isArray(body.tickers) ? (body.tickers as string[]) : undefined,
          });
        } catch (err: unknown) {
          // Translate structured ConvexError codes into machine-readable HTTP
          // responses so the UI can route to inline helper text (400) or to
          // the upgrade flow (402). Do NOT swallow as a generic 500 — the
          // client needs the structured `error` field to render the right
          // surface. Use extractConvexErrorCode, which decodes the JSON-STRING
          // shape ctx.runMutation serializes err.data into across the function
          // boundary (see :67) — a manual `typeof data === "object"` check
          // misses every code on this path.
          const code = extractConvexErrorCode(err);
          // Preserve the ConvexError message where present — the client renders
          // it as inline helper text for INCOMPATIBLE_DELIVERY.
          const parsed = parseConvexErrorData(err);
          const message = (parsed && typeof parsed === "object")
            ? (parsed as { message?: string }).message ?? ""
            : "";
          if (code === "INCOMPATIBLE_DELIVERY" || code === "TICKERS_LIMIT_EXCEEDED" || code === "COUNTRIES_LIMIT_EXCEEDED") {
            return new Response(JSON.stringify({ error: code, message }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          if (code === "PRO_REQUIRED") {
            // 402 Payment Required — the canonical HTTP status for paywall-gated
            // content. Client reads `error: "PRO_REQUIRED"` to route to the
            // upgrade flow rather than show a generic failure toast.
            return new Response(JSON.stringify({ error: code, message }), { status: 402, headers: { "Content-Type": "application/json" } });
          }
          throw err;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: { "Content-Type": "application/json" } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }),
});

// Service-to-service: Railway digest cron fetches due rules (no user JWT required).
http.route({
  path: "/relay/digest-rules",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const rules = await ctx.runQuery((internal as any).alertRules.getDigestRules);
    return new Response(JSON.stringify(rules), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service: the notification relay fetches ALL enabled rules (it
// fans out alerts + drains quiet-hours batches). Wraps the INTERNAL
// `alertRules.getByEnabled` (GHSA-r649-4cqj-w93h) behind the shared secret so
// the cross-tenant scan is never reachable anonymously. `?enabled=false`
// selects the disabled set; defaults to enabled=true (all the relay ever asks).
http.route({
  path: "/relay/enabled-rules",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const enabled = new URL(request.url).searchParams.get("enabled") !== "false";
    const rules = await ctx.runQuery(
      (internal as any).alertRules.getByEnabled,
      { enabled },
    );
    return new Response(JSON.stringify(rules), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/relay/user-preferences",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = await parseJsonObjectBody<{ userId?: string; variant?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.userId || !body.variant) {
      return new Response(JSON.stringify({ error: "userId and variant required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const prefs = await ctx.runQuery(
      (internal as any).userPreferences.getPreferencesByUserId,
      { userId: body.userId, variant: body.variant },
    );
    return new Response(JSON.stringify(prefs?.data ?? null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Followed-countries relay (plan U14). Mirrors `/relay/user-preferences`:
// shared-secret auth in the Authorization header, POST {userId} body, returns
// `{ countries: string[] }`. Used by server-side cron consumers (PR C brief
// composer) that need a typed `string[]` watchlist for a given user without
// going through the Clerk-authenticated `listFollowed` query.
http.route({
  path: "/relay/followed-countries",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = await parseJsonObjectBody<{ userId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    // P2 #19 — Mirror /relay/user-preferences validation rigor: userId
    // must be a non-empty string with bounded length (Clerk subjects are
    // short, ~30 chars; cap at 256 defensively).
    if (
      typeof body.userId !== "string" ||
      body.userId.length === 0 ||
      body.userId.length > 256
    ) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const countries = await ctx.runQuery(
      internal.followedCountries.internalListFollowedForUser,
      { userId: body.userId },
    );
    return new Response(JSON.stringify({ countries }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/relay/entitlement",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = await parseJsonObjectBody<{ userId?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const ent = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId: body.userId },
    );
    const tier = ent?.features?.tier ?? 0;
    return new Response(JSON.stringify({ tier }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Referral code registration (Phase 9 / Todo #223)
// ---------------------------------------------------------------------------

// Edge-route companion for /api/referral/me. Binds a Clerk-derived
// 8-char share code to the signed-in user's Clerk userId so future
// /pro?ref=<code> signups can credit the sharer via the
// userReferralCredits path in registerInterest:register. Auth is
// server-to-server via RELAY_SHARED_SECRET — the edge route already
// validated the caller's Clerk bearer before hitting this.
http.route({
  path: "/relay/register-referral-code",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = await parseJsonObjectBody<{ userId?: string; code?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!userId || !code || code.length < 4 || code.length > 32) {
      return new Response(JSON.stringify({ error: "userId + code required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await ctx.runMutation(
      (internal as any).registerInterest.registerUserReferralCode,
      { userId, code },
    );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// User API key validation (service-to-service only)
// ---------------------------------------------------------------------------

// Schedule-site half of the lastUsedAt debounce (the mutation-side half lives
// in touchKeyLastUsed / touchProMcpTokenLastUsed). Scheduling a touch on
// EVERY validation meant that at each debounce boundary all concurrently
// scheduled touches read the same stale lastUsedAt and patched the same hot
// document — 1,036 OCC write conflicts on userApiKeys in 14 days at up to
// retry depth 3 (Convex Insights, 2026-08). A fresh lastUsedAt makes the
// touch a guaranteed no-op, so don't enqueue it at all; only genuinely stale
// (or never-touched) rows schedule, which also drops one scheduled job per
// validation off the scheduler.
function touchIsDue(lastUsedAt: unknown): boolean {
  return typeof lastUsedAt !== "number" || lastUsedAt <= Date.now() - TOUCH_DEBOUNCE_MS;
}

// Service-to-service: validate a user API key by its SHA-256 hash.
// Called by the Vercel edge gateway to look up user-owned keys.
http.route({
  path: "/api/internal-validate-api-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ keyHash?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.keyHash !== "string" || body.keyHash.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_KEY_HASH" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      (internal as any).apiKeys.validateKeyByHash,
      { keyHash: body.keyHash },
    );

    if (result && touchIsDue(result.lastUsedAt)) {
      try {
        await ctx.scheduler.runAfter(0, (internal as any).apiKeys.touchKeyLastUsed, { keyId: result.id });
      } catch (err) {
        // sentry-coverage-ok: re-throwing here would 500 the gateway, which coerces to null
        // and stamps a 60s negative-cache sentinel for a valid key. lastUsedAt is best-effort telemetry.
        console.warn("[validate-api-key] touchKeyLastUsed schedule failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Strip the gate's input from the response: the gateway caches this blob
    // in Redis for 60s and its shape is load-bearing (isUserKeyResult in
    // api/_user-api-key.js) — lastUsedAt exists for the gate above only.
    const publicResult = result
      ? (({ lastUsedAt: _lastUsedAt, ...rest }) => rest)(result)
      : null;

    return new Response(JSON.stringify(publicResult), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service: look up the owner of a key by hash (regardless of revoked status).
// Used by the cache-invalidation endpoint to verify tenancy boundaries.
http.route({
  path: "/api/internal-get-key-owner",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ keyHash?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.keyHash !== "string" || !/^[a-f0-9]{64}$/.test(body.keyHash)) {
      return new Response(JSON.stringify({ error: "INVALID_KEY_HASH" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      (internal as any).apiKeys.getKeyOwner,
      { keyHash: body.keyHash },
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Pro MCP token routes (service-to-service, x-convex-shared-secret auth).
// Called by the Vercel edge (api/oauth/authorize-pro, api/mcp.ts, settings).
// See plan U1 / docs/plans/2026-05-10-001-feat-pro-mcp-clerk-auth-quota-plan.md
// ---------------------------------------------------------------------------

http.route({
  path: "/api/internal-issue-pro-mcp-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{
      userId?: unknown;
      clientId?: unknown;
      name?: unknown;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || body.userId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runMutation(
        (internal as any).mcpProTokens.issueProMcpToken,
        {
          userId: body.userId,
          clientId: typeof body.clientId === "string" ? body.clientId : undefined,
          name: typeof body.name === "string" ? body.name : undefined,
        },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      const code = extractConvexErrorCode(err);
      if (code === "PRO_REQUIRED") {
        return new Response(JSON.stringify({ error: "PRO_REQUIRED" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (code === "INVALID_USER_ID") {
        return new Response(JSON.stringify({ error: "INVALID_USER_ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/api/internal-validate-pro-mcp-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ tokenId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.tokenId !== "string" || body.tokenId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_TOKEN_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runQuery(
        (internal as any).mcpProTokens.validateProMcpToken,
        { tokenId: body.tokenId },
      );

      if (result && touchIsDue(result.lastUsedAt)) {
        try {
          await ctx.scheduler.runAfter(
            0,
            (internal as any).mcpProTokens.touchProMcpTokenLastUsed,
            { tokenId: body.tokenId },
          );
        } catch (err) {
          // sentry-coverage-ok: best-effort lastUsedAt bump; mirrors the
          // touchKeyLastUsed pattern in /api/internal-validate-api-key.
          console.warn(
            "[validate-pro-mcp-token] touch schedule failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Strip the gate's input: the wire contract is exactly `{ userId }`
      // (pinned by mcpProTokens.test.ts) — lastUsedAt feeds the gate only.
      const publicResult = result ? { userId: result.userId } : null;

      return new Response(JSON.stringify(publicResult), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      // Convex `v.id("mcpProTokens")` validator rejects malformed ids with
      // a runtime error — surface as null (caller treats as "no such token")
      // instead of 500-ing the gateway.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ArgumentValidationError") || msg.includes("not a valid id")) {
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/api/internal-revoke-pro-mcp-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: unknown; tokenId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || body.userId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (typeof body.tokenId !== "string" || body.tokenId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_TOKEN_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Service-to-service revoke. The shared secret + supplied userId is the
    // tenancy gate (the user-facing /api/v1/mcp-pro-tokens revoke endpoint
    // re-validates ownership through requireUserId in the public mutation).
    // This route bypasses requireUserId because the edge caller is trusted
    // (e.g. authorize-pro rolling back an aborted issue).
    try {
      const result = await ctx.runMutation(
        (internal as any).mcpProTokens.internalRevokeProMcpToken,
        { userId: body.userId, tokenId: body.tokenId },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      const code = extractConvexErrorCode(err);
      if (code === "NOT_FOUND") {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (code === "ALREADY_REVOKED") {
        return new Response(JSON.stringify({ error: "ALREADY_REVOKED" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ArgumentValidationError") || msg.includes("not a valid id")) {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/dodopayments-webhook",
  method: "POST",
  handler: webhookHandler,
});

// Service-to-service: Vercel edge gateway creates Dodo checkout sessions.
// Authenticated via RELAY_SHARED_SECRET; edge endpoint validates Clerk JWT
// and forwards the verified userId.
http.route({
  path: "/relay/create-checkout",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/,
      "",
    );
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{
      userId?: string;
      email?: string;
      name?: string;
      productId?: string;
      returnUrl?: string;
      discountCode?: string;
      referralCode?: string;
      attributionSource?: string;
      bypassPendingGuard?: boolean;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!body.userId || !body.productId) {
      return new Response(
        JSON.stringify({ error: "MISSING_FIELDS", required: ["userId", "productId"] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runAction(
        internal.payments.checkout.internalCreateCheckout,
        {
          userId: body.userId,
          email: body.email,
          name: body.name,
          productId: body.productId,
          returnUrl: body.returnUrl,
          discountCode: body.discountCode,
          referralCode: body.referralCode,
          attributionSource: body.attributionSource,
          bypassPendingGuard: body.bypassPendingGuard,
        },
      );
      if (isCheckoutRateLimitedOutcome(result)) {
        return new Response(
          JSON.stringify({
            error: CHECKOUT_RATE_LIMITED,
            message: "Checkout is temporarily rate limited. Retry shortly.",
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(result.retryAfterSeconds),
            },
          },
        );
      }
      if (
        result &&
        typeof result === "object" &&
        "blocked" in result &&
        result.blocked === true
      ) {
        // Both blocked shapes share { code, message }; the duplicate-subscription
        // block carries `subscription`, the pending-payment block (#4438) carries
        // `pendingPayment`. Forward whichever is present so the client dialog can
        // render. Both return 409 — the client discriminates on `error` (code).
        const blockedBody: Record<string, unknown> = {
          error: result.code,
          message: result.message,
        };
        if ("subscription" in result) blockedBody.subscription = result.subscription;
        if ("pendingPayment" in result) blockedBody.pendingPayment = result.pendingPayment;
        return new Response(JSON.stringify(blockedBody), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Checkout creation failed";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Service-to-service: Vercel edge gateway creates Dodo customer portal sessions.
// Authenticated via RELAY_SHARED_SECRET; edge endpoint validates Clerk JWT
// and forwards the verified userId.
http.route({
  path: "/relay/customer-portal",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/,
      "",
    );
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!body.userId) {
      return new Response(
        JSON.stringify({ error: "MISSING_FIELDS", required: ["userId"] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runAction(
        internal.payments.billing.internalGetCustomerPortalUrl,
        { userId: body.userId },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Customer portal creation failed";
      const status = msg === "No Dodo customer found for this user" ? 404 : 500;
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Resend webhook: captures bounce/complaint events and suppresses emails.
// Signature verification + internal mutation, same pattern as Dodo webhook.
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: resendWebhookHandler,
});

// Bulk email suppression: service-to-service, authenticated via RELAY_SHARED_SECRET.
// Used by the one-time import script (scripts/import-bounced-emails.mjs).
http.route({
  path: "/relay/bulk-suppress-emails",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/,
      "",
    );
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{
      emails: Array<{
        email: string;
        reason: "bounce" | "complaint" | "manual";
        source?: string;
      }>;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!Array.isArray(body.emails) || body.emails.length === 0) {
      return new Response(
        JSON.stringify({ error: "MISSING_FIELDS", required: ["emails"] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runMutation(
        internal.emailSuppressions.bulkSuppress,
        { emails: body.emails },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bulk suppress failed";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// ---------------------------------------------------------------------------
// Historical intelligence memory (#5694).
//
// Ingest is server-to-server from the Railway seeders (RELAY_SHARED_SECRET,
// same bearer convention as every other /relay/* route); the two read routes
// are called by the Vercel edge (CONVEX_SERVER_SHARED_SECRET, same header
// convention as the other /api/internal-* routes). Nothing here is reachable
// by a browser: the underlying Convex functions are all `internal*`.
//
// The validation below is the real trust boundary. `append` re-checks the
// batch size and vector shape, but a seeder should get a 400 naming the bad
// record, not an opaque mutation throw — and the length caps stop a runaway
// scraper from writing multi-megabyte titles into a table with no natural
// ceiling.
// ---------------------------------------------------------------------------

const INTEL_HISTORY_MAX_TITLE_LEN = 500;
const INTEL_HISTORY_MAX_SUMMARY_LEN = 2000;
const INTEL_HISTORY_MAX_SOURCE_URL_LEN = 2048;
const INTEL_HISTORY_MAX_DEDUPE_KEY_LEN = 256;
const INTEL_HISTORY_MAX_COUNTRY_LEN = 8;
const INTEL_HISTORY_MAX_CATEGORY_LEN = 64;
const INTEL_HISTORY_MAX_IDENTIFIER_LEN = 128;

/** JSON response helper for the intel-history routes below. */
function intelJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Bearer check shared by every `/relay/intel-history*` route. A missing
 * configured secret is a rejection, not an open door — an unconfigured
 * deployment must not accept writes from anyone who guesses the path.
 *
 * DEDICATED RETRACTION CREDENTIAL (#5743). `RELAY_SHARED_SECRET` is held by
 * every Railway seeder that appends history — a wide distribution that was
 * fine when the worst a leak could do was write false intelligence, since the
 * real rows survived alongside it. The retraction routes delete rows and
 * permanently suppress their identities, and that direction does not undo:
 * `restore` cannot resurrect a row whose embedding is gone. Setting
 * `RELAY_RETRACT_SECRET` keeps those three routes on their own credential
 * that the seeder fleet does not carry. There is deliberately no shared-secret
 * fallback: an unconfigured deployment fails closed instead of granting every
 * seeder archive-deletion authority.
 */
async function intelRelayUnauthorized(
  request: Request,
  { retraction = false }: { retraction?: boolean } = {},
): Promise<boolean> {
  const secret = retraction
    ? (process.env.RELAY_RETRACT_SECRET ?? "")
    : (process.env.RELAY_SHARED_SECRET ?? "");
  const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
  if (!secret) return true;
  return !(await timingSafeEqualStrings(provided, secret));
}

type IntelHistoryIngestRecord = {
  dedupeKey: string;
  country?: string;
  category?: string;
  title: string;
  summary?: string;
  sourceUrl?: string;
  occurredAt: number;
  embedding: number[];
};

type FieldResult<T> = { ok: true; value: T } | { ok: false };

/** Absent/null → undefined; present → a non-empty string within `max`. */
function readOptionalString(value: unknown, max: number): FieldResult<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    return { ok: false };
  }
  return { ok: true, value };
}

/** Absent/null → undefined; present → a finite number. */
function readOptionalNumber(value: unknown): FieldResult<number | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

/** A query vector is only usable at exactly the index's dimension, all finite. */
function isValidEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === INTEL_HISTORY_EMBED_DIMS &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** Only http(s) links may be stored; see the seeder-side twin in scripts/_seed-history.mjs. */
function isHttpUrl(value: string): boolean {
  try {
    const scheme = new URL(value).protocol;
    return scheme === "https:" || scheme === "http:";
  } catch {
    return false;
  }
}

function validateIntelHistoryRecord(
  raw: unknown,
): { ok: true; record: IntelHistoryIngestRecord } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "record must be a JSON object" };
  }
  const rec = raw as Record<string, unknown>;

  if (
    typeof rec.dedupeKey !== "string" ||
    rec.dedupeKey.length === 0 ||
    rec.dedupeKey.length > INTEL_HISTORY_MAX_DEDUPE_KEY_LEN
  ) {
    return {
      ok: false,
      reason: `dedupeKey must be a non-empty string of at most ${INTEL_HISTORY_MAX_DEDUPE_KEY_LEN} chars`,
    };
  }
  if (
    typeof rec.title !== "string" ||
    rec.title.length === 0 ||
    rec.title.length > INTEL_HISTORY_MAX_TITLE_LEN
  ) {
    return {
      ok: false,
      reason: `title must be a non-empty string of at most ${INTEL_HISTORY_MAX_TITLE_LEN} chars`,
    };
  }
  if (typeof rec.occurredAt !== "number" || !Number.isFinite(rec.occurredAt)) {
    return { ok: false, reason: "occurredAt must be a finite epoch-ms number" };
  }
  if (!isValidEmbedding(rec.embedding)) {
    return {
      ok: false,
      reason: `embedding must be an array of ${INTEL_HISTORY_EMBED_DIMS} finite numbers`,
    };
  }

  const country = readOptionalString(rec.country, INTEL_HISTORY_MAX_COUNTRY_LEN);
  if (!country.ok) return { ok: false, reason: "country must be a short ISO2-ish string" };
  const category = readOptionalString(rec.category, INTEL_HISTORY_MAX_CATEGORY_LEN);
  if (!category.ok) {
    return {
      ok: false,
      reason: `category must be a string of at most ${INTEL_HISTORY_MAX_CATEGORY_LEN} chars`,
    };
  }
  const summary = readOptionalString(rec.summary, INTEL_HISTORY_MAX_SUMMARY_LEN);
  if (!summary.ok) {
    return {
      ok: false,
      reason: `summary must be a string of at most ${INTEL_HISTORY_MAX_SUMMARY_LEN} chars`,
    };
  }
  const sourceUrl = readOptionalString(rec.sourceUrl, INTEL_HISTORY_MAX_SOURCE_URL_LEN);
  if (!sourceUrl.ok) {
    return {
      ok: false,
      reason: `sourceUrl must be a string of at most ${INTEL_HISTORY_MAX_SOURCE_URL_LEN} chars`,
    };
  }
  // Re-checked here even though the seeder sanitizes: this is the trust
  // boundary, and a compromised relay credential must not be able to store a
  // `javascript:`/`data:` value in a field the MCP tools publish to agents as
  // a canonical link. Rejected rather than silently dropped — unlike the
  // seeder, which is projecting a whole run and should keep the row, a caller
  // POSTing here has sent an explicitly bad field and should be told.
  if (sourceUrl.value !== undefined && !isHttpUrl(sourceUrl.value)) {
    return { ok: false, reason: "sourceUrl must be an http(s) URL" };
  }

  return {
    ok: true,
    record: {
      dedupeKey: rec.dedupeKey,
      title: rec.title,
      occurredAt: rec.occurredAt,
      embedding: rec.embedding,
      country: country.value,
      category: category.value,
      summary: summary.value,
      sourceUrl: sourceUrl.value,
    },
  };
}

/** Shared scope/window parsing for the two read routes. */
function readIntelQueryScope(body: Record<string, unknown>):
  | {
      ok: true;
      scope: {
        domain?: string;
        country?: string;
        from?: number;
        to?: number;
        limit?: number;
      };
    }
  | { ok: false; error: string } {
  const domain = readOptionalString(body.domain, INTEL_HISTORY_MAX_IDENTIFIER_LEN);
  if (!domain.ok) return { ok: false, error: "INVALID_DOMAIN" };
  const country = readOptionalString(body.country, INTEL_HISTORY_MAX_COUNTRY_LEN);
  if (!country.ok) return { ok: false, error: "INVALID_COUNTRY" };
  const from = readOptionalNumber(body.from);
  if (!from.ok) return { ok: false, error: "INVALID_FROM" };
  const to = readOptionalNumber(body.to);
  if (!to.ok) return { ok: false, error: "INVALID_TO" };
  const limit = readOptionalNumber(body.limit);
  if (!limit.ok) return { ok: false, error: "INVALID_LIMIT" };

  return {
    ok: true,
    scope: {
      domain: domain.value,
      country: country.value,
      from: from.value,
      to: to.value,
      limit: limit.value,
    },
  };
}

http.route({
  path: "/relay/intel-history",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (await intelRelayUnauthorized(request)) {
      return intelJson({ error: "UNAUTHORIZED" }, 401);
    }

    const body = await parseJsonObjectBody<{
      domain?: unknown;
      resource?: unknown;
      runId?: unknown;
      records?: unknown;
    }>(request);
    if (!body) {
      return intelJson({ error: "INVALID_JSON" }, 400);
    }

    const missing: string[] = [];
    for (const field of ["domain", "resource", "runId"] as const) {
      const value = body[field];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > INTEL_HISTORY_MAX_IDENTIFIER_LEN
      ) {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      return intelJson({ error: "MISSING_FIELDS", required: missing }, 400);
    }
    if (!Array.isArray(body.records) || body.records.length === 0) {
      return intelJson({ error: "MISSING_FIELDS", required: ["records"] }, 400);
    }
    if (body.records.length > INTEL_HISTORY_MAX_APPEND_RECORDS) {
      return intelJson(
        {
          error: "TOO_MANY_RECORDS",
          max: INTEL_HISTORY_MAX_APPEND_RECORDS,
          got: body.records.length,
        },
        400,
      );
    }

    // Validate the whole batch before writing any of it, so a seeder never
    // sees a partial ingest reported as a failure.
    const records: IntelHistoryIngestRecord[] = [];
    for (let i = 0; i < body.records.length; i++) {
      const validated = validateIntelHistoryRecord(body.records[i]);
      if (!validated.ok) {
        return intelJson(
          { error: "INVALID_RECORD", index: i, reason: validated.reason },
          400,
        );
      }
      records.push(validated.record);
    }

    try {
      const result = await ctx.runMutation(internal.intelHistory.append, {
        domain: body.domain as string,
        resource: body.resource as string,
        runId: body.runId as string,
        records,
      });
      return intelJson(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "intel history append failed";
      return intelJson({ error: msg }, 500);
    }
  }),
});

// ---------------------------------------------------------------------------
// Retraction (#5743)
//
// The history store is agent-facing and durable for 180 days, so a poisoned or
// factually wrong feed item is retrievable long after the live snapshot that
// produced it has rolled over. These two routes are the supported way to take
// one back and to undo that — the alternative was a hand-run Convex console
// operation, which is not a path anyone should be following during an
// incident.
//
// Same shared secret as ingest, deliberately: it is the credential the
// operator tooling already holds, and both directions of this pair only ever
// affect rows that credential's own seeders wrote. What keeps its blast radius
// small is the SHAPE of the arguments — explicit ids and dedupe keys, capped
// per call, with nothing pattern- or scope-shaped that could sweep the table.
// ---------------------------------------------------------------------------

const INTEL_HISTORY_MAX_REASON_LEN = 500;
const INTEL_HISTORY_MAX_ID_LEN = 128;

/**
 * Read an optional array of non-empty identifier strings. Absent → []. Any
 * malformed member fails the whole request: a retraction that silently drops
 * one of the identifiers an operator listed would report success while leaving
 * the record it was called about live.
 */
function readIdentifierList(
  value: unknown,
  max: number,
): FieldResult<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false };
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > max) {
      return { ok: false };
    }
    // Reject anything that is not already trimmed, rather than trimming it
    // here. A stray space from a copy-paste makes the retraction look up an
    // identity that does not exist, so it deletes nothing, writes a tombstone
    // for the typo, and returns 200 — the operator reads "tombstoned: 1" while
    // the poisoned record stays live and retrievable. Silently trimming would
    // fix that one case and hide the class; rejecting makes the typo visible.
    if (entry !== entry.trim()) return { ok: false };
  }
  return { ok: true, value: value as string[] };
}

http.route({
  path: "/relay/intel-history/retract",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (await intelRelayUnauthorized(request, { retraction: true })) {
      return intelJson({ error: "UNAUTHORIZED" }, 401);
    }

    const body = await parseJsonObjectBody<Record<string, unknown>>(request);
    if (!body) return intelJson({ error: "INVALID_JSON" }, 400);

    const ids = readIdentifierList(body.ids, INTEL_HISTORY_MAX_ID_LEN);
    if (!ids.ok) return intelJson({ error: "INVALID_IDS" }, 400);
    const dedupeKeys = readIdentifierList(
      body.dedupeKeys,
      INTEL_HISTORY_MAX_DEDUPE_KEY_LEN,
    );
    if (!dedupeKeys.ok) return intelJson({ error: "INVALID_DEDUPE_KEYS" }, 400);

    if (ids.value.length + dedupeKeys.value.length === 0) {
      return intelJson(
        { error: "MISSING_IDENTIFIERS", required: ["ids", "dedupeKeys"], mode: "any_of" },
        400,
      );
    }
    if (
      ids.value.length + dedupeKeys.value.length >
      INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS
    ) {
      return intelJson(
        {
          error: "TOO_MANY_IDENTIFIERS",
          max: INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS,
          got: ids.value.length + dedupeKeys.value.length,
        },
        400,
      );
    }

    // Required, not defaulted. A tombstone outlives the incident that produced
    // it by up to 180 days, and "why is this key suppressed?" is unanswerable
    // from the row alone unless the caller was made to say so here.
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > INTEL_HISTORY_MAX_REASON_LEN) {
      return intelJson(
        {
          error: "MISSING_REASON",
          reason: `reason must be a non-empty string of at most ${INTEL_HISTORY_MAX_REASON_LEN} chars`,
        },
        400,
      );
    }

    try {
      const result = await ctx.runMutation(internal.intelHistory.retract, {
        ids: ids.value,
        dedupeKeys: dedupeKeys.value,
        reason,
      });
      return intelJson(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "intel history retract failed";
      return intelJson({ error: msg }, 500);
    }
  }),
});

http.route({
  path: "/relay/intel-history/restore",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (await intelRelayUnauthorized(request, { retraction: true })) {
      return intelJson({ error: "UNAUTHORIZED" }, 401);
    }

    const body = await parseJsonObjectBody<Record<string, unknown>>(request);
    if (!body) return intelJson({ error: "INVALID_JSON" }, 400);

    // Only dedupe keys: the document ids are gone with the rows they named, so
    // accepting one here would be an argument that can never resolve.
    const dedupeKeys = readIdentifierList(
      body.dedupeKeys,
      INTEL_HISTORY_MAX_DEDUPE_KEY_LEN,
    );
    if (!dedupeKeys.ok) return intelJson({ error: "INVALID_DEDUPE_KEYS" }, 400);
    if (dedupeKeys.value.length === 0) {
      return intelJson({ error: "MISSING_IDENTIFIERS", required: ["dedupeKeys"] }, 400);
    }
    if (dedupeKeys.value.length > INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS) {
      return intelJson(
        {
          error: "TOO_MANY_IDENTIFIERS",
          max: INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS,
          got: dedupeKeys.value.length,
        },
        400,
      );
    }

    try {
      const result = await ctx.runMutation(internal.intelHistory.restore, {
        dedupeKeys: dedupeKeys.value,
      });
      return intelJson(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "intel history restore failed";
      return intelJson({ error: msg }, 500);
    }
  }),
});

http.route({
  path: "/relay/intel-history/retractions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (await intelRelayUnauthorized(request, { retraction: true })) {
      return intelJson({ error: "UNAUTHORIZED" }, 401);
    }

    const body = await parseJsonObjectBody<Record<string, unknown>>(request);
    if (!body) return intelJson({ error: "INVALID_JSON" }, 400);

    const limit = readOptionalNumber(body.limit);
    if (!limit.ok) return intelJson({ error: "INVALID_LIMIT" }, 400);

    try {
      const result = await ctx.runQuery(internal.intelHistory.listRetractions, {
        limit: limit.value,
      });
      return intelJson(result, 200);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "intel history retractions read failed";
      return intelJson({ error: msg }, 500);
    }
  }),
});

http.route({
  path: "/api/internal-intel-timeline",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return intelJson({ error: "UNAUTHORIZED" }, 401);
    }

    const body = await parseJsonObjectBody<Record<string, unknown>>(request);
    if (!body) {
      return intelJson({ error: "INVALID_JSON" }, 400);
    }

    const parsed = readIntelQueryScope(body);
    if (!parsed.ok) {
      return intelJson({ error: parsed.error }, 400);
    }
    // An unscoped read has no index to serve it; the query throws on this too.
    if (parsed.scope.domain === undefined && parsed.scope.country === undefined) {
      return intelJson(
        { error: "MISSING_SCOPE", required: ["domain", "country"], mode: "any_of" },
        400,
      );
    }

    try {
      const result = await ctx.runQuery(internal.intelHistory.timeline, parsed.scope);
      return intelJson(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "intel history timeline failed";
      return intelJson({ error: msg }, 500);
    }
  }),
});

http.route({
  path: "/api/internal-intel-search",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return intelJson({ error: "UNAUTHORIZED" }, 401);
    }

    const body = await parseJsonObjectBody<Record<string, unknown>>(request);
    if (!body) {
      return intelJson({ error: "INVALID_JSON" }, 400);
    }
    if (!isValidEmbedding(body.embedding)) {
      return intelJson(
        { error: "INVALID_EMBEDDING", expectedDimensions: INTEL_HISTORY_EMBED_DIMS },
        400,
      );
    }

    const parsed = readIntelQueryScope(body);
    if (!parsed.ok) {
      return intelJson({ error: parsed.error }, 400);
    }
    const minScore = body.minScore;
    if (
      minScore !== undefined &&
      (typeof minScore !== "number" ||
        !Number.isFinite(minScore) ||
        minScore < -1 ||
        minScore > 1)
    ) {
      return intelJson({ error: "INVALID_MIN_SCORE" }, 400);
    }

    try {
      const result = await ctx.runAction(internal.intelHistory.search, {
        embedding: body.embedding,
        ...parsed.scope,
        ...(typeof minScore === "number" ? { minScore } : {}),
      });
      return intelJson(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "intel history search failed";
      return intelJson({ error: msg }, 500);
    }
  }),
});

export default http;
