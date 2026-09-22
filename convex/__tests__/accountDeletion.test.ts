import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  company,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  modules,
  schema,
} from "./companyMonitoring.helpers";
import {
  ACCOUNT_DELETION_REGISTRY,
  sha256Hex,
  tombstoneUserId,
} from "../accountDeletion/registry";
import { PERSONAL_DELETE_TABLES } from "../accountDeletion/batches";

const { dodoUpdateMock } = vi.hoisted(() => ({
  dodoUpdateMock: vi.fn(async () => ({ status: "cancelled" })),
}));

vi.mock("dodopayments", () => {
  class NotFoundError extends Error {
    status = 404;
  }
  class APIConnectionTimeoutError extends Error {
    constructor(message = "timeout") {
      super(message);
      this.name = "APIConnectionTimeoutError";
    }
  }
  return {
    DodoPayments: class {
      subscriptions = { update: dodoUpdateMock };
    },
    APIConnectionError: class extends Error {},
    NotFoundError,
    APIConnectionTimeoutError,
  };
});

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

const fetchCalls: string[] = [];

function hostnameOf(urlLike: string): string | null {
  try {
    return new URL(urlLike).hostname;
  } catch {
    return null;
  }
}

function isClerkApiUrl(urlLike: string): boolean {
  return hostnameOf(urlLike) === "api.clerk.com";
}

function fetchCallTargetsClerkApi(call: string): boolean {
  const match = /\s(https?:\/\/\S+)/.exec(call);
  return match != null && isClerkApiUrl(match[1]!);
}

async function makeT() {
  fetchCalls.length = 0;
  dodoUpdateMock.mockReset();
  dodoUpdateMock.mockResolvedValue({ status: "cancelled" });
  process.env.CLERK_SECRET_KEY = "sk_test_account_deletion";
  process.env.DODO_API_KEY = "ddp_test_account_deletion";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    fetchCalls.push(`${init?.method ?? "POST"} ${url} ${body}`.trim());
    if (isClerkApiUrl(url)) {
      if (init?.method !== "DELETE") {
        const userId = new URL(url).pathname.split("/").at(-1);
        const identity = [USER_A, USER_B, OWNER, INVITEE].find(user => user.subject === userId);
        if (identity) return Response.json({ id: userId, primary_email_address_id: "primary", email_addresses: [
          { id: "primary", email_address: identity.email, verification: { status: "verified" } },
        ] });
      }
      return new Response("gone", { status: 404 });
    }
    if (url.includes("upstash.test")) {
      if (url.includes("/get/")) {
        return Response.json({
          result: JSON.stringify({ issueSlot: "2026-09-21-1200" }),
        });
      }
      return Response.json(
        url.includes("/pipeline")
          ? [{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]
          : { result: "OK" },
      );
    }
    return new Response(`unexpected fetch ${url}`, { status: 500 });
  });
  const t = convexTest(schema, modules);
  await t.mutation(internal.followedCountries._seedShards, {});
  await t.mutation(internal.followedCountries._seedCountryLocks, {});
  return t;
}

afterEach(() => {
  dodoUpdateMock.mockReset();
  vi.unstubAllGlobals();
  fetchCalls.length = 0;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.DODO_API_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

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
      t.action(api.accountDeletion.erase.requestAccountDeletion, {}),
    ).rejects.toThrow("AUTH_REQUIRED");
  });
});

describe("account deletion — eraseConfirmedUser identity", () => {
  test("support rejects a missing userId", async () => {
    const t = await makeT();
    await expect(
      t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
        userId: "",
        source: "support",
      }),
    ).rejects.toThrow("USER_ID_REQUIRED");
  });

  test("email is not an accepted argument", async () => {
    const t = await makeT();
    await expect(
      t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
        userId: USER_A.subject,
        source: "support",
        email: USER_A.email,
      } as never),
    ).rejects.toThrow(/Unexpected field `email`/);
  });
});

