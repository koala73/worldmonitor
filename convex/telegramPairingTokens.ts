import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

const CLEANUP_BATCH_SIZE = 100;

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(CLEANUP_BATCH_SIZE);
    for (const token of expired) {
      await ctx.db.delete(token._id);
    }
    if (expired.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.telegramPairingTokens.cleanupExpired, {});
    }
    return { deleted: expired.length };
  },
});
