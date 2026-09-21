import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  company,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  modules,
  schema,
} from "./companyMonitoring.helpers";
import { sha256Hex, tombstoneUserId } from "../accountDeletion/registry";

installCompanyMonitoringTestEnvironment();

const USER_A = {
  subject: "user_deletion_a",
  tokenIdentifier: "clerk|user_deletion_a",
  email: "alice.delete@example.com",
};
const USER_B = {
  subject: "user_deletion_b",
  tokenIdentifier: "clerk|user_deletion_b",
  email: "bob.keep@example.com",
};
const OWNER = {
  subject: "user_deletion_owner",
  tokenIdentifier: "clerk|user_deletion_owner",
  email: "owner@acme.test",
};
const INVITEE = {
  subject: "user_deletion_invitee",
  tokenIdentifier: "clerk|user_deletion_invitee",
  email: "invitee@acme.test",
};

async function makeT() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.followedCountries._seedShards, {});
  await t.mutation(internal.followedCountries._seedCountryLocks, {});
  return t;
}

async function drainErase(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  identity: { subject: string; email: string },
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      userId: identity.subject,
      email: identity.email,
      normalizedEmail: identity.email.toLowerCase(),
      localeTag: "en-US",
      localePrimary: "en",
      firstSeenAt: now,
      lastSeenAt: now,
    });
  });
}

async function seedPersonalRow(
  t: ReturnType<typeof convexTest>,
  userId: string,
  email: string,
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("userPreferences", {
      userId,
      variant: "full",
      data: { theme: "dark" },
      schemaVersion: 1,
      updatedAt: now,
      syncVersion: 1,
    });
    await ctx.db.insert("notificationChannels", {
      userId,
      channelType: "email",
      email,
      verified: true,
      linkedAt: now,
    });
    await ctx.db.insert("userApiKeys", {
      userId,
      name: "test-key",
      keyPrefix: "wm_test01",
      keyHash: "a".repeat(64),
      createdAt: now,
    });
    await ctx.db.insert("customers", {
      userId,
      dodoCustomerId: `cus_${userId}`,
      email,
      normalizedEmail: email.toLowerCase(),
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("paymentEvents", {
      userId,
      dodoPaymentId: `pay_${userId}`,
      type: "charge",
      amount: 2900,
      currency: "USD",
      status: "succeeded",
      rawPayload: {
        customer: { customer_id: `cus_${userId}`, email, name: "Alice Example" },
        email,
      },
      occurredAt: now,
    });
    await ctx.db.insert("registrations", {
      email,
      normalizedEmail: email.toLowerCase(),
      registeredAt: now,
    });
    await ctx.db.insert("contactMessages", {
      name: "Alice",
      email,
      source: "test",
      receivedAt: now,
      normalizedEmail: email.toLowerCase(),
    });
    await ctx.db.insert("emailSuppressions", {
      normalizedEmail: email.toLowerCase(),
      reason: "bounce",
      suppressedAt: now,
    });
  });
}

async function followCountry(
  t: ReturnType<typeof convexTest>,
  identity: { subject: string; tokenIdentifier: string },
  country: string,
) {
  await t.withIdentity(identity).mutation(api.followedCountries.followCountry, {
    country,
  });
}

async function rawCountryCount(
  t: ReturnType<typeof convexTest>,
  country: string,
): Promise<number> {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("followedCountriesCounts")
      .withIndex("by_country", (q) => q.eq("country", country))
      .collect();
    return rows.reduce((sum, row) => sum + row.count, 0);
  });
}

async function deletionRow(
  t: ReturnType<typeof convexTest>,
  userId: string,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("accountDeletions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique(),
  );
}

async function rowsForUser(
  t: ReturnType<typeof convexTest>,
  table:
    | "users"
    | "userPreferences"
    | "notificationChannels"
    | "userApiKeys"
    | "entitlements"
    | "followedCountries"
    | "customers"
    | "paymentEvents"
    | "subscriptions"
    | "businessProGrants",
  userId: string,
) {
  return t.run(async (ctx) => {
    switch (table) {
      case "users":
        return ctx.db.query("users").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
      case "userPreferences":
        return ctx.db
          .query("userPreferences")
          .withIndex("by_user_variant", (q) => q.eq("userId", userId))
          .collect();
      case "notificationChannels":
        return ctx.db
          .query("notificationChannels")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      case "userApiKeys":
        return ctx.db
          .query("userApiKeys")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
      case "entitlements":
        return ctx.db
          .query("entitlements")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
      case "followedCountries":
        return ctx.db
          .query("followedCountries")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      case "customers":
        return ctx.db
          .query("customers")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
      case "paymentEvents":
        return ctx.db
          .query("paymentEvents")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
      case "subscriptions":
        return ctx.db
          .query("subscriptions")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
      case "businessProGrants":
        return ctx.db
          .query("businessProGrants")
          .withIndex("by_inviteeUserId", (q) => q.eq("inviteeUserId", userId))
          .collect();
      default: {
        const exhaustive: never = table;
        throw new Error(exhaustive);
      }
    }
  });
}

