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
const originalRelaySecret = process.env.RELAY_SHARED_SECRET;

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
  if (originalRelaySecret === undefined) delete process.env.RELAY_SHARED_SECRET;
  else process.env.RELAY_SHARED_SECRET = originalRelaySecret;
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
    // Mint a fresh Response per call: a shared instance's body can only be
    // consumed once, so a second successful enqueue in the same test would
    // read an already-consumed body and spawn a spurious retry chain.
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => Response.json({ result: 1 }),
    );
  }

  function queuedEvent(fetchMock: ReturnType<typeof installQueueMock>) {
    const [input, init] = fetchMock.mock.calls[0]!;
    const command = JSON.parse(String(init?.body)) as unknown[];
    return {
      url: String(input),
      init,
      command,
      message: JSON.parse(String(command[5])),
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
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedEvent(fetchMock)).toMatchObject({
      url: "https://upstash.test",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer upstash-token",
          "User-Agent": "worldmonitor-convex/1.0",
          "Content-Type": "application/json",
        },
      },
      command: [
        "EVAL",
        expect.stringMatching(/redis\.call\('TYPE'[\s\S]*redis\.pcall\('LPUSH'[\s\S]*redis\.call\('DEL'/),
        2,
        expect.stringMatching(/^wm:channel-welcome:/),
        "wm:events:queue:welcome-v2",
        expect.any(String),
        86400,
      ],
      message: {
        eventType: "channel_welcome",
        userId: USER.subject,
        channelType: "email",
        welcomeId: expect.any(String),
      },
    });

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "first-connect@example.com",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("negotiates and schedules through the registered relay", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    process.env.RELAY_SHARED_SECRET = "relay-secret";
    const t = convexTest(schema, modules);
    const headers = {
      Authorization: "Bearer relay-secret",
      "Content-Type": "application/json",
    };

    const capability = await t.fetch("/relay/notification-channels", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "welcome-scheduling-capability",
        userId: USER.subject,
      }),
    });
    expect(capability.status).toBe(200);
    await expect(capability.json()).resolves.toEqual({
      durableWelcomeScheduling: true,
    });

    const mutation = await t.fetch("/relay/notification-channels", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set-channel",
        userId: USER.subject,
        channelType: "email",
        email: "relay-first-connect@example.com",
        scheduleWelcome: true,
      }),
    });
    expect(mutation.status).toBe(200);
    await expect(mutation.json()).resolves.toEqual({
      ok: true,
      isNew: true,
      durableWelcomeScheduling: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedEvent(fetchMock).message).toEqual({
      eventType: "channel_welcome",
      userId: USER.subject,
      channelType: "email",
      welcomeId: expect.any(String),
    });
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
      scheduleWelcome: true,
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
      welcomeId: expect.any(String),
    });
  });

  test("preserves the old-edge relay response without scheduling a duplicate", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    process.env.RELAY_SHARED_SECRET = "relay-secret";
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/notification-channels", {
      method: "POST",
      headers: {
        Authorization: "Bearer relay-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "set-channel",
        userId: USER.subject,
        channelType: "email",
        email: "legacy-relay@example.com",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      isNew: true,
      durableWelcomeScheduling: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("retries a transient enqueue failure with the same atomic dedupe key", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    fetchMock.mockRejectedValueOnce(new Error("temporary Upstash timeout"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "retry-enqueue@example.com",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const commands = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as unknown[]
    );
    expect(commands[0]?.[3]).toMatch(/^wm:channel-welcome:/);
    expect(commands[1]?.[3]).toBe(commands[0]?.[3]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("treats an ambiguous committed enqueue as a deduplicated success", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    fetchMock
      .mockRejectedValueOnce(new Error("response lost after atomic enqueue"))
      .mockResolvedValueOnce(Response.json({ result: 0 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "ambiguous-enqueue@example.com",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const commands = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as unknown[]
    );
    expect(commands[1]?.[3]).toBe(commands[0]?.[3]);
    expect(commands[1]?.[0]).toBe("EVAL");
  });

  test("retries after an atomic enqueue error without poisoning the claim", async () => {
    vi.useFakeTimers();
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    const claims = new Set<string>();
    const queuedMessages: string[] = [];
    let failNextPush = true;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) => {
        const command = JSON.parse(String(init?.body)) as unknown[];
        const script = String(command[1]);
        const claimKey = String(command[3]);
        const message = String(command[5]);
        if (claims.has(claimKey)) return Response.json({ result: 0 });
        claims.add(claimKey);
        if (failNextPush) {
          failNextPush = false;
          const pushIndex = script.indexOf("redis.pcall('LPUSH'");
          const cleanupIndex = script.indexOf("redis.call('DEL'", pushIndex);
          if (pushIndex >= 0 && cleanupIndex > pushIndex) {
            claims.delete(claimKey);
          }
          return Response.json({ result: -2 });
        }
        queuedMessages.unshift(message);
        return Response.json({ result: queuedMessages.length });
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "script-error@example.com",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(claims.size).toBe(1);
    expect(queuedMessages).toHaveLength(1);
    expect(JSON.parse(queuedMessages[0]!)).toMatchObject({
      eventType: "channel_welcome",
      userId: USER.subject,
    });
  });

  test("drops a retry after its channel connection has been replaced", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    const t = convexTest(schema, modules);

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "old-connection@example.com",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    await t.run(async (ctx) => {
      const oldChannel = await ctx.db
        .query("notificationChannels")
        .withIndex("by_user_channel", (q) =>
          q.eq("userId", USER.subject).eq("channelType", "email"),
        )
        .unique();
      if (!oldChannel) throw new Error("missing scheduled channel");
      await ctx.db.delete(oldChannel._id);
      await ctx.db.insert("notificationChannels", {
        userId: USER.subject,
        channelType: "email",
        email: "replacement@example.com",
        verified: true,
        linkedAt: Date.now(),
      });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("transfers a shared endpoint to another account as a fresh connection", async () => {
    vi.useFakeTimers();
    const fetchMock = installQueueMock();
    const t = convexTest(schema, modules);
    const endpoint = "https://fcm.googleapis.com/push/shared-device";
    const otherUser = "user-tests-notification-channels-b";

    await expect(t.mutation(notificationChannelFns.setWebPushChannelForUser, {
      userId: USER.subject,
      endpoint,
      p256dh: "p256dh-a",
      auth: "auth-a",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await expect(t.mutation(notificationChannelFns.setWebPushChannelForUser, {
      userId: otherUser,
      endpoint,
      p256dh: "p256dh-b",
      auth: "auth-b",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The prior owner's row is deleted; only the new account keeps the endpoint.
    await t.run(async (ctx) => {
      const rows = (await ctx.db.query("notificationChannels").collect()).filter(
        (row) => row.channelType === "web_push" && row.endpoint === endpoint,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(otherUser);
    });

    // Both first connects welcome their own account, in order.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const welcomedUsers = fetchMock.mock.calls.map(([, init]) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      return (JSON.parse(String(command[5])) as { userId: string }).userId;
    });
    expect(welcomedUsers).toEqual([USER.subject, otherUser]);
  });

  test("stops retrying after the final scheduled attempt fails", async () => {
    vi.useFakeTimers();
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Upstash unreachable"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await expect(t.mutation(notificationChannelFns.setChannelForUser, {
      userId: USER.subject,
      channelType: "email",
      email: "retry-exhausted@example.com",
      scheduleWelcome: true,
    })).resolves.toEqual({ isNew: true });
    // The terminal attempt (attempt 5, no successor) rethrows inside the
    // scheduler; drain everything and tolerate that final rejection so the
    // attempt-count assertions below stay the teeth of this test.
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } catch {
      // expected: terminal attempt propagates its enqueue failure
    }

    // Initial attempt + 5 scheduled retries, then no further successor.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const retryWarns = warn.mock.calls.filter(([message]) =>
      String(message).includes("queueChannelWelcome"),
    );
    // Attempts 1-5 warn-and-retry; the terminal attempt rethrows instead.
    expect(retryWarns).toHaveLength(5);
  });
});
