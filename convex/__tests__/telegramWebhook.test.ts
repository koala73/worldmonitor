import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { claimPairingToken } from "../notificationChannels";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Regression tests for koala73/worldmonitor#3767
//
// The /api/telegram-pair-callback webhook MUST fail closed: requests are
// rejected unless they carry the `X-Telegram-Bot-Api-Secret-Token` header
// matching `TELEGRAM_WEBHOOK_SECRET`. The handler always returns HTTP 200
// (Telegram retries on non-200), so "rejected" is observed by asserting that
// the downstream `claimPairingToken` mutation never runs — i.e. a seeded
// pairing token's `used` flag stays false.
// ---------------------------------------------------------------------------

const VALID_SECRET = "test-telegram-secret";
const USER_ID = "user-telegram-test";
const PAIRING_TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 chars, matches /^[A-Za-z0-9_-]{40,50}$/

async function seedPairingToken(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId: USER_ID,
      planKey: "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: true,
        apiRateLimit: 1000,
        prioritySupport: true,
        exportFormats: ["json", "csv"],
      },
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("telegramPairingTokens", {
      userId: USER_ID,
      token: PAIRING_TOKEN,
      expiresAt: Date.now() + 15 * 60 * 1000, // 15 min
      used: false,
    });
  });
}

async function tokenUsed(t: ReturnType<typeof convexTest>): Promise<boolean> {
  return await t.run(async (ctx) => {
    const rec = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_token", (q) => q.eq("token", PAIRING_TOKEN))
      .unique();
    return rec?.used === true;
  });
}

