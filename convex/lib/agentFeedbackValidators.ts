import { v } from "convex/values";

export const AGENT_FEEDBACK_KINDS = [
  "bug",
  "missing_capability",
  "data_quality",
  "security",
] as const;
export type AgentFeedbackKind = (typeof AGENT_FEEDBACK_KINDS)[number];

export const agentFeedbackKindValidator = v.union(
  v.literal("bug"),
  v.literal("missing_capability"),
  v.literal("data_quality"),
  v.literal("security"),
);

// received → triaged → filed | duplicate | dismissed. Security rows take the
// private branch: private → closed, and never reach `filed`.
export const agentFeedbackStatusValidator = v.union(
  v.literal("received"),
  v.literal("triaged"),
  v.literal("filed"),
  v.literal("duplicate"),
  v.literal("dismissed"),
  v.literal("private"),
  v.literal("closed"),
);
