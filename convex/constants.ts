import { v } from "convex/values";

export const channelTypeValidator = v.union(
  v.literal("telegram"),
  v.literal("slack"),
  v.literal("email"),
  v.literal("discord"),
);

export const sensitivityValidator = v.union(
  v.literal("all"),
  v.literal("high"),
  v.literal("critical"),
);

export const quietHoursOverrideValidator = v.union(
  v.literal("critical_only"),
  v.literal("silence_all"),
  v.literal("batch_on_wake"),
);

export const CURRENT_PREFS_SCHEMA_VERSION = 1;

export const MAX_PREFS_BLOB_SIZE = 65536;