describe("account deletion — requestAccountDeletion auth", () => {
  test("unauthenticated request throws AUTH_REQUIRED", async () => {
    const t = await makeT();
    await expect(
      t.mutation(api.accountDeletion.erase.requestAccountDeletion, {}),
    ).rejects.toThrow("AUTH_REQUIRED");
  });
});

describe("account deletion — eraseConfirmedUser identity", () => {
  test("support rejects a missing userId", async () => {
    const t = await makeT();
    await expect(
      t.mutation(internal.accountDeletion.erase.eraseConfirmedUser, {
        userId: "",
        source: "support",
      }),
    ).rejects.toThrow("USER_ID_REQUIRED");
  });

  test("email is not an accepted argument", async () => {
    const t = await makeT();
    await expect(
      t.mutation(internal.accountDeletion.erase.eraseConfirmedUser, {
        userId: USER_A.subject,
        source: "support",
        email: USER_A.email,
      } as never),
    ).rejects.toThrow(/Unexpected field `email`/);
  });
});

describe("account deletion — Convex cascade", () => {
  test("self-delete erases the caller only and keeps billing evidence without email", async () => {
    const t = await makeT();
    await seedUser(t, USER_A);
    await seedUser(t, USER_B);
    await seedPersonalRow(t, USER_A.subject, USER_A.email);
    await seedPersonalRow(t, USER_B.subject, USER_B.email);
    await followCountry(t, USER_A, "US");
    await followCountry(t, USER_B, "US");
    expect(await rawCountryCount(t, "US")).toBe(2);

    await grantProvisioned(t, USER_A.subject);
    await t.mutation(internal.companyMonitoring.companies.createCompanyForOwner, {
      ownerUserId: USER_A.subject,
      clientRequestId: "delete-self-cm",
      company: company("Delete Self Co", "delete-self-co"),
    });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.accountDeletion.erase.requestAccountDeletion, {});
    await drainErase(t);

    expect(result.status === "pending" || result.status === "complete").toBe(true);
    const hash = await sha256Hex(USER_A.subject);
    expect(result.userIdHash).toBe(hash);
    const tombstone = tombstoneUserId(hash);

    const row = await deletionRow(t, USER_A.subject);
    expect(row?.status).toBe("complete");
    expect(row?.verifiedEmail).toBeUndefined();
    expect(row?.source).toBe("self");

    expect(await rowsForUser(t, "users", USER_A.subject)).toHaveLength(0);
    expect(await rowsForUser(t, "userPreferences", USER_A.subject)).toHaveLength(0);
    expect(await rowsForUser(t, "notificationChannels", USER_A.subject)).toHaveLength(0);
    expect(await rowsForUser(t, "userApiKeys", USER_A.subject)).toHaveLength(0);
    expect(await rowsForUser(t, "entitlements", USER_A.subject)).toHaveLength(0);
    expect(await rowsForUser(t, "followedCountries", USER_A.subject)).toHaveLength(0);
    expect(await rowsForUser(t, "customers", USER_A.subject)).toHaveLength(0);

    expect(await rowsForUser(t, "users", USER_B.subject)).toHaveLength(1);
    expect(await rowsForUser(t, "userPreferences", USER_B.subject)).toHaveLength(1);
    expect(await rowsForUser(t, "followedCountries", USER_B.subject)).toHaveLength(1);
    expect(await rawCountryCount(t, "US")).toBe(1);

    const payments = await t.run(async (ctx) => ctx.db.query("paymentEvents").collect());
    const retained = payments.find((event) => event.dodoPaymentId === `pay_${USER_A.subject}`);
    expect(retained).toBeTruthy();
    expect(retained?.userId).toBe(tombstone);
    expect(retained?.amount).toBe(2900);
    const payload = retained?.rawPayload as {
      customer?: { email?: string; name?: string; customer_id?: string };
      email?: string;
    };
    expect(payload.email).toBeUndefined();
    expect(payload.customer?.email).toBeUndefined();
    expect(payload.customer?.name).toBeUndefined();
    expect(payload.customer?.customer_id).toBe(`cus_${USER_A.subject}`);

    const customers = await t.run(async (ctx) => ctx.db.query("customers").collect());
    const anonymized = customers.find((item) => item.dodoCustomerId === `cus_${USER_A.subject}`);
    expect(anonymized?.userId).toBe(tombstone);
    expect(anonymized?.email).toBe(tombstone);
    expect(anonymized?.normalizedEmail).toBe(tombstone);

    const registrations = await t.run(async (ctx) =>
      ctx.db
        .query("registrations")
        .withIndex("by_normalized_email", (q) =>
          q.eq("normalizedEmail", USER_A.email.toLowerCase()),
        )
        .collect(),
    );
    expect(registrations).toHaveLength(0);
    const contacts = await t.run(async (ctx) =>
      ctx.db
        .query("contactMessages")
        .withIndex("by_normalized_email_received", (q) =>
          q.eq("normalizedEmail", USER_A.email.toLowerCase()),
        )
        .collect(),
    );
    expect(contacts).toHaveLength(0);
    const suppressions = await t.run(async (ctx) =>
      ctx.db
        .query("emailSuppressions")
        .withIndex("by_normalized_email", (q) =>
          q.eq("normalizedEmail", USER_A.email.toLowerCase()),
        )
        .collect(),
    );
    expect(suppressions).toHaveLength(1);

    const cmAccounts = await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAccounts").collect(),
    );
    expect(cmAccounts.some((account) => account.terminalReason === "owner_deleted")).toBe(true);
    expect(cmAccounts.every((account) => account.ownerUserId !== USER_A.subject)).toBe(true);
  });

  test("second erase is already-deleted", async () => {
    const t = await makeT();
    await seedUser(t, USER_A);
    const first = await t.mutation(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: USER_A.subject,
      source: "support",
    });
    await drainErase(t);
    expect((await deletionRow(t, USER_A.subject))?.status).toBe("complete");

    const second = await t.mutation(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: USER_A.subject,
      source: "support",
    });
    expect(second).toEqual({
      status: "already_deleted",
      userIdHash: first.userIdHash,
    });
    const rows = await t.run(async (ctx) => ctx.db.query("accountDeletions").collect());
    expect(rows).toHaveLength(1);
  });

  test("every erase creates a Company Monitoring denied fence even without a prior account", async () => {
    const t = await makeT();
    await t.mutation(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: "user_never_used_cm",
      source: "support",
    });
    await drainErase(t);
    const accounts = await t.run(async (ctx) =>
      ctx.db.query("companyMonitoringAccounts").collect(),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      lifecycle: "denied",
      terminalReason: "owner_deleted",
    });
    expect(accounts[0]?.ownerUserId).toBeUndefined();
  });
});