describe("account deletion — Convex cascade", () => {
  test("self-delete erases the caller only and retains billing evidence", async () => {
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
      .action(api.accountDeletion.erase.requestAccountDeletion, {});
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
      metadata?: Record<string, unknown>;
    };
    expect(payload.customer?.email).toBe(USER_A.email);
    expect(payload.customer?.name).toBe("Alice Example");
    expect(payload.metadata).toBeUndefined();
    expect(payload.customer?.customer_id).toBe(`cus_${USER_A.subject}`);

    const customers = await t.run(async (ctx) => ctx.db.query("customers").collect());
    const anonymized = customers.find((item) => item.dodoCustomerId === `cus_${USER_A.subject}`);
    expect(anonymized?.userId).toBe(tombstone);
    expect(anonymized?.email).toBe(USER_A.email);
    expect(anonymized?.normalizedEmail).toBe(USER_A.email.toLowerCase());

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
    const first = await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: USER_A.subject,
      source: "support",
    });
    await drainErase(t);
    expect((await deletionRow(t, USER_A.subject))?.status).toBe("complete");

    const second = await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
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
    await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
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

    await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
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

  test("owner delete removes grants and retains the owner subscription evidence", async () => {
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

    await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
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
    expect(raw.customer?.email).toBe(OWNER.email);
    expect(raw.customer?.customer_id).toBe("cus_owner");
    const dunning = await t.run(async (ctx) => ctx.db.query("dunningEmails").collect());
    expect(dunning[0]?.email).toBe(OWNER.email);
    expect(await rowsForUser(t, "users", INVITEE.subject)).toHaveLength(1);
  });
});

describe("account deletion — external side effects", () => {
  test("Dodo cancel then Clerk 404 still completes and captures key hashes", async () => {
    const t = await makeT();
    await seedUser(t, USER_A);
    const now = Date.now();
    const tokenId = await t.run(async (ctx) => {
      await ctx.db.insert("userApiKeys", {
        userId: USER_A.subject,
        name: "erase-key",
        keyPrefix: "wm_erase1",
        keyHash: "b".repeat(64),
        createdAt: now,
      });
      await ctx.db.insert("embedKeys", {
        userId: USER_A.subject,
        name: "erase-embed",
        keyPrefix: "wme_erase",
        keyHash: "c".repeat(64),
        createdAt: now,
      });
      await ctx.db.insert("subscriptions", {
        userId: USER_A.subject,
        dodoSubscriptionId: "sub_erase_dodo",
        dodoProductId: "pdt_pro",
        planKey: "pro",
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        rawPayload: {},
        updatedAt: now,
      });
      return ctx.db.insert("mcpProTokens", {
        userId: USER_A.subject,
        createdAt: now,
      });
    });

    await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: USER_A.subject,
      source: "support",
    });
    await drainErase(t);

    const row = await deletionRow(t, USER_A.subject);
    expect(row?.status).toBe("complete");
    expect(row?.keyHashes).toContain("b".repeat(64));
    expect(row?.embedKeyHashes).toContain("c".repeat(64));
    expect(row?.mcpTokenIds).toContain(String(tokenId));
    expect(row?.cancelledDodoSubscriptionIds).toContain("sub_erase_dodo");
    expect(dodoUpdateMock).toHaveBeenCalledWith("sub_erase_dodo", { status: "cancelled" });
    expect(fetchCalls.some((call) => call.includes("api.clerk.com/v1/users/user_deletion_a"))).toBe(true);
    expect(fetchCalls.some((call) => call.includes("entitlements:test:user_deletion_a"))).toBe(true);
    expect(fetchCalls.some((call) => call.includes(`pro-mcp-token-neg:${String(tokenId)}`))).toBe(true);
    expect(fetchCalls.some((call) => call.includes("brief:latest:user_deletion_a"))).toBe(true);
    expect(fetchCalls.some((call) => call.includes("brief:user_deletion_a:2026-09-21-1200"))).toBe(true);
    expect(await t.query(internal.mcpProTokens.validateProMcpToken, { tokenId })).toBeNull();
  });

  test("Dodo timeout records last error and retries without double-cancel", async () => {
    const t = await makeT();
    const { APIConnectionTimeoutError } = await import("dodopayments");
    dodoUpdateMock
      .mockRejectedValueOnce(new APIConnectionTimeoutError("provider timeout"))
      .mockResolvedValue({ status: "cancelled" });
    await seedUser(t, USER_A);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: USER_A.subject,
        dodoSubscriptionId: "sub_timeout_once",
        dodoProductId: "pdt_pro",
        planKey: "pro",
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        rawPayload: {},
        updatedAt: now,
      });
    });

    await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: USER_A.subject,
      source: "support",
    });
    await drainErase(t);

    expect(dodoUpdateMock).toHaveBeenCalledTimes(2);
    expect(dodoUpdateMock.mock.calls.every((call) => call[0] === "sub_timeout_once")).toBe(true);
    const row = await deletionRow(t, USER_A.subject);
    expect(row?.status).toBe("complete");
    expect(row?.cancelledDodoSubscriptionIds).toEqual(["sub_timeout_once"]);
  });

  test("Redis delete is attempted even when Clerk delete fails, then Clerk is retried", async () => {
    const t = await makeT();
    let clerkCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      const body = typeof init?.body === "string" ? init.body : "";
      fetchCalls.push(`${init?.method ?? "POST"} ${url} ${body}`.trim());
      if (isClerkApiUrl(url)) {
        if (init?.method !== "DELETE") return Response.json({
          id: USER_A.subject, primary_email_address_id: "primary", email_addresses: [
            { id: "primary", email_address: USER_A.email, verification: { status: "verified" } },
          ],
        });
        clerkCalls += 1;
        if (clerkCalls === 1) return new Response("busy", { status: 500 });
        return new Response("gone", { status: 404 });
      }
      if (url.includes("upstash.test")) {
        if (url.includes("/get/")) {
          return Response.json({ result: JSON.stringify({ issueSlot: "2026-09-21-1200" }) });
        }
        return Response.json(url.includes("/pipeline") ? Array.from({ length: 5 }, () => ({ result: 1 })) : { result: "OK" });
      }
      return new Response("unexpected", { status: 500 });
    });
    await seedUser(t, USER_A);
    await t.action(internal.accountDeletion.erase.eraseConfirmedUser, {
      userId: USER_A.subject,
      source: "support",
    });
    await drainErase(t);

    expect(clerkCalls).toBeGreaterThanOrEqual(2);
    const firstRedis = fetchCalls.findIndex((call) => call.includes("upstash.test"));
    const firstClerk = fetchCalls.findIndex((call) => call.startsWith("DELETE ") && fetchCallTargetsClerkApi(call));
    expect(firstRedis).toBeGreaterThanOrEqual(0);
    expect(firstClerk).toBeGreaterThan(firstRedis);
    expect((await deletionRow(t, USER_A.subject))?.status).toBe("complete");
  });
});


