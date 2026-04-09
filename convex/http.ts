import { anyApi, httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { webhookHandler } from "./payments/webhookHandlers";
import { resendWebhookHandler } from "./resendWebhookHandler";

const TRUSTED = [
  "https://worldmonitor.app",
  "*.worldmonitor.app",
  "http://localhost:3000",
];

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

const http = httpRouter();

http.route({
  path: "/api/internal-entitlements",
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

    let body: { userId?: unknown };
    try {
      body = await request.json() as { userId?: unknown };
    } catch {
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

    const result = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId: body.userId },
    );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
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

    let body: {
      variant?: string;
      data?: unknown;
      expectedSyncVersion?: number;
      schemaVersion?: number;
    };
    try {
      body = await request.json() as typeof body;
    } catch {
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
      const result = await ctx.runMutation(
        anyApi.userPreferences!.setPreferences as any,
        {
          variant: body.variant,
          data: body.data,
          expectedSyncVersion: body.expectedSyncVersion,
          schemaVersion: body.schemaVersion,
        },
      );
      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CONFLICT")) {
        return new Response(JSON.stringify({ error: "CONFLICT" }), {
          status: 409,
          headers,
        });
      }
      if (msg.includes("BLOB_TOO_LARGE")) {
        return new Response(JSON.stringify({ error: "BLOB_TOO_LARGE" }), {
          status: 400,
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
    // Always return 200 — non-200 triggers Telegram retry storm
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const provided =
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";

    // Drop only when a secret header IS provided but doesn't match (spoofing).
    // If the header is absent, Telegram's secret_token registration may have
    // silently failed — the pairing token (43-char, single-use, 15-min TTL)
    // provides sufficient defence against token guessing.
    if (provided && secret && !(await timingSafeEqualStrings(provided, secret))) {
      return new Response("OK", { status: 200 });
    }
    if (!provided) console.warn("[telegram-webhook] secret header absent — relying on pairing token auth");

    let update: {
      message?: {
        chat?: { type?: string; id?: number };
        text?: string;
        date?: number;
      };
    };
    try {
      update = await request.json() as typeof update;
    } catch {
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

    let body: { userId?: string; channelType?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      typeof body.userId !== "string" || !body.userId ||
      (body.channelType !== "telegram" && body.channelType !== "slack" && body.channelType !== "email" && body.channelType !== "discord")
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

    let body: { userId?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
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

    let body: {
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
      quietHoursEnabled?: boolean;
      quietHoursStart?: number;
      quietHoursEnd?: number;
      quietHoursTimezone?: string;
      quietHoursOverride?: string;
      digestMode?: string;
      digestHour?: number;
      digestTimezone?: string;
      aiDigestEnabled?: boolean;
    };
    try {
      body = await request.json() as typeof body;
    } catch {
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
        });
        return new Response(JSON.stringify({ ok: true, isNew: setResult.isNew }), { status: 200, headers: { "Content-Type": "application/json" } });
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
          (body.sensitivity !== undefined && !VALID_SENSITIVITY.has(body.sensitivity as string))
        ) {
          return new Response(JSON.stringify({ error: "MISSING_REQUIRED_FIELDS" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await ctx.runMutation((internal as any).alertRules.setAlertRulesForUser, {
          userId,
          variant: body.variant,
          enabled: body.enabled,
          eventTypes: body.eventTypes as string[],
          sensitivity: (body.sensitivity ?? "all") as "all" | "high" | "critical",
          channels: body.channels as Array<"telegram" | "slack" | "email">,
          aiDigestEnabled: typeof body.aiDigestEnabled === "boolean" ? body.aiDigestEnabled : undefined,
        });
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
        });
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
    let body: { userId?: string; variant?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: "INVALID_BODY" }), {
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

    let body: {
      userId?: string;
      email?: string;
      name?: string;
      productId?: string;
      returnUrl?: string;
      discountCode?: string;
      referralCode?: string;
    };
    try {
      body = await request.json() as typeof body;
    } catch {
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
        },
      );
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

    let body: {
      emails: Array<{
        email: string;
        reason: "bounce" | "complaint" | "manual";
        source?: string;
      }>;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
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
