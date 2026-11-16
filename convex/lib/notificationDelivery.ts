import { v } from "convex/values";

export const deliveryFailureValidator = v.optional(v.object({
  count: v.number(),
  firstFailedAt: v.number(),
  lastError: v.string(),
  disabledAt: v.optional(v.number()),
}));

export const deliveryResultValidator = v.object({
  channelId: v.string(),
  linkedAt: v.number(),
  error: v.union(v.string(), v.null()),
});

export function isDeliveryError(value: unknown): value is string {
  return typeof value === "string" && (
    /^HTTP [1-5][0-9]{2}$/.test(value)
    || ["DNS lookup failed", "URL rejected", "Request timed out", "Connection failed", "Decrypt failed", "Delivery failed"].includes(value)
  );
}
