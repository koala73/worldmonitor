import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
type TestUser = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
const notificationChannelFns = (internal as any).notificationChannels;
const originalFetch = globalThis.fetch;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

const USER = {
  subject: "user-tests-notification-channels",
  tokenIdentifier: "clerk|user-tests-notification-channels",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
  if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function seedEntitlement(
  t: ReturnType<typeof convexTest>,
  tier = 1,
  validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000,
) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", USER.subject))
      .unique();
    const entitlement = {
      userId: USER.subject,
      planKey: tier >= 1 ? "pro_monthly" : "free",
      features: {
        tier,
        maxDashboards: 10,
        apiAccess: true,
        apiRateLimit: 1000,
        prioritySupport: true,
        exportFormats: ["json", "csv"],
      },
      validUntil,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.replace(existing._id, entitlement);
    } else {
      await ctx.db.insert("entitlements", entitlement);
    }
  });
}

describe("notificationChannels — Convex entitlement gate", () => {
  const guardedMutations: Array<[string, (asUser: TestUser) => Promise<unknown>]> = [
    ["setChannel", (asUser: TestUser) =>
      asUser.mutation(api.notificationChannels.setChannel, {
        channelType: "email",
        email: "free-user@example.com",
      })],
    ["deleteChannel", (asUser: TestUser) =>
      asUser.mutation(api.notificationChannels.deleteChannel, {
        channelType: "email",
      })],
    ["deactivateChannel", (asUser: TestUser) =>
      asUser.mutation(api.notificationChannels.deactivateChannel, {
        channelType: "email",
      })],
    ["createPairingToken", (asUser: TestUser) =>
      asUser.mutation(api.notificationChannels.createPairingToken, {
        variant: "full",
      })],
  ];

  describe.each([
    ["missing", async (_t: ReturnType<typeof convexTest>) => {
      // Intentionally leave the entitlement table empty.
    }],
    ["expired", (t: ReturnType<typeof convexTest>) =>
      seedEntitlement(t, 1, Date.now() - 1_000)],
    ["tier-0", (t: ReturnType<typeof convexTest>) => seedEntitlement(t, 0)],
  ])("%s entitlement", (_entitlementState, arrangeEntitlement) => {
    test.each(guardedMutations)(
      "%s rejects an authenticated non-Pro caller",
      async (_name, invoke) => {
        const t = convexTest(schema, modules);
        await arrangeEntitlement(t);
        const asUser = t.withIdentity(USER);

        await expect(invoke(asUser)).rejects.toThrow(
          /PRO_REQUIRED|Notifications are a PRO feature/i,
        );
      },
    );
  });

  test("claimPairingToken rejects a token whose owner is no longer Pro", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t);
    const asProUser = t.withIdentity(USER);
    const pairing = await asProUser.mutation(
      api.notificationChannels.createPairingToken,
      { variant: "full" },
    );
    await seedEntitlement(t, 1, Date.now() - 1_000);

    await expect(
      t.mutation(api.notificationChannels.claimPairingToken, {
        token: pairing.token,
        chatId: "12345",
      }),
    ).resolves.toEqual({ ok: false, reason: "PRO_REQUIRED" });

    const state = await t.run(async (ctx) => ({
      token: await ctx.db
        .query("telegramPairingTokens")
        .withIndex("by_token", (q) => q.eq("token", pairing.token))
        .unique(),
      channels: await ctx.db
        .query("notificationChannels")
        .withIndex("by_user", (q) => q.eq("userId", USER.subject))
        .collect(),
    }));
    expect(state.token?.used).toBe(false);
    expect(state.channels).toEqual([]);
  });

  test("PRO callers retain access to every entitlement-gated public mutation", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t);
    const asProUser = t.withIdentity(USER);

    await asProUser.mutation(api.notificationChannels.setChannel, {
      channelType: "email",
      email: "pro-user@example.com",
    });
    await asProUser.mutation(api.notificationChannels.deactivateChannel, {
      channelType: "email",
    });
    await asProUser.mutation(api.notificationChannels.deleteChannel, {
      channelType: "email",
    });
    const pairing = await asProUser.mutation(
      api.notificationChannels.createPairingToken,
      { variant: "full" },
    );
    const claimed = await t.mutation(
      api.notificationChannels.claimPairingToken,
      { token: pairing.token, chatId: "12345" },
    );

    const channels = await asProUser.query(
      api.notificationChannels.getChannels,
      {},
    );
    expect(pairing.token).toHaveLength(43);
    expect(claimed).toEqual({ ok: true, reason: null });
    expect(channels).toMatchObject([
      { channelType: "telegram", chatId: "12345", verified: true },
    ]);
  });
});

describe("notificationChannels — durable first-connect welcome", () => {
  function installQueueMock() {
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ result: 1 }),
    );
  }

  function queuedEvent(fetchMock: ReturnType<typeof installQueueMock>) {
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = String(input);
    const encodedMessage = url.slice(url.lastIndexOf("/") + 1);
    return {
      url,
      init,
      message: JSON.parse(decodeURIComponent(encodedMessage)),
    };
  }

  test("schedules an email welcome with the channel insert and not on retry", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    const t = convexTest(schema, modules);

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "first-connect@example.com",
    })).resolves.toEqual({ isNew: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedEvent(fetchMock)).toMatchObject({
      url: expect.stringContaining("/lpush/wm:events:queue/"),
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer upstash-token",
          "User-Agent": "worldmonitor-convex/1.0",
        },
      },
      message: {
        eventType: "channel_welcome",
        userId: USER.subject,
        channelType: "email",
      },
    });

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "first-connect@example.com",
    })).resolves.toEqual({ isNew: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not turn a same-endpoint web-push retry into a new connection", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    const t = convexTest(schema, modules);
    const args = {
      userId: USER.subject,
      endpoint: "https://fcm.googleapis.com/push/subscription-1",
      p256dh: "p256dh",
      auth: "auth",
      userAgent: "Chrome",
    };

    await expect(t.mutation(
      notificationChannelFns.setWebPushChannelForUser,
      args,
    )).resolves.toEqual({ isNew: true });
    await expect(t.mutation(
      notificationChannelFns.setWebPushChannelForUser,
      args,
    )).resolves.toEqual({ isNew: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedEvent(fetchMock).message).toEqual({
      eventType: "channel_welcome",
      userId: USER.subject,
      channelType: "web_push",
    });
  });
});
