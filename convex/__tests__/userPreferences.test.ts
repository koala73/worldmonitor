import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER_A = {
  subject: "user-prefs-rate-a",
  tokenIdentifier: "clerk|user-prefs-rate-a",
};

const USER_B = {
  subject: "user-prefs-rate-b",
  tokenIdentifier: "clerk|user-prefs-rate-b",
};

function makeT() {
  return convexTest(schema, modules);
}

async function writePref(
  t: ReturnType<typeof convexTest>,
  user: typeof USER_A,
  expectedSyncVersion: number,
) {
  return await t.withIdentity(user).mutation(api.userPreferences.setPreferences, {
    variant: "full",
    data: { theme: `theme-${expectedSyncVersion}` },
    expectedSyncVersion,
    schemaVersion: 1,
  });
}

describe("userPreferences.setPreferences write rate limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("caps direct Convex writes per authenticated user and fixed window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const t = makeT();

    for (let i = 0; i < 30; i++) {
      const result = await writePref(t, USER_A, i);
      expect(result).toEqual({ ok: true, syncVersion: i + 1 });
    }

    await expect(writePref(t, USER_A, 30)).rejects.toThrow(/RATE_LIMITED|rate/i);

    const row = await t.run(async (ctx) => {
      return await ctx.db
        .query("userPreferences")
        .withIndex("by_user_variant", (q) =>
          q.eq("userId", USER_A.subject).eq("variant", "full"),
        )
        .unique();
    });
    expect(row?.syncVersion).toBe(30);
  });

  test("uses separate buckets per authenticated user", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const t = makeT();

    for (let i = 0; i < 30; i++) {
      await writePref(t, USER_A, i);
    }
    await expect(writePref(t, USER_A, 30)).rejects.toThrow(/RATE_LIMITED|rate/i);

    await expect(writePref(t, USER_B, 0)).resolves.toEqual({ ok: true, syncVersion: 1 });
  });

  test("resets the write budget when the fixed window advances", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const t = makeT();

    for (let i = 0; i < 30; i++) {
      await writePref(t, USER_A, i);
    }
    await expect(writePref(t, USER_A, 30)).rejects.toThrow(/RATE_LIMITED|rate/i);

    now.mockReturnValue(1_700_000_060_000);
    await expect(writePref(t, USER_A, 30)).resolves.toEqual({ ok: true, syncVersion: 31 });
  });
});