describe("account deletion — verified email ownership", () => {
  async function seedEmailRows(t: Awaited<ReturnType<typeof makeT>>, email: string) {
    return t.run(async ctx => ctx.db.insert("contactMessages", {
      name: "Other person", email, normalizedEmail: email,
      source: "contact", receivedAt: Date.now(),
    }));
  }

  function mockCurrentEmail(email: string, verified: boolean) {
    const defaultFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (isClerkApiUrl(String(input)) && init?.method !== "DELETE") {
        return Promise.resolve(Response.json({ id: USER_A.subject,
          primary_email_address_id: "primary", email_addresses: [{ id: "primary",
            email_address: email, verification: { status: verified ? "verified" : "unverified" },
          }],
        }));
      }
      return defaultFetch(input, init);
    });
  }

  test("unverified Clerk email cannot erase email-only records even with cached profile and JWT email", async () => {
    const t = await makeT();
    await seedUser(t, USER_A);
    const victim = await seedEmailRows(t, USER_A.email);
    mockCurrentEmail(USER_A.email, false);
    await t.withIdentity({ ...USER_A, emailVerified: true })
      .action(api.accountDeletion.erase.requestAccountDeletion, {});
    await drainErase(t);
    expect(await t.run(ctx => ctx.db.get(victim))).not.toBeNull();
    expect((await deletionRow(t, USER_A.subject))?.status).toBe("complete");
  });

  test.each(["self", "support"] as const)("%s uses current verified Clerk email instead of stale cached or token email", async source => {
    const t = await makeT();
    await seedUser(t, USER_A);
    const stale = await seedEmailRows(t, USER_A.email);
    const current = await seedEmailRows(t, "current@example.com");
    mockCurrentEmail("current@example.com", true);
    if (source === "self") await t.withIdentity(USER_A).action(api.accountDeletion.erase.requestAccountDeletion, {});
    else await t.action(internal.accountDeletion.erase.eraseConfirmedUser, { userId: USER_A.subject, source });
    await drainErase(t);
    expect(await t.run(ctx => ctx.db.get(stale))).not.toBeNull();
    expect(await t.run(ctx => ctx.db.get(current))).toBeNull();
  });

  test("webhook-only deletion never treats a cached profile email as ownership proof", async () => {
    const t = await makeT();
    await seedUser(t, USER_A);
    const victim = await seedEmailRows(t, USER_A.email);
    await t.mutation(internal.accountDeletion.erase.ingestClerkUserDeleted, {
      userId: USER_A.subject, webhookId: "verified-proof-webhook",
    });
    await drainErase(t);
    expect(await t.run(ctx => ctx.db.get(victim))).not.toBeNull();
    const event = await t.run(ctx => ctx.db.query("webhookEvents").first());
    expect(JSON.stringify(event?.rawPayload)).not.toContain(USER_A.subject);
  });

  test("failed Clerk ownership lookup stops before any deletion", async () => {
    const t = await makeT();
    await seedUser(t, USER_A);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 503 })));
    await expect(t.withIdentity(USER_A).action(api.accountDeletion.erase.requestAccountDeletion, {}))
      .rejects.toThrow("EMAIL_VERIFICATION_UNAVAILABLE");
    expect(await deletionRow(t, USER_A.subject)).toBeNull();
    expect(await rowsForUser(t, "users", USER_A.subject)).toHaveLength(1);
  });
});

