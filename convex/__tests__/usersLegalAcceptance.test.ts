/**
 * users:recordLegalAcceptance — the assent record behind the EULA (#6976).
 *
 * What this has to get right: identity comes from auth and never the body,
 * the stored version is the one that was actually shown, re-accepting the same
 * version does not write (the `users` row is OCC-hot — 1,618 write conflicts
 * in a single day once), and the first acceptance timestamp survives a later
 * version bump.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER = {
  subject: "user-legal-a",
  tokenIdentifier: "clerk|user-legal-a",
  email: "alice@example.com",
};
const OTHER_USER = {
  subject: "user-legal-b",
  tokenIdentifier: "clerk|user-legal-b",
  email: "bob@example.com",
};

const V1 = "2026-08-20";
const V2 = "2026-11-01";

async function seedUser(t: ReturnType<typeof convexTest>, identity: typeof USER) {
  await t.withIdentity(identity).mutation(api.users.ensureRecord, {
    localeTag: "en-US",
    localePrimary: "en",
  });
}

async function readUser(t: ReturnType<typeof convexTest>, userId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique(),
  );
}

describe("users:recordLegalAcceptance — gates", () => {
  test("unauthenticated call records nothing", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(api.users.recordLegalAcceptance, { version: V1, via: "checkout" });
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("a version that is not an ISO date is rejected", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    for (const version of ["latest", "2026-8-20", "v1", "", "2026-08-20; DROP"]) {
      const result = await t
        .withIdentity(USER)
        .mutation(api.users.recordLegalAcceptance, { version, via: "checkout" });
      expect(result).toEqual({ ok: false, reason: "invalid-input", field: "version" });
    }
    expect((await readUser(t, USER.subject))?.legalAcceptedVersion).toBeUndefined();
  });

  test("an unknown acceptance surface is rejected", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    const result = await t
      .withIdentity(USER)
      .mutation(api.users.recordLegalAcceptance, { version: V1, via: "email-footer" });
    expect(result).toEqual({ ok: false, reason: "invalid-input", field: "via" });
  });

  test("no user row yet → reports it instead of inventing one", async () => {
    const t = convexTest(schema, modules);
    const result = await t
      .withIdentity(USER)
      .mutation(api.users.recordLegalAcceptance, { version: V1, via: "signup" });
    expect(result).toEqual({ ok: false, reason: "no-user-record" });
  });
});

describe("users:recordLegalAcceptance — recording", () => {
  test("stores the version, the surface, and both timestamps", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    const before = Date.now();

    const result = await t
      .withIdentity(USER)
      .mutation(api.users.recordLegalAcceptance, { version: V1, via: "checkout" });
    expect(result).toEqual({ ok: true, action: "recorded" });

    const row = await readUser(t, USER.subject);
    expect(row?.legalAcceptedVersion).toBe(V1);
    expect(row?.legalAcceptedVia).toBe("checkout");
    expect(row?.legalAcceptedAt).toBeGreaterThanOrEqual(before);
    expect(row?.legalFirstAcceptedAt).toBe(row?.legalAcceptedAt);
  });

  test("re-accepting the same version does not write", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    await t.withIdentity(USER).mutation(api.users.recordLegalAcceptance, { version: V1, via: "signup" });
    const first = await readUser(t, USER.subject);

    const again = await t
      .withIdentity(USER)
      .mutation(api.users.recordLegalAcceptance, { version: V1, via: "checkout" });

    expect(again).toEqual({ ok: true, action: "unchanged" });
    const second = await readUser(t, USER.subject);
    // A no-op must be a genuine read: same timestamp AND the surface of the
    // original acceptance, not the surface of the repeat call.
    expect(second?.legalAcceptedAt).toBe(first?.legalAcceptedAt);
    expect(second?.legalAcceptedVia).toBe("signup");
  });

  test("a new version updates, but never moves the first acceptance", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    await t.withIdentity(USER).mutation(api.users.recordLegalAcceptance, { version: V1, via: "signup" });
    const first = await readUser(t, USER.subject);

    const result = await t
      .withIdentity(USER)
      .mutation(api.users.recordLegalAcceptance, { version: V2, via: "checkout" });
    expect(result).toEqual({ ok: true, action: "updated" });

    const row = await readUser(t, USER.subject);
    expect(row?.legalAcceptedVersion).toBe(V2);
    expect(row?.legalFirstAcceptedAt).toBe(first?.legalFirstAcceptedAt);
    expect(row?.legalAcceptedAt).toBeGreaterThanOrEqual(first?.legalAcceptedAt ?? 0);
  });

  test("acceptance is attributed to the caller, not to another user", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    await seedUser(t, OTHER_USER);

    await t.withIdentity(USER).mutation(api.users.recordLegalAcceptance, { version: V1, via: "checkout" });

    expect((await readUser(t, USER.subject))?.legalAcceptedVersion).toBe(V1);
    expect((await readUser(t, OTHER_USER.subject))?.legalAcceptedVersion).toBeUndefined();
  });
});

describe("users:internalRecordLegalAcceptance — the relay path", () => {
  test("records against the userId the relay verified, with no ctx.auth identity", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);

    // No withIdentity: /relay/create-checkout authenticates with the relay
    // secret and passes a userId the edge already verified from the Clerk JWT.
    const result = await t.mutation(internal.users.internalRecordLegalAcceptance, {
      userId: USER.subject,
      version: V1,
      via: "checkout",
    });

    expect(result).toEqual({ ok: true, action: "recorded" });
    expect((await readUser(t, USER.subject))?.legalAcceptedVersion).toBe(V1);
  });

  test("rejects a malformed version rather than storing it", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);

    const result = await t.mutation(internal.users.internalRecordLegalAcceptance, {
      userId: USER.subject,
      version: "latest",
      via: "checkout",
    });

    expect(result).toEqual({ ok: false, reason: "invalid-input" });
    expect((await readUser(t, USER.subject))?.legalAcceptedVersion).toBeUndefined();
  });

  test("a checkout that never reached ensureRecord reports it instead of failing the purchase", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.users.internalRecordLegalAcceptance, {
      userId: "user-with-no-row",
      version: V1,
      via: "checkout",
    });
    expect(result).toEqual({ ok: false, reason: "no-user-record" });
  });

  test("a retried checkout does not rewrite the acceptance", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    await t.mutation(internal.users.internalRecordLegalAcceptance, {
      userId: USER.subject,
      version: V1,
      via: "checkout",
    });
    const first = await readUser(t, USER.subject);

    const again = await t.mutation(internal.users.internalRecordLegalAcceptance, {
      userId: USER.subject,
      version: V1,
      via: "checkout",
    });

    expect(again).toEqual({ ok: true, action: "unchanged" });
    expect((await readUser(t, USER.subject))?.legalAcceptedAt).toBe(first?.legalAcceptedAt);
  });

  test("both entry points agree on what a stored acceptance looks like", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER);
    await seedUser(t, OTHER_USER);

    await t.withIdentity(USER).mutation(api.users.recordLegalAcceptance, { version: V1, via: "checkout" });
    await t.mutation(internal.users.internalRecordLegalAcceptance, {
      userId: OTHER_USER.subject,
      version: V1,
      via: "checkout",
    });

    const viaAuth = await readUser(t, USER.subject);
    const viaRelay = await readUser(t, OTHER_USER.subject);
    expect(viaRelay?.legalAcceptedVersion).toBe(viaAuth?.legalAcceptedVersion);
    expect(viaRelay?.legalAcceptedVia).toBe(viaAuth?.legalAcceptedVia);
    expect(typeof viaRelay?.legalFirstAcceptedAt).toBe(typeof viaAuth?.legalFirstAcceptedAt);
  });
});
