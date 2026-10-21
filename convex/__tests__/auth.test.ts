import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { resolveUserIdentity } from "../lib/auth";

describe("verified user identity plan", () => {
  test.each(["free", "pro"])("preserves the verified %s plan", async (plan) => {
    const t = convexTest(schema).withIdentity({ subject: "user-plan", plan });
    const identity = await t.run(resolveUserIdentity);
    expect(identity?.subject).toBe("user-plan");
    expect(identity?.plan).toBe(plan);
  });

  test.each([undefined, true, 1, "PRO", "tester", { plan: "pro" }, ["pro"]])(
    "does not expose an absent or malformed plan claim %j",
    async (plan) => {
      const t = convexTest(schema).withIdentity({ subject: "user-plan", plan });
      const identity = await t.run(resolveUserIdentity);
      expect(identity?.subject).toBe("user-plan");
      expect(identity?.plan).toBeUndefined();
    },
  );

  test("preserves checkout profile fields", async () => {
    const profile = {
      subject: "user-plan",
      name: "Test User",
      givenName: "Test",
      familyName: "User",
      email: "test@example.com",
      plan: "pro",
    };
    const t = convexTest(schema).withIdentity(profile);
    expect(await t.run(resolveUserIdentity)).toMatchObject(profile);
  });

  test("does not synthesize an identity for a signed-out caller", async () => {
    expect(await convexTest(schema).run(resolveUserIdentity)).toBeNull();
  });
});
