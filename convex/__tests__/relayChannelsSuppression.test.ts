import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const DELIVERY_SECRET = "test-delivery-secret";
const USER = "user_relay_channels_suppression";

describe("/relay/channels email suppression", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", DELIVERY_SECRET);
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "tenant-secret");
    vi.stubEnv("RELAY_SHARED_SECRET", "ingestion-only");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function channelsFor(t: ReturnType<typeof convexTest>) {
    const res = await t.fetch("/relay/channels", {
      method: "POST",
      headers: { Authorization: `Bearer ${DELIVERY_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{ channelType: string }>;
  }

  async function seed(reason?: "bounce" | "complaint" | "manual" | "unsubscribe") {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("notificationChannels", {
        userId: USER, channelType: "email", email: "Alerts@Example.com",
        emailOwnership: "verified_account", verified: true, linkedAt: 1,
      });
      await ctx.db.insert("notificationChannels", {
        userId: USER, channelType: "telegram", chatId: "chat-1",
        telegramOwnership: "verified_callback", verified: true, linkedAt: 1,
      });
      if (reason) {
        await ctx.db.insert("emailSuppressions", {
          normalizedEmail: "alerts@example.com", reason, suppressedAt: 1,
        });
      }
    });
    return t;
  }

  test("returns every channel when the address is not suppressed", async () => {
    const t = await seed();
    expect((await channelsFor(t)).map((c) => c.channelType).sort()).toEqual(["email", "telegram"]);
  });

  test.each(["bounce", "complaint", "manual"] as const)("drops the email channel after a %s", async (reason) => {
    const t = await seed(reason);
    expect((await channelsFor(t)).map((c) => c.channelType)).toEqual(["telegram"]);
  });

  test("a broadcast unsubscribe does not stop alerts the user asked for", async () => {
    const t = await seed("unsubscribe");
    expect((await channelsFor(t)).map((c) => c.channelType).sort()).toEqual(["email", "telegram"]);
  });
});
