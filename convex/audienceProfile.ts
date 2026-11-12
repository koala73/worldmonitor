/**
 * About-you profile: what a signed-in account uses WorldMonitor for, whether
 * it is personal or work, who pays, its role, and an optional free-text
 * alternative. Read and written by the dashboard card, the Pro activation step,
 * and the MCP connect screen; read by the weekly audience export.
 *
 * Public functions trust ONLY `ctx.auth.getUserIdentity()` for identity. Option
 * ids are validated against `shared/audience-profile.ts`. Writes upsert the
 * `users` row the same way `users:recordTermsAcceptance` does, because a buyer
 * or an MCP connector may never have run `users:ensureRecord`.
 *
 * Failures return `{ ok: false, reason }` instead of throwing: a profile write
 * is never worth an error toast or a broken grant flow.
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { isAccountDeleting } from "./accountDeletion/guard";
import {
  ABOUT_YOU_KEY_QUESTIONS,
  ABOUT_YOU_RETURN_DELAY_MS,
  ABOUT_YOU_VERSION,
  isAboutYouChoiceQuestion,
  isAboutYouOption,
  isAboutYouSurface,
  normalizeAboutYouFreeText,
  type AboutYouChoiceQuestionId,
  type AboutYouSurface,
} from "../shared/audience-profile";

/** Profile writes allowed per user per window. A full card is under ten. */
export const ABOUT_YOU_WRITE_LIMIT = 30;
export const ABOUT_YOU_WRITE_WINDOW_MS = 60 * 60 * 1000;

type AboutYou = NonNullable<Doc<"users">["aboutYou"]>;
type AnswerFields = Pick<AboutYou, AboutYouChoiceQuestionId | "alternative">;

type WriteFailure = {
  ok: false;
  reason: "unauthenticated" | "invalid-input" | "account-deletion" | "rate-limited";
};

const ANSWER_KEYS = ["primaryUse", "usageContext", "payer", "role", "alternative"] as const;

function answersOf(profile: AboutYou | undefined): AnswerFields {
  const answers: AnswerFields = {};
  if (!profile) return answers;
  for (const key of ANSWER_KEYS) {
    const value = profile[key];
    if (value !== undefined) answers[key] = value;
  }
  return answers;
}

function hasAnswer(profile: AboutYou | undefined): boolean {
  return Object.keys(answersOf(profile)).length > 0;
}

function keyQuestionsComplete(profile: AboutYou | undefined): boolean {
  return ABOUT_YOU_KEY_QUESTIONS.every((key) => profile?.[key] !== undefined);
}

/**
 * Apply `change` to the caller's profile: deletion fence, per-user write
 * limit, then upsert. `change` receives the current profile (or a fresh one)
 * and returns the fields to merge.
 */
async function writeProfile(
  ctx: MutationCtx,
  change: (current: AboutYou, now: number) => Partial<AboutYou>,
): Promise<{ ok: true } | WriteFailure> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { ok: false, reason: "unauthenticated" };
  const userId = identity.subject;
  if (await isAccountDeleting(ctx, userId)) return { ok: false, reason: "account-deletion" };

  const now = Date.now();
  const existing = await ctx.db
    .query("users")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  const current: AboutYou = existing?.aboutYou ?? { version: ABOUT_YOU_VERSION };

  const windowOpen =
    current.writeWindowStart !== undefined &&
    now - current.writeWindowStart < ABOUT_YOU_WRITE_WINDOW_MS;
  const writeCount = windowOpen ? (current.writeCount ?? 0) : 0;
  if (writeCount >= ABOUT_YOU_WRITE_LIMIT) return { ok: false, reason: "rate-limited" };

  const next: AboutYou = {
    ...current,
    ...change(current, now),
    writeWindowStart: windowOpen ? current.writeWindowStart : now,
    writeCount: writeCount + 1,
  };

  if (!existing) {
    const email = (identity.email ?? "").trim();
    await ctx.db.insert("users", {
      userId,
      email: email || undefined,
      normalizedEmail: email ? email.toLowerCase() : undefined,
      firstSeenAt: now,
      lastSeenAt: now,
      aboutYou: next,
    });
  } else {
    await ctx.db.patch(existing._id, { aboutYou: next, lastSeenAt: now });
  }
  return { ok: true };
}

