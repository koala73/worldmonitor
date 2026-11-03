import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import {
  ABOUT_YOU_FREE_TEXT_MAX,
  ABOUT_YOU_RETURN_DELAY_MS,
  ABOUT_YOU_VERSION,
} from "../../shared/audience-profile";
import { ABOUT_YOU_WRITE_LIMIT } from "../audienceProfile";

const modules = import.meta.glob("../**/*.ts");

const USER_A = { subject: "user-about-you-A", tokenIdentifier: "clerk|user-about-you-A", email: "a@example.com" };
const USER_B = { subject: "user-about-you-B", tokenIdentifier: "clerk|user-about-you-B" };

async function readUser(t: ReturnType<typeof convexTest>, userId: string) {
  return t.run(async (ctx) =>
    ctx.db.query("users").withIndex("by_userId", (q) => q.eq("userId", userId)).unique(),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("audienceProfile answers", () => {
  test("recording an answer on an existing row patches only the profile", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: USER_A.subject,
        email: "a@example.com",
        normalizedEmail: "a@example.com",
        firstSeenAt: 1,
        lastSeenAt: 1,
        termsAcceptedAt: 1,
        termsVersion: "2026-11-01",
        signupRef: "agent-claude",
        signupSource: "claude",
      });
    });

    const result = await t.withIdentity(USER_A).mutation(api.audienceProfile.recordAnswer, {
      questionId: "primaryUse",
      optionId: "markets",
      surface: "dashboard",
    });
    expect(result).toEqual({ ok: true });

    const row = await readUser(t, USER_A.subject);
    expect(row).toMatchObject({
      firstSeenAt: 1,
      termsAcceptedAt: 1,
      termsVersion: "2026-11-01",
      signupRef: "agent-claude",
      signupSource: "claude",
      aboutYou: {
        primaryUse: "markets",
        version: ABOUT_YOU_VERSION,
        answerSurface: "dashboard",
      },
    });
    expect(row?.aboutYou?.firstAnsweredAt).toBeTypeOf("number");
  });

  test("recording an answer with no users row inserts one", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(USER_A).mutation(api.audienceProfile.recordAnswer, {
      questionId: "usageContext",
      optionId: "work",
      surface: "mcp-connect",
    });
    const row = await readUser(t, USER_A.subject);
    expect(row).toMatchObject({
      userId: USER_A.subject,
      email: "a@example.com",
      normalizedEmail: "a@example.com",
      aboutYou: { usageContext: "work", answerSurface: "mcp-connect" },
    });
    expect(row?.firstSeenAt).toBeTypeOf("number");
    expect(row?.lastSeenAt).toBe(row?.firstSeenAt);
  });

  test("an option id outside the shared taxonomy is rejected", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    expect(
      await asA.mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: "shopping",
        surface: "dashboard",
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      await asA.mutation(api.audienceProfile.recordAnswer, {
        questionId: "favouriteColour",
        optionId: "news",
        surface: "dashboard",
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      await asA.mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: "news",
        surface: "nowhere",
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(await readUser(t, USER_A.subject)).toBeNull();
  });

  test("free text is trimmed and capped; empty free text is ignored", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    expect(
      await asA.mutation(api.audienceProfile.recordFreeText, { text: "   ", surface: "dashboard" }),
    ).toEqual({ ok: true, stored: false });
    expect(await readUser(t, USER_A.subject)).toBeNull();

    await asA.mutation(api.audienceProfile.recordFreeText, {
      text: `  ${"x".repeat(ABOUT_YOU_FREE_TEXT_MAX + 50)}  `,
      surface: "dashboard",
    });
    const row = await readUser(t, USER_A.subject);
    expect(row?.aboutYou?.alternative).toBe("x".repeat(ABOUT_YOU_FREE_TEXT_MAX));
  });

  test("skip then answer: status is answered and the skip is kept", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    await asA.mutation(api.audienceProfile.skip, { surface: "activation" });
    expect((await asA.query(api.audienceProfile.getStatus, {}))?.status).toBe("skipped");

    await asA.mutation(api.audienceProfile.recordAnswer, {
      questionId: "payer",
      optionId: "employer",
      surface: "mcp-connect",
    });
    const status = await asA.query(api.audienceProfile.getStatus, {});
    expect(status).toMatchObject({ status: "answered", answers: { payer: "employer" } });
    const row = await readUser(t, USER_A.subject);
    expect(row?.aboutYou).toMatchObject({ skipSurface: "activation", answerSurface: "mcp-connect" });
    expect(row?.aboutYou?.skippedAt).toBeTypeOf("number");
  });

  test("a second skip keeps the first skip's time and surface", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    await asA.mutation(api.audienceProfile.skip, { surface: "dashboard" });
    const first = (await readUser(t, USER_A.subject))?.aboutYou;
    await asA.mutation(api.audienceProfile.skip, { surface: "mcp-connect" });
    const second = (await readUser(t, USER_A.subject))?.aboutYou;
    expect(second?.skipSurface).toBe("dashboard");
    expect(second?.skippedAt).toBe(first?.skippedAt);
  });
});