describe("account deletion — continuation ownership", () => {
  test("repeated pending requests do not start duplicate workers; failed requests can resume", async () => {
    const t = await makeT();
    const deletionId = await t.run(ctx => ctx.db.insert("accountDeletions", {
      userId: USER_A.subject, userIdHash: "hash-a", source: "self", status: "pending",
      step: "external", externalAttempts: 3, startedAt: Date.now(), updatedAt: Date.now(),
    }));
    const before = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    await t.withIdentity(USER_A).action(api.accountDeletion.erase.requestAccountDeletion, {});
    const after = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(after.length).toBe(before.length);
    expect((await t.run(ctx => ctx.db.get(deletionId)))?.externalAttempts).toBe(3);
    await t.run(ctx => ctx.db.patch(deletionId, { status: "failed", externalAttempts: 5 }));
    await t.withIdentity(USER_A).action(api.accountDeletion.erase.requestAccountDeletion, {});
    expect((await t.run(ctx => ctx.db.get(deletionId)))?.externalAttempts).toBe(0);
    await drainErase(t);
    expect((await t.run(ctx => ctx.db.get(deletionId)))?.status).toBe("complete");
  });

  test("an external action cannot complete before a newly discovered subscription is cancelled", async () => {
    const t = await makeT();
    const deletionId = await t.run(ctx => ctx.db.insert("accountDeletions", {
      userId: USER_A.subject, userIdHash: "hash-a", source: "self", status: "pending",
      step: "external", dodoSubscriptionIds: ["sub-first", "sub-late"],
      cancelledDodoSubscriptionIds: ["sub-first"], startedAt: Date.now(), updatedAt: Date.now(),
    }));
    expect(await t.mutation(internal.accountDeletion.erase.markExternalComplete, { deletionId }))
      .toMatchObject({ status: "pending" });
    await drainErase(t);
    expect(dodoUpdateMock).toHaveBeenCalledWith("sub-late", { status: "cancelled" });
    expect(dodoUpdateMock).not.toHaveBeenCalledWith("sub-first", expect.anything());
    expect((await t.run(ctx => ctx.db.get(deletionId)))?.status).toBe("complete");
  });
});

