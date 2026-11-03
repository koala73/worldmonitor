import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

afterEach(() => vi.useRealTimers());

test.each([[100, 3], [205, 108]])("cleanup drains %i expired tokens and preserves live tokens", async (expiredCount, afterFirstCount) => {
  vi.useFakeTimers();
  const now = Date.parse("2026-09-14T00:00:00Z");
  vi.setSystemTime(now);
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let index = 0; index < expiredCount; index += 1) {
      await ctx.db.insert("telegramPairingTokens", {
        userId: "fixture-owner",
        token: `expired-${index}`,
        expiresAt: now - 1,
        used: index % 2 === 0,
      });
    }
    for (const [token, expiresAt, used] of [
      ["boundary", now, false],
      ["live", now + 60_000, false],
      ["live-used", now + 60_000, true],
    ] as const) {
      await ctx.db.insert("telegramPairingTokens", { userId: "fixture-owner", token, expiresAt, used });
    }
  });
  expect(await t.mutation(internal.notificationChannels.claimPairingToken, { token: "expired-1", chatId: "fixture-chat" })).toEqual({ ok: false, reason: "EXPIRED" });
  expect(await t.mutation(internal.telegramPairingTokens.cleanupExpired, {})).toEqual({ deleted: 100 });
  expect(await t.run(async (ctx) => (await ctx.db.query("telegramPairingTokens").collect()).length)).toBe(afterFirstCount);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const remaining = await t.run(async (ctx) => (await ctx.db.query("telegramPairingTokens").collect()).map((row) => row.token).sort());
  expect(remaining).toEqual(["boundary", "live", "live-used"]);
  expect(await t.mutation(internal.telegramPairingTokens.cleanupExpired, {})).toEqual({ deleted: 0 });
});
