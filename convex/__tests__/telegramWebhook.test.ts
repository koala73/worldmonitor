import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

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
});