function makeStartPayload() {
  return {
    message: {
      chat: { type: "private", id: 12345 },
      text: `/start ${PAIRING_TOKEN}`,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

describe("HTTP route /api/telegram-pair-callback (security #3767)", () => {
  beforeEach(() => {
    // Stub outbound Telegram sendMessage so the happy-path doesn't make a
    // real network call when the guard passes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  test("rejects request with NO secret header (handler not invoked)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
    const t = convexTest(schema, modules);
    await seedPairingToken(t);

    const res = await t.fetch("/api/telegram-pair-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeStartPayload()),
    });

    expect(res.status).toBe(200); // always 200 to suppress Telegram retries
    expect(await tokenUsed(t)).toBe(false); // but handler did NOT run
  });

  test("rejects request with WRONG secret header (handler not invoked)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
    const t = convexTest(schema, modules);
    await seedPairingToken(t);

    const res = await t.fetch("/api/telegram-pair-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
      },
      body: JSON.stringify(makeStartPayload()),
    });

    expect(res.status).toBe(200);
    expect(await tokenUsed(t)).toBe(false);
  });

  test("rejects ALL requests when TELEGRAM_WEBHOOK_SECRET is unset", async () => {
    // No env var set — even a request with a "matching" header (which the
    // pre-fix code would have skipped the check on) must be rejected.
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    await seedPairingToken(t);

    const resNoHeader = await t.fetch("/api/telegram-pair-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeStartPayload()),
    });
    expect(resNoHeader.status).toBe(200);
    expect(await tokenUsed(t)).toBe(false);

    const resWithHeader = await t.fetch("/api/telegram-pair-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "anything",
      },
      body: JSON.stringify(makeStartPayload()),
    });
    expect(resWithHeader.status).toBe(200);
    expect(await tokenUsed(t)).toBe(false);
  });

  test("happy path: matching secret header → handler runs, pairing token consumed", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
    const t = convexTest(schema, modules);
    await seedPairingToken(t);

    const res = await t.fetch("/api/telegram-pair-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": VALID_SECRET,
      },
      body: JSON.stringify(makeStartPayload()),
    });

    expect(res.status).toBe(200);
    expect(await tokenUsed(t)).toBe(true); // handler ran and claimed the token
    const channels = await t.run((ctx) => ctx.db.query("notificationChannels").collect());
    expect(channels).toMatchObject([{ userId: USER_ID, chatId: "12345", verified: true, telegramOwnership: "verified_callback" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({ chat_id: "12345" });
  });

  test.each([null, [], "not-an-object", 42, true])(
    "matching secret with non-object JSON (%j) → 200 without consuming token",
    async (payload) => {
      process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
      const t = convexTest(schema, modules);
      await seedPairingToken(t);

      const res = await t.fetch("/api/telegram-pair-callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": VALID_SECRET,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      expect(await tokenUsed(t)).toBe(false);
    },
  );

  test.each([undefined, null, "54321", 0, -12345, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid private chat ID %j without state changes or delivery",
    async (id) => {
      process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
      const t = convexTest(schema, modules);
      await seedPairingToken(t);
      const payload = makeStartPayload();
      const res = await t.fetch("/api/telegram-pair-callback", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": VALID_SECRET },
        body: JSON.stringify({ message: { ...payload.message, chat: { type: "private", id } } }),
      });
      expect(res.status).toBe(200);
      expect(await tokenUsed(t)).toBe(false);
      expect(await t.run((ctx) => ctx.db.query("notificationChannels").collect())).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each(["expired", "used", "unknown", "group", "stale", "invalid text"])(
    "rejects %s pairing without delivery",
    async (failure) => {
      process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
      const t = convexTest(schema, modules);
      await seedPairingToken(t);
      const payload = makeStartPayload();
      if (failure === "group") payload.message.chat.type = "group";
      if (failure === "stale") payload.message.date -= 901;
      if (failure === "invalid text") payload.message.text = "/start invalid";
      if (failure === "unknown") payload.message.text = `/start ${"X".repeat(43)}`;
      if (failure === "expired" || failure === "used") {
        await t.run(async (ctx) => {
          const token = await ctx.db.query("telegramPairingTokens").unique();
          await ctx.db.patch(token!._id, failure === "used" ? { used: true } : { expiresAt: Date.now() - 1 });
        });
      }
      await t.fetch("/api/telegram-pair-callback", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": VALID_SECRET },
        body: JSON.stringify(payload),
      });
      expect(await tokenUsed(t)).toBe(failure === "used");
      expect(await t.run((ctx) => ctx.db.query("notificationChannels").collect())).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each([{ text: 42 }, { date: "123" }, { date: null }])(
    "rejects malformed message fields %j without delivery",
    async (fields) => {
      process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
      const t = convexTest(schema, modules);
      await seedPairingToken(t);
      const res = await t.fetch("/api/telegram-pair-callback", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": VALID_SECRET },
        body: JSON.stringify({ message: { ...makeStartPayload().message, ...fields } }),
      });
      expect(res.status).toBe(200);
      expect(await tokenUsed(t)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test("an owned token cannot authorize a forged callback; trusted redemption binds only its owner and update chat", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
    const t = convexTest(schema, modules);
    await seedPairingToken(t);
    const owner = t.withIdentity({ subject: USER_ID });
    const pairing = await owner.mutation(api.notificationChannels.createPairingToken, {});
    const payload = { ...makeStartPayload(), userId: "another-user", chatId: "98765" };
    payload.message.text = `/start ${pairing.token}`;
    for (const secret of ["wrong-secret", VALID_SECRET, VALID_SECRET]) {
      await t.fetch("/api/telegram-pair-callback", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(payload),
      });
      if (secret === "wrong-secret") {
        expect(await owner.query(api.notificationChannels.getChannels, {})).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      }
    }
    const channels = await t.run((ctx) => ctx.db.query("notificationChannels").collect());
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ userId: USER_ID, chatId: "12345", verified: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("token redemption is internal, so a caller cannot submit its own token with a chosen chat", () => {
    // convex-test permits internal calls. Check the real registration boundary
    // as well as the callback behavior, as in alertRules-visibility.test.ts.
    const registered = claimPairingToken as unknown as { isInternal?: boolean; isPublic?: boolean };
    expect(registered.isInternal).toBe(true);
    expect(registered.isPublic).toBeUndefined();
  });

  test("legacy verification is hidden from both account and delivery reads until the owner pairs again", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = VALID_SECRET;
    const t = convexTest(schema, modules);
    await seedPairingToken(t);
    const owner = t.withIdentity({ subject: USER_ID });
    await t.run((ctx) => ctx.db.insert("notificationChannels", {
      userId: USER_ID, channelType: "telegram", chatId: "98765", verified: true, linkedAt: Date.now(),
    }));
    expect(await owner.query(api.notificationChannels.getChannels, {})).toMatchObject([{ verified: false }]);
    expect(await t.query(internal.notificationChannels.getChannelsByUserId, { userId: USER_ID })).toMatchObject([{ verified: false }]);
    await t.fetch("/api/telegram-pair-callback", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": VALID_SECRET },
      body: JSON.stringify(makeStartPayload()),
    });
    expect(await owner.query(api.notificationChannels.getChannels, {})).toMatchObject([{ chatId: "12345", verified: true }]);
    expect(await t.query(internal.notificationChannels.getChannelsByUserId, { userId: USER_ID })).toMatchObject([{ chatId: "12345", verified: true }]);
    await t.mutation(internal.notificationChannels.deactivateChannelForUser, {
      userId: USER_ID,
      channelType: "telegram",
    });
    expect(await t.query(internal.notificationChannels.getChannelsByUserId, { userId: USER_ID })).toMatchObject([{ verified: false }]);
  });

  test.each(["public", "server bridge"])("%s setter cannot enroll or replace an arbitrary Telegram chat", async (surface) => {
    const t = convexTest(schema, modules);
    await seedPairingToken(t);
    const owner = t.withIdentity({ subject: USER_ID });
    const attempt = () => surface === "public"
      ? owner.mutation(api.notificationChannels.setChannel, { channelType: "telegram", chatId: "98765" })
      : t.mutation(internal.notificationChannels.setChannelForUser, {
        userId: USER_ID, channelType: "telegram", chatId: "98765", scheduleWelcome: true,
      });
    await expect(attempt()).rejects.toThrow(/telegram.*pair/i);
    expect(await owner.query(api.notificationChannels.getChannels, {})).toEqual([]);
    await t.run((ctx) => ctx.db.insert("notificationChannels", {
      userId: USER_ID, channelType: "telegram", chatId: "12345", verified: true, linkedAt: Date.now(),
    }));
    await expect(attempt()).rejects.toThrow(/telegram.*pair/i);
    const stored = await t.run((ctx) => ctx.db.query("notificationChannels").collect());
    expect(stored).toMatchObject([{ chatId: "12345", verified: true }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