describe("account deletion — business seats", () => {
  test("invitee delete removes their grant and leaves the owner subscription", async () => {
    const t = await makeT();
    await seedUser(t, OWNER);
    await seedUser(t, INVITEE);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: OWNER.subject,
        dodoSubscriptionId: "sub_owner_keep",
        dodoProductId: "pdt_business",
        planKey: "api_business",
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        rawPayload: { customer: { email: OWNER.email } },
        updatedAt: now,
      });
      await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: "sub_owner_keep",
        ownerUserId: OWNER.subject,
        inviteeEmail: INVITEE.email.toLowerCase(),
        domain: "acme.test",
        status: "accepted",
        inviteeUserId: INVITEE.subject,
        createdAt: now,
        acceptedAt: now,
        expiresAt: now + 14 * 24 * 60 * 60 * 1000,
      });
    });

    await t.mutation(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: INVITEE.subject,
      source: "support",
    });
    await drainErase(t);

    const grants = await t.run(async (ctx) => ctx.db.query("businessProGrants").collect());
    expect(grants).toHaveLength(0);
    const ownerSubs = await rowsForUser(t, "subscriptions", OWNER.subject);
    expect(ownerSubs).toHaveLength(1);
    expect(ownerSubs[0]).toMatchObject({
      userId: OWNER.subject,
      dodoSubscriptionId: "sub_owner_keep",
      status: "active",
    });
    expect(await rowsForUser(t, "users", OWNER.subject)).toHaveLength(1);
  });

  test("owner delete removes grants and anonymizes the owner subscription", async () => {
    const t = await makeT();
    await seedUser(t, OWNER);
    await seedUser(t, INVITEE);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: OWNER.subject,
        dodoSubscriptionId: "sub_owner_erase",
        dodoProductId: "pdt_business",
        planKey: "api_business",
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        rawPayload: { customer: { email: OWNER.email, customer_id: "cus_owner" } },
        updatedAt: now,
      });
      await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: "sub_owner_erase",
        ownerUserId: OWNER.subject,
        inviteeEmail: INVITEE.email.toLowerCase(),
        domain: "acme.test",
        status: "pending",
        createdAt: now,
        expiresAt: now + 14 * 24 * 60 * 60 * 1000,
      });
      await ctx.db.insert("dunningEmails", {
        dodoSubscriptionId: "sub_owner_erase",
        step: "dunning_day0",
        episodeAt: now,
        email: OWNER.email,
        sentAt: now,
      });
    });

    await t.mutation(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: OWNER.subject,
      source: "support",
    });
    await drainErase(t);

    const hash = await sha256Hex(OWNER.subject);
    const tombstone = tombstoneUserId(hash);
    const grants = await t.run(async (ctx) => ctx.db.query("businessProGrants").collect());
    expect(grants).toHaveLength(0);
    expect(await rowsForUser(t, "subscriptions", OWNER.subject)).toHaveLength(0);
    const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
    expect(subs).toHaveLength(1);
    expect(subs[0]?.userId).toBe(tombstone);
    expect(subs[0]?.dodoSubscriptionId).toBe("sub_owner_erase");
    const raw = subs[0]?.rawPayload as { customer?: { email?: string; customer_id?: string } };
    expect(raw.customer?.email).toBeUndefined();
    expect(raw.customer?.customer_id).toBe("cus_owner");
    const dunning = await t.run(async (ctx) => ctx.db.query("dunningEmails").collect());
    expect(dunning[0]?.email).toBe(tombstone);
    expect(await rowsForUser(t, "users", INVITEE.subject)).toHaveLength(1);
  });
});