function answerStamp(current: AboutYou, now: number, surface: AboutYouSurface): Partial<AboutYou> {
  return {
    version: ABOUT_YOU_VERSION,
    firstAnsweredAt: current.firstAnsweredAt ?? now,
    answerSurface: current.answerSurface ?? surface,
    updatedAt: now,
  };
}

/** One tap on one question. */
export const recordAnswer = mutation({
  args: { questionId: v.string(), optionId: v.string(), surface: v.string() },
  handler: async (ctx, args) => {
    const { questionId, optionId, surface } = args;
    if (
      !isAboutYouChoiceQuestion(questionId) ||
      !isAboutYouOption(questionId, optionId) ||
      !isAboutYouSurface(surface)
    ) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    return writeProfile(ctx, (current, now) => ({
      ...answerStamp(current, now, surface),
      [questionId]: optionId,
    }));
  },
});

/**
 * Several answers in one write, for surfaces that submit once (the Pro
 * activation step, the MCP connect screen). All-or-nothing validation.
 */
export const recordAnswers = mutation({
  args: {
    surface: v.string(),
    primaryUse: v.optional(v.string()),
    usageContext: v.optional(v.string()),
    payer: v.optional(v.string()),
    role: v.optional(v.string()),
    alternative: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { surface, alternative, ...choices } = args;
    if (!isAboutYouSurface(surface)) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    const fields: Partial<AboutYou> = {};
    for (const [questionId, optionId] of Object.entries(choices)) {
      if (optionId === undefined) continue;
      if (!isAboutYouChoiceQuestion(questionId) || !isAboutYouOption(questionId, optionId)) {
        return { ok: false as const, reason: "invalid-input" as const };
      }
      fields[questionId] = optionId;
    }
    const text = alternative === undefined ? null : normalizeAboutYouFreeText(alternative);
    if (text !== null) fields.alternative = text;
    if (Object.keys(fields).length === 0) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    return writeProfile(ctx, (current, now) => ({ ...answerStamp(current, now, surface), ...fields }));
  },
});

/** The free-text answer, saved on blur. Empty text stores nothing. */
export const recordFreeText = mutation({
  args: { text: v.string(), surface: v.string() },
  handler: async (ctx, args) => {
    const { surface } = args;
    if (!isAboutYouSurface(surface)) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    const text = normalizeAboutYouFreeText(args.text);
    if (text === null) return { ok: true as const, stored: false };
    const result = await writeProfile(ctx, (current, now) => ({
      ...answerStamp(current, now, surface),
      alternative: text,
    }));
    return result.ok ? { ok: true as const, stored: true } : result;
  },
});

/**
 * Skip the questionnaire. The first skip's time and surface are kept, so a
 * later answer still shows that the account skipped once and where.
 */
export const skip = mutation({
  args: { surface: v.string() },
  handler: async (ctx, args) => {
    const { surface } = args;
    if (!isAboutYouSurface(surface)) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    return writeProfile(ctx, (current, now) => ({
      skippedAt: current.skippedAt ?? now,
      skipSurface: current.skipSurface ?? surface,
    }));
  },
});

/** The one return visit (R19) was shown; never return again. */
export const markReturnShown = mutation({
  args: {},
  handler: async (ctx) =>
    writeProfile(ctx, (current, now) => ({ returnShownAt: current.returnShownAt ?? now })),
});

/**
 * The caller's profile status. `null` when signed out.
 *
 * - `answered`: at least one answer exists.
 * - `skipped`: skipped with no answers. Never asked again.
 * - `due`: neither.
 *
 * `returnDue` is the single return visit for empty key questions (R19): the
 * profile is answered but missing primary use or personal vs work, a day has
 * passed since the last answer, and the return has not been shown.
 */
export const getStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    const profile = row?.aboutYou;
    const answered = hasAnswer(profile);
    const keyComplete = keyQuestionsComplete(profile);
    const returnDue =
      answered &&
      !keyComplete &&
      profile?.returnShownAt === undefined &&
      profile?.updatedAt !== undefined &&
      Date.now() - profile.updatedAt >= ABOUT_YOU_RETURN_DELAY_MS;
    return {
      status: answered ? ("answered" as const) : profile?.skippedAt !== undefined ? ("skipped" as const) : ("due" as const),
      answers: answersOf(profile),
      keyQuestionsComplete: keyComplete,
      returnDue,
    };
  },
});