describe("audienceProfile status", () => {
  test("due with no profile, answered after one answer, skipped after a skip", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    const asB = t.withIdentity(USER_B);
    expect(await asA.query(api.audienceProfile.getStatus, {})).toEqual({
      status: "due",
      answers: {},
      keyQuestionsComplete: false,
      returnDue: false,
    });

    await asA.mutation(api.audienceProfile.recordAnswer, {
      questionId: "primaryUse",
      optionId: "news",
      surface: "dashboard",
    });
    expect((await asA.query(api.audienceProfile.getStatus, {}))?.status).toBe("answered");

    await asB.mutation(api.audienceProfile.skip, { surface: "dashboard" });
    expect((await asB.query(api.audienceProfile.getStatus, {}))?.status).toBe("skipped");
  });

  test("unauthenticated calls are rejected", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.audienceProfile.getStatus, {})).toBeNull();
    expect(
      await t.mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: "news",
        surface: "dashboard",
      }),
    ).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await t.mutation(api.audienceProfile.skip, { surface: "dashboard" })).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  test("keyQuestionsComplete needs both primary use and personal vs work", async () => {
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    await asA.mutation(api.audienceProfile.recordAnswer, {
      questionId: "primaryUse",
      optionId: "commodities",
      surface: "dashboard",
    });
    expect((await asA.query(api.audienceProfile.getStatus, {}))?.keyQuestionsComplete).toBe(false);
    await asA.mutation(api.audienceProfile.recordAnswer, {
      questionId: "usageContext",
      optionId: "personal",
      surface: "dashboard",
    });
    expect((await asA.query(api.audienceProfile.getStatus, {}))?.keyQuestionsComplete).toBe(true);
  });

  test("R19: the card returns once for an empty key question, a day later, then never", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    await asA.mutation(api.audienceProfile.recordAnswer, {
      questionId: "primaryUse",
      optionId: "travel",
      surface: "dashboard",
    });
    expect((await asA.query(api.audienceProfile.getStatus, {}))?.returnDue).toBe(false);

    vi.setSystemTime(Date.now() + ABOUT_YOU_RETURN_DELAY_MS + 1);
    expect((await asA.query(api.audienceProfile.getStatus, {}))?.returnDue).toBe(true);

    expect(await asA.mutation(api.audienceProfile.markReturnShown, {})).toEqual({ ok: true });
    expect((await asA.query(api.audienceProfile.getStatus, {}))?.returnDue).toBe(false);
  });

  test("a full skip with no answers never returns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    await asA.mutation(api.audienceProfile.skip, { surface: "dashboard" });
    vi.setSystemTime(Date.now() + 7 * ABOUT_YOU_RETURN_DELAY_MS);
    expect(await asA.query(api.audienceProfile.getStatus, {})).toMatchObject({
      status: "skipped",
      returnDue: false,
    });
  });
});

describe("audienceProfile write limit", () => {
  test("writes past the per-user hourly limit are refused; another user is unaffected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const t = convexTest(schema, modules);
    const asA = t.withIdentity(USER_A);
    for (let i = 0; i < ABOUT_YOU_WRITE_LIMIT; i += 1) {
      const result = await asA.mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: i % 2 === 0 ? "news" : "markets",
        surface: "dashboard",
      });
      expect(result).toEqual({ ok: true });
    }
    expect(
      await asA.mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: "travel",
        surface: "dashboard",
      }),
    ).toEqual({ ok: false, reason: "rate-limited" });
    expect((await readUser(t, USER_A.subject))?.aboutYou?.primaryUse).not.toBe("travel");

    expect(
      await t.withIdentity(USER_B).mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: "travel",
        surface: "dashboard",
      }),
    ).toEqual({ ok: true });

    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    expect(
      await asA.mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: "travel",
        surface: "dashboard",
      }),
    ).toEqual({ ok: true });
  });
});

describe("audienceProfile account deletion", () => {
  test("a deleting account cannot write a profile", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("accountDeletions", {
        userId: USER_A.subject,
        userIdHash: "a".repeat(64),
        source: "self",
        status: "pending",
        step: "personal",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(
      await t.withIdentity(USER_A).mutation(api.audienceProfile.recordAnswer, {
        questionId: "primaryUse",
        optionId: "news",
        surface: "dashboard",
      }),
    ).toEqual({ ok: false, reason: "account-deletion" });
  });
});
