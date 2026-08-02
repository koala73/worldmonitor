import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { channelTypeValidator } from "./constants";

// Versioned queue: old Railway relays only poll wm:events:queue and ignore
// welcomeId. Keeping connection-scoped events on a new queue means they wait
// safely until the backward-compatible consumer deploys, regardless of
// Convex/Railway deployment order.
const WELCOME_QUEUE_KEY = "wm:events:queue:welcome-v2";
const WELCOME_FETCH_TIMEOUT_MS = 5_000;
const WELCOME_USER_AGENT = "worldmonitor-convex/1.0";
const WELCOME_DEDUP_TTL_SECONDS = 24 * 60 * 60;
const WELCOME_RETRY_DELAYS_MS = [
  10_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;
const ENQUEUE_WELCOME_SCRIPT = [
  "local queue_type = redis.call('TYPE', KEYS[2]).ok",
  "if queue_type ~= 'none' and queue_type ~= 'list' then",
  "  return -1",
  "end",
  "local claimed = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[2])",
  "if claimed then",
  "  local pushed = redis.pcall('LPUSH', KEYS[2], ARGV[1])",
  "  if type(pushed) == 'table' and pushed.err then",
  "    redis.call('DEL', KEYS[1])",
  "    return -2",
  "  end",
  "  return pushed",
  "end",
  "return 0",
].join("\n");

/**
 * Notifications are a PRO feature. Enforce the entitlement at the public
 * Convex write boundary so callers cannot bypass the edge API gate.
 */
async function hasProEntitlement(
  ctx: MutationCtx,
  userId: string,
): Promise<boolean> {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  const tier =
    entitlement && entitlement.validUntil >= Date.now()
      ? entitlement.features.tier
      : 0;
  return tier >= 1;
}

async function assertProEntitlement(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  if (!(await hasProEntitlement(ctx, userId))) {
    throw new ConvexError({
      code: "PRO_REQUIRED",
      message:
        "Notifications are a PRO feature. Upgrade to enable real-time and digest alerts.",
    });
  }
}

/**
 * Queue a first-connect welcome outside the relay HTTP request lifecycle.
 *
 * The mutation that creates the channel schedules this action in the same
 * Convex transaction as the channel insert. A Vercel-to-Convex timeout can
 * therefore hide the mutation response without losing the welcome event.
 */
export const queueChannelWelcome = internalAction({
  args: {
    userId: v.string(),
    channelType: channelTypeValidator,
    welcomeId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const retryDelay = WELCOME_RETRY_DELAYS_MS[attempt];
    // Schedule the successor before the external side effect. If this action
    // crashes or the Upstash response is ambiguous, the durable successor
    // retries. Atomic Redis dedupe makes that retry safe after a committed
    // LPUSH whose response was lost.
    const retryId = retryDelay === undefined
      ? null
      : await ctx.scheduler.runAfter(
          retryDelay,
          (internal as any).notificationChannels.queueChannelWelcome,
          {
            userId: args.userId,
            channelType: args.channelType,
            welcomeId: args.welcomeId,
            attempt: attempt + 1,
          },
        );
    const message = JSON.stringify({
      eventType: "channel_welcome",
      userId: args.userId,
      channelType: args.channelType,
      welcomeId: args.welcomeId,
    });
    try {
      const channels = await ctx.runQuery(
        (internal as any).notificationChannels.getChannelsByUserId,
        { userId: args.userId },
      );
      const currentChannel = channels.find(
        (channel: { _id: unknown; channelType: string }) =>
          channel.channelType === args.channelType,
      );
      if (String(currentChannel?._id ?? "") !== args.welcomeId) {
        if (retryId) await ctx.scheduler.cancel(retryId);
        return { queued: false, stale: true };
      }
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) {
        throw new Error("queueChannelWelcome: Upstash credentials missing");
      }
      // The inserted channel document ID identifies this connection. A later
      // delete/reconnect receives a new ID and a new welcome, while retries
      // from this connection share one claim.
      const dedupKey = `wm:channel-welcome:${args.welcomeId}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": WELCOME_USER_AGENT,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          "EVAL",
          ENQUEUE_WELCOME_SCRIPT,
          2,
          dedupKey,
          WELCOME_QUEUE_KEY,
          message,
          WELCOME_DEDUP_TTL_SECONDS,
        ]),
        signal: AbortSignal.timeout(WELCOME_FETCH_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null) as {
        result?: unknown;
        error?: string;
      } | null;
      if (
        !response.ok ||
        payload?.error ||
        typeof payload?.result !== "number" ||
        payload.result < 0
      ) {
        throw new Error(
          `queueChannelWelcome: atomic enqueue failed with HTTP ${response.status}`,
        );
      }
      if (retryId) await ctx.scheduler.cancel(retryId);
      return {
        queued: payload.result > 0,
        duplicate: payload.result === 0,
      };
    } catch (error) {
      if (!retryId) throw error;
      console.warn(
        `[notificationChannels] queueChannelWelcome attempt ${attempt + 1} failed; retry scheduled`,
        error instanceof Error ? error.message : String(error),
      );
      return { queued: false, retryScheduled: true };
    }
  },
});

export const getChannelsByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("notificationChannels")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const setChannelForUser = internalMutation({
  args: {
    userId: v.string(),
    channelType: channelTypeValidator,
    chatId: v.optional(v.string()),
    webhookEnvelope: v.optional(v.string()),
    email: v.optional(v.string()),
    webhookLabel: v.optional(v.string()),
    scheduleWelcome: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId, channelType, chatId, webhookEnvelope, email, webhookLabel } = args;
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", channelType),
      )
      .unique();
    const isNew = !existing;
    let channelId = existing ? String(existing._id) : "";
    const now = Date.now();
    if (channelType === "telegram") {
      if (!chatId) throw new ConvexError("chatId required for telegram channel");
      const doc = { userId, channelType: "telegram" as const, chatId, verified: true, linkedAt: now };
      if (existing) { await ctx.db.replace(existing._id, doc); } else { channelId = String(await ctx.db.insert("notificationChannels", doc)); }
    } else if (channelType === "slack") {
      if (!webhookEnvelope) throw new ConvexError("webhookEnvelope required for slack channel");
      const doc = { userId, channelType: "slack" as const, webhookEnvelope, verified: true, linkedAt: now };
      if (existing) { await ctx.db.replace(existing._id, doc); } else { channelId = String(await ctx.db.insert("notificationChannels", doc)); }
    } else if (channelType === "email") {
      if (!email) throw new ConvexError("email required for email channel");
      const doc = { userId, channelType: "email" as const, email, verified: true, linkedAt: now };
      if (existing) { await ctx.db.replace(existing._id, doc); } else { channelId = String(await ctx.db.insert("notificationChannels", doc)); }
    } else if (channelType === "webhook") {
      if (!webhookEnvelope) throw new ConvexError("webhookEnvelope required for webhook channel");
      const doc = { userId, channelType: "webhook" as const, webhookEnvelope, verified: true, linkedAt: now, webhookLabel };
      if (existing) { await ctx.db.replace(existing._id, doc); } else { channelId = String(await ctx.db.insert("notificationChannels", doc)); }
    } else {
      throw new ConvexError("discord channel must be set via set-discord-oauth");
    }
    if (isNew && args.scheduleWelcome === true) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).notificationChannels.queueChannelWelcome,
        { userId, channelType, welcomeId: channelId, attempt: 0 },
      );
    }
    return { isNew };
  },
});

// Web Push (Phase 6). Stored as its own internal mutation because the
// payload shape is incompatible with setChannelForUser (three required
// identity fields, no chatId/webhookEnvelope/email). Replaces any
// prior subscription for this user — one subscription per user until
// per-device fan-out is needed.
//
// Cross-account dedupe: the browser's PushSubscription is bound to
// the origin, NOT to the Clerk session. If user A subscribes on
// device X, signs out, then user B signs in on the same device X
// and subscribes, the browser hands out the SAME endpoint. Without
// this dedupe, both users' rows carry the same endpoint — meaning
// every alert the relay fans out to user A would also deliver to
// user B on that shared device, and vice versa. That's a cross-
// account privacy leak.
//
// Fix: before writing the new row, delete any existing rows
// anywhere in the table that match this endpoint. Effectively
// transfers ownership of the subscription to the current caller.
// The previous user will need to re-subscribe on that device if
// they sign in again.
export const setWebPushChannelForUser = internalMutation({
  args: {
    userId: v.string(),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    scheduleWelcome: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Step 1: find the current user's row before cross-account endpoint
    // cleanup. A retry with the same endpoint must remain a re-link rather
    // than deleting its own row and appearing to be a first connection.
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", "web_push"),
      )
      .unique();

    // Step 2: scan for rows with this endpoint across other users and delete
    // them. notificationChannels has no
    // endpoint-based index, so we filter at read time — acceptable
    // at current scale (<10k rows) and well-bounded to a single
    // write-path per user per connect.
    const allWebPush = await ctx.db
      .query("notificationChannels")
      .collect();
    for (const row of allWebPush) {
      if (
        row.channelType === "web_push" &&
        // Narrow through the channel-type literal so TS knows
        // `endpoint` exists on this row.
        row.endpoint === args.endpoint &&
        row.userId !== args.userId
      ) {
        await ctx.db.delete(row._id);
      }
    }

    // Step 3: upsert the current-user row by (userId, channelType).
    const isNew = !existing;
    const doc = {
      userId: args.userId,
      channelType: "web_push" as const,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      verified: true,
      linkedAt: Date.now(),
      userAgent: args.userAgent,
    };
    let channelId: string;
    if (existing) {
      await ctx.db.replace(existing._id, doc);
      channelId = String(existing._id);
    } else {
      channelId = String(await ctx.db.insert("notificationChannels", doc));
    }
    if (isNew && args.scheduleWelcome === true) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).notificationChannels.queueChannelWelcome,
        {
          userId: args.userId,
          channelType: "web_push",
          welcomeId: channelId,
          attempt: 0,
        },
      );
    }
    return { isNew };
  },
});

export const setSlackOAuthChannelForUser = internalMutation({
  args: {
    userId: v.string(),
    webhookEnvelope: v.string(),
    slackChannelName: v.optional(v.string()),
    slackTeamName: v.optional(v.string()),
    slackConfigurationUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", "slack"),
      )
      .unique();
    const isNew = !existing;
    const doc = {
      userId: args.userId,
      channelType: "slack" as const,
      webhookEnvelope: args.webhookEnvelope,
      verified: true,
      linkedAt: Date.now(),
      slackChannelName: args.slackChannelName,
      slackTeamName: args.slackTeamName,
      slackConfigurationUrl: args.slackConfigurationUrl,
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert("notificationChannels", doc);
    }
    return { isNew };
  },
});

export const setDiscordOAuthChannelForUser = internalMutation({
  args: {
    userId: v.string(),
    webhookEnvelope: v.string(),
    discordGuildId: v.optional(v.string()),
    discordChannelId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", "discord"),
      )
      .unique();
    const isNew = !existing;
    const doc = {
      userId: args.userId,
      channelType: "discord" as const,
      webhookEnvelope: args.webhookEnvelope,
      verified: true,
      linkedAt: Date.now(),
      discordGuildId: args.discordGuildId,
      discordChannelId: args.discordChannelId,
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert("notificationChannels", doc);
    }
    return { isNew };
  },
});

export const deleteChannelForUser = internalMutation({
  args: { userId: v.string(), channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", args.channelType),
      )
      .unique();
    if (!existing) return;
    await ctx.db.delete(existing._id);
    const rules = await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const rule of rules) {
      const filtered = rule.channels.filter((c) => c !== args.channelType);
      if (filtered.length !== rule.channels.length) {
        await ctx.db.patch(rule._id, { channels: filtered });
      }
    }
  },
});

export const createPairingTokenForUser = internalMutation({
  args: { userId: v.string(), variant: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, variant } = args;
    const existing = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const t of existing) {
      if (!t.used) await ctx.db.patch(t._id, { used: true });
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    await ctx.db.insert("telegramPairingTokens", { userId, token, expiresAt, used: false, variant });
    return { token, expiresAt };
  },
});

export const getChannels = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("notificationChannels")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
  },
});

export const setChannel = mutation({
  args: {
    channelType: channelTypeValidator,
    chatId: v.optional(v.string()),
    webhookEnvelope: v.optional(v.string()),
    email: v.optional(v.string()),
    webhookLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    await assertProEntitlement(ctx, userId);

    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", args.channelType),
      )
      .unique();

    const now = Date.now();

    if (args.channelType === "telegram") {
      if (!args.chatId) throw new ConvexError("chatId required for telegram channel");
      const doc = { userId, channelType: "telegram" as const, chatId: args.chatId, verified: true, linkedAt: now };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("notificationChannels", doc);
      }
    } else if (args.channelType === "slack") {
      if (!args.webhookEnvelope) throw new ConvexError("webhookEnvelope required for slack channel");
      const doc = { userId, channelType: "slack" as const, webhookEnvelope: args.webhookEnvelope, verified: true, linkedAt: now };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("notificationChannels", doc);
      }
    } else if (args.channelType === "email") {
      if (!args.email) throw new ConvexError("email required for email channel");
      const doc = { userId, channelType: "email" as const, email: args.email, verified: true, linkedAt: now };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("notificationChannels", doc);
      }
    } else if (args.channelType === "webhook") {
      if (!args.webhookEnvelope) throw new ConvexError("webhookEnvelope required for webhook channel");
      const doc = { userId, channelType: "webhook" as const, webhookEnvelope: args.webhookEnvelope, verified: true, linkedAt: now, webhookLabel: args.webhookLabel };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("notificationChannels", doc);
      }
    } else {
      throw new ConvexError("discord channel must be set via set-discord-oauth");
    }
  },
});

export const deleteChannel = mutation({
  args: { channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    await assertProEntitlement(ctx, userId);

    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", args.channelType),
      )
      .unique();

    if (!existing) return;
    await ctx.db.delete(existing._id);

    // Remove this channel from all alert rules for this user
    const rules = await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const rule of rules) {
      const filtered = rule.channels.filter((c) => c !== args.channelType);
      if (filtered.length !== rule.channels.length) {
        await ctx.db.patch(rule._id, { channels: filtered });
      }
    }
  },
});

// Called by the notification relay via /relay/deactivate HTTP action
// when Telegram returns 403 or Slack returns 404/410.
export const deactivateChannelForUser = internalMutation({
  args: { userId: v.string(), channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", args.channelType),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { verified: false });
    }
  },
});

export const deactivateChannel = mutation({
  args: { channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    await assertProEntitlement(ctx, userId);

    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", args.channelType),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { verified: false });
    }
  },
});

export const createPairingToken = mutation({
  args: { variant: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    await assertProEntitlement(ctx, userId);

    // Invalidate any existing unused tokens for this user
    const existing = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const t of existing) {
      if (!t.used) await ctx.db.patch(t._id, { used: true });
    }

    // Generate a base64url token (43 chars from 32 random bytes)
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const expiresAt = Date.now() + 15 * 60 * 1000;

    await ctx.db.insert("telegramPairingTokens", {
      userId,
      token,
      expiresAt,
      used: false,
      variant: args.variant,
    });

    return { token, expiresAt };
  },
});

export const claimPairingToken = mutation({
  args: { token: v.string(), chatId: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (!record) return { ok: false, reason: "NOT_FOUND" as const };
    if (record.used) return { ok: false, reason: "ALREADY_USED" as const };
    if (record.expiresAt < Date.now()) return { ok: false, reason: "EXPIRED" as const };
    if (!(await hasProEntitlement(ctx, record.userId))) {
      return { ok: false, reason: "PRO_REQUIRED" as const };
    }

    // Mark token used
    await ctx.db.patch(record._id, { used: true });

    // Upsert telegram channel for this user
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", record.userId).eq("channelType", "telegram"),
      )
      .unique();

    const doc = {
      userId: record.userId,
      channelType: "telegram" as const,
      chatId: args.chatId,
      verified: true,
      linkedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert("notificationChannels", doc);
    }

    // On first-time pairing only, add 'telegram' to the alert rule so alerts
    // are delivered immediately without requiring a manual rule edit.
    // Skip on re-pair (existing channel) to preserve any intentional per-rule
    // customization the user may have made (e.g. removed Telegram from a variant).
    // If the token carries a variant, scope the update to that variant's rule only.
    // Fall back to all rules when variant is absent (backward compat for old tokens).
    if (!existing) {
      const rules = await (record.variant
        ? ctx.db
            .query("alertRules")
            .withIndex("by_user_variant", (q) =>
              q.eq("userId", record.userId).eq("variant", record.variant as string),
            )
            .collect()
        : ctx.db
            .query("alertRules")
            .withIndex("by_user", (q) => q.eq("userId", record.userId))
            .collect());
      for (const rule of rules) {
        if (!rule.channels.includes("telegram")) {
          await ctx.db.patch(rule._id, { channels: [...rule.channels, "telegram"] });
        }
      }
    }

    return { ok: true, reason: null };
  },
});