describe("webhook deletions record and can repair the email-keyed gap", () => {
  // A user.deleted webhook arrives after Clerk destroyed the subject, so there
  // is no verified address to attribute waitlist/contact rows with. Matching on
  // a cached address could delete a third party's records, so the engine skips
  // -- but skipping silently made the gap permanent and invisible.
  async function seedEmailKeyedRows(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("registrations", {
        email: USER_A.email,
        normalizedEmail: USER_A.email,
        registeredAt: Date.now(),
      });
      await ctx.db.insert("contactMessages", {
        name: "Alice", email: USER_A.email, source: "test",
        receivedAt: Date.now(), normalizedEmail: USER_A.email,
      });
    });
  }

  test("a webhook deletion records the skip instead of completing silently", async () => {
    const t = await makeT();
    await seedEmailKeyedRows(t);
    await t.mutation(internal.accountDeletion.erase.ingestClerkUserDeleted, {
      webhookId: "clerk:evt_gap", userId: USER_A.subject,
    });
    await drainErase(t);

    const row = await t.query(
      internal.accountDeletion.erase.getDeletionStatusForOperator,
      { userId: USER_A.subject },
    );
    expect(row?.emailKeyedSkipped).toBe(true);
    // The rows really are still there -- that is what the flag reports.
    expect(await t.run((ctx) => ctx.db.query("registrations").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("contactMessages").collect())).toHaveLength(1);
  });

  test("the repair command finishes the cleanup and clears the flag", async () => {
    const t = await makeT();
    await seedEmailKeyedRows(t);
    await t.mutation(internal.accountDeletion.erase.ingestClerkUserDeleted, {
      webhookId: "clerk:evt_gap", userId: USER_A.subject,
    });
    await drainErase(t);

    await t.mutation(internal.accountDeletion.batches.completeEmailKeyedErasure, {
      userId: USER_A.subject, verifiedEmail: USER_A.email.toUpperCase(),
    });
    await drainErase(t);

    expect(await t.run((ctx) => ctx.db.query("registrations").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("contactMessages").collect())).toHaveLength(0);
    const row = await t.query(
      internal.accountDeletion.erase.getDeletionStatusForOperator,
      { userId: USER_A.subject },
    );
    expect(row?.emailKeyedSkipped).toBeUndefined();
  });

  test("the repair command refuses an empty email and reports an unknown subject", async () => {
    const t = await makeT();
    await expect(
      t.mutation(internal.accountDeletion.batches.completeEmailKeyedErasure, {
        userId: USER_A.subject, verifiedEmail: "   ",
      }),
    ).rejects.toThrow(/VERIFIED_EMAIL_REQUIRED/);
    expect(await t.mutation(internal.accountDeletion.batches.completeEmailKeyedErasure, {
      userId: "user_never_deleted", verifiedEmail: USER_A.email,
    })).toMatchObject({ status: "missing" });
  });
});

describe("operator visibility into a failed deletion", () => {
  // The runbook tells support to "inspect lastError, then re-run". That step
  // had no command behind it: eraseConfirmedUser can only answer
  // pending/complete/already_deleted, and getOwnDeletionStatus authenticates
  // as the subject, who by then may not exist.
  test("the operator query reports a failed deletion and its error", async () => {
    const t = await makeT();
    await t.run((ctx) => ctx.db.insert("accountDeletions", {
      userId: USER_A.subject, userIdHash: "hash-a", source: "support",
      status: "failed", step: "external",
      lastError: "DODO_CANCEL:upstream refused",
      externalAttempts: 5, batchAttempts: 2,
      startedAt: Date.now() - 10, updatedAt: Date.now(),
    }));

    const row = await t.query(
      internal.accountDeletion.erase.getDeletionStatusForOperator,
      { userId: USER_A.subject },
    );
    expect(row).toMatchObject({
      status: "failed",
      step: "external",
      // The full provider text, not the reduced code the public query returns.
      lastError: "DODO_CANCEL:upstream refused",
      externalAttempts: 5,
      batchAttempts: 2,
    });
  });

  test("the operator query is null for a subject with no deletion", async () => {
    const t = await makeT();
    expect(await t.query(
      internal.accountDeletion.erase.getDeletionStatusForOperator,
      { userId: "user_never_requested" },
    )).toBeNull();
  });
});

/**
 * The registry's header comment claims a closed world: "Every user-scoped
 * Convex table must appear here ... adding a table means updating both files."
 * Nothing enforced that — ACCOUNT_DELETION_REGISTRY was declared once and
 * imported nowhere, while batches.ts erased from its own PERSONAL_DELETE_TABLES
 * — so the two could drift silently and a new user-scoped table could ship with
 * no erasure decision at all. These tests are what make the claim true.
 */
