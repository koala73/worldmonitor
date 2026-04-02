import { internalMutation } from "./_generated/server";

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("telegramPairingTokens")
      .filter((q) => q.lt(q.field("expiresAt"), now))
      .collect();
    for (const token of expired) {
      await ctx.db.delete(token._id);
    }
    return { deleted: expired.length };
  },
});
