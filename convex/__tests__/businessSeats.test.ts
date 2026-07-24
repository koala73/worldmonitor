/**
 * Tests for business seat invites (#4634/#4635).
 *
 * Covers the invite-issuance surface: owner must be an active/covering
 * api_business subscriber on a corporate domain; invitees must share that
 * domain; cap of 4 active-or-pending grants; self-invite and duplicates are
 * rejected.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER_ID = "user_business_owner";
const OWNER_IDENTITY = {
  subject: OWNER_ID,
  tokenIdentifier: `clerk|${OWNER_ID}`,
  email: "owner@acme.com",
};
const SIGNING_SECRET = "test-business-invite-signing-secret";

afterEach(() => {
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.RESEND_API_KEY;
  vi.useRealTimers();
});

async function seedBusinessSubscription(
  t: ReturnType<typeof convexTest>,
  opts: {
    dodoSubscriptionId: string;
    status: "active" | "on_hold" | "cancelled" | "expired";
    currentPeriodEnd: number;
    ownerUserId?: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: opts.ownerUserId ?? OWNER_ID,
      dodoSubscriptionId: opts.dodoSubscriptionId,
      dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId!,
      planKey: "api_business",
      status: opts.status,
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: opts.currentPeriodEnd,
      rawPayload: {},
      updatedAt: NOW,
    });
  });
}

async function seedEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  planKey: string,
  validUntil: number,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey,
      features: getFeaturesForPlan(planKey),
      validUntil,
      updatedAt: NOW,
    });
  });
}

describe("payments businessSeats inviteSeats", () => {
  test("happy path: 4 same-domain invites → 4 pending grants + 4 emails scheduled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    process.env.RESEND_API_KEY = "test-resend-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-ok" }), { status: 200 }),
    );
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_001",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    const emails = ["a@acme.com", "b@acme.com", "c@acme.com", "d@acme.com"];
    const result = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails },
    );

    expect(result.invited).toHaveLength(4);
    for (const item of result.invited) {
      expect(item.status).toBe("created");
    }

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", "sub_business_001"),
        )
        .collect(),
    );
    expect(grants).toHaveLength(4);
    expect(grants.every((g) => g.status === "pending")).toBe(true);
    expect(grants.every((g) => g.domain === "acme.com")).toBe(true);
    expect(grants.every((g) => g.expiresAt === NOW + 14 * DAY_MS)).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes("resend.com"))).toBe(true);
    fetchMock.mockRestore();
    vi.useRealTimers();
  });

  test("5th invite → SEAT_CAP_REACHED", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_002",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["a@acme.com", "b@acme.com", "c@acme.com", "d@acme.com", "e@acme.com"],
      }),
    ).rejects.toThrow(/SEAT_CAP_REACHED|TOO_MANY_EMAILS/);
  });

  test("cross-domain invitee → INVITEE_DOMAIN_MISMATCH", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_003",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["teammate@other.com"],
      }),
    ).rejects.toThrow(/INVITEE_DOMAIN_MISMATCH/);
  });

  test("free-domain owner → OWNER_DOMAIN_NOT_CORPORATE", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_004",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await expect(
      t
        .withIdentity({ ...OWNER_IDENTITY, email: "owner@gmail.com" })
        .mutation(api.payments.businessSeats.inviteSeats, {
          emails: ["teammate@acme.com"],
        }),
    ).rejects.toThrow(/OWNER_DOMAIN_NOT_CORPORATE/);
  });

  test("self-invite → CANNOT_INVITE_SELF", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_005",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["owner@acme.com"],
      }),
    ).rejects.toThrow(/CANNOT_INVITE_SELF/);
  });

  test("duplicate pending invite is idempotent", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_006",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    const first = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    expect(first.invited[0].status).toBe("created");

    const second = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    expect(second.invited[0].status).toBe("already_pending");

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", "sub_business_006"),
        )
        .collect(),
    );
    expect(grants).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("non-Business owner → OWNER_NOT_BUSINESS", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, OWNER_ID, "pro_monthly", NOW + 30 * DAY_MS);

    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["teammate@acme.com"],
      }),
    ).rejects.toThrow(/OWNER_NOT_BUSINESS/);
  });

  test("lapsed Business owner → OWNER_NOT_BUSINESS", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_007",
      status: "expired",
      currentPeriodEnd: NOW - DAY_MS,
    });

    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["teammate@acme.com"],
      }),
    ).rejects.toThrow(/OWNER_NOT_BUSINESS/);
  });

  test("listSeats returns grants for the owner", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_008",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
      emails: ["teammate@acme.com"],
    });

    const result = await t.withIdentity(OWNER_IDENTITY).query(
      api.payments.businessSeats.listSeats,
      {},
    );
    expect(result.businessSubscriptionId).toBe("sub_business_008");
    expect(result.seats).toHaveLength(1);
    expect(result.seats[0].inviteeEmail).toBe("teammate@acme.com");
    expect(result.seats[0].status).toBe("pending");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("listSeats returns empty for non-Business owner", async () => {
    const t = convexTest(schema, modules);
    const result = await t.withIdentity(OWNER_IDENTITY).query(
      api.payments.businessSeats.listSeats,
      {},
    );
    expect(result.businessSubscriptionId).toBeNull();
    expect(result.seats).toHaveLength(0);
  });

  test("removeSeat revokes a pending grant", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_009",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    const grantId = invite.invited[0].grantId;

    await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.removeSeat, {
      grantId,
    });

    const grant = await t.run(async (ctx) => ctx.db.get(grantId as any));
    expect(grant?.status).toBe("revoked");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("removeSeat rejects non-owner", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_010",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    const grantId = invite.invited[0].grantId;

    await expect(
      t
        .withIdentity({ subject: "user_intruder", tokenIdentifier: "clerk|user_intruder" })
        .mutation(api.payments.businessSeats.removeSeat, { grantId }),
    ).rejects.toThrow(/NOT_OWNER/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