describe("account deletion registry is enforced, not documentation", () => {
  // Registry targets that name an external system rather than a Convex table.
  const EXTERNAL_TARGET_PREFIXES = ["redis:", "clerk.", "dodo.", "workos."];

  // `delete` targets erased by a dedicated stepper instead of the generic
  // personal-table walk. Adding one here is a deliberate, reviewable act.
  const DEDICATED_DELETE_STEPS = new Set([
    "followedCountries",          // eraseFollows: also decrements country aggregates
    "businessProGrants",          // eraseGrants: owner vs invitee, recomputes seats
    "proActivationPresentations", // anonymizeBilling: swept alongside billing rows
    "registrations",              // eraseEmailKeyed: verified-email keyed
    "contactMessages",            // eraseEmailKeyed: verified-email keyed
  ]);

  const isExternal = (target: string): boolean =>
    EXTERNAL_TARGET_PREFIXES.some((prefix) => target.startsWith(prefix));

  const registryTables = new Set(
    ACCOUNT_DELETION_REGISTRY.filter((e) => !isExternal(e.target)).map((e) => e.target),
  );
  const schemaTables = Object.keys(schema.tables);

  test("every Convex table has an erasure decision in the registry", () => {
    // Guard the enumerator itself: if schema.tables ever came back empty, every
    // completeness assertion in this block would pass vacuously and the gate
    // would silently stop gating (docs/solutions/design-patterns/
    // closed-world-classification-gate-for-config-completeness.md).
    expect(schemaTables.length).toBeGreaterThan(20);
    const undecided = schemaTables.filter((name) => !registryTables.has(name));
    expect(
      undecided,
      `These tables are in convex/schema.ts but have no ACCOUNT_DELETION_REGISTRY entry. `
      + `Add one with action delete, anonymize, retain, delegate, or skip — and if it is `
      + `delete, wire it into batches.ts too: ${undecided.join(", ")}`,
    ).toEqual([]);
  });

  test("every registry target names a real table or external system", () => {
    const known = new Set(schemaTables);
    const unknown = [...registryTables].filter((target) => !known.has(target));
    expect(
      unknown,
      `These ACCOUNT_DELETION_REGISTRY targets match no table in convex/schema.ts. `
      + `A renamed or dropped table leaves the registry asserting coverage it does not `
      + `have: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  test("every registry delete target is actually erased by a stepper", () => {
    const stepperTables = new Set<string>(PERSONAL_DELETE_TABLES);
    const orphaned = ACCOUNT_DELETION_REGISTRY
      .filter((e) => e.action === "delete" && !isExternal(e.target))
      .map((e) => e.target)
      .filter((target) => !stepperTables.has(target) && !DEDICATED_DELETE_STEPS.has(target));
    expect(
      orphaned,
      `The registry promises these tables are deleted, but no stepper erases them. `
      + `Add each to PERSONAL_DELETE_TABLES in batches.ts, or to DEDICATED_DELETE_STEPS `
      + `in this test if a dedicated step owns it: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  test("the generic stepper only erases tables the registry marks delete", () => {
    const byTarget = new Map(ACCOUNT_DELETION_REGISTRY.map((e) => [e.target, e.action]));
    const mismatched = PERSONAL_DELETE_TABLES
      .filter((table) => byTarget.get(table) !== "delete");
    expect(
      mismatched,
      `batches.ts erases these tables but the registry does not mark them delete. `
      + `One of the two is wrong: ${mismatched.join(", ")}`,
    ).toEqual([]);
  });

  test("every dedicated-step exemption is backed by real stepper code", () => {
    // DEDICATED_DELETE_STEPS is the one hand-maintained escape hatch in this
    // gate: listing a table there exempts it from the PERSONAL_DELETE_TABLES
    // cross-check. Untested, it would let a table be exempted with nothing
    // actually erasing it. Read the stepper source and require the table name
    // to appear in it, so the exemption has to be earned.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "../accountDeletion/batches.ts"),
      "utf8",
    );
    const unbacked = [...DEDICATED_DELETE_STEPS].filter(
      (table) => !source.includes(`"${table}"`),
    );
    expect(
      unbacked,
      `These tables are exempted from the stepper cross-check as "handled by a `
      + `dedicated step", but convex/accountDeletion/batches.ts never names them. `
      + `Either the exemption is stale or the erasure was never written: `
      + `${unbacked.join(", ")}`,
    ).toEqual([]);
  });

  test("webhookEvents carries the retention decision the docs now state", () => {
    const entry = ACCOUNT_DELETION_REGISTRY.find((e) => e.target === "webhookEvents");
    expect(entry?.action).toBe("retain");
    expect(entry?.notes).toMatch(/before the request/i);
  });
});
