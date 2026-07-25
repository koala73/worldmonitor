import { anyApi, httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { webhookHandler } from "./payments/webhookHandlers";
import { resendWebhookHandler } from "./resendWebhookHandler";
import { USER_PREFS_WRITE_RATE_LIMIT } from "./constants";

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

    if (result) {
      try {
        await ctx.scheduler.runAfter(0, (internal as any).apiKeys.touchKeyLastUsed, { keyId: result.id });
      } catch (err) {
        // sentry-coverage-ok: re-throwing here would 500 the gateway, which coerces to null
        // and stamps a 60s negative-cache sentinel for a valid key. lastUsedAt is best-effort telemetry.
        console.warn("[validate-api-key] touchKeyLastUsed schedule failed:", err instanceof Error ? err.message : String(err));
      }
    }

    return new Response(JSON.stringify(result), {
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

      if (result) {
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

      return new Response(JSON.stringify(result), {
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
          bypassPendingGuard: body.bypassPendingGuard,
        },
      );
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

export default http;
