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
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { getFeaturesForPlan } from "../lib/entitlements";
import { signBusinessInviteToken } from "../lib/identitySigning";

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

async function seedSubscription(
  t: ReturnType<typeof convexTest>,
  opts: {
    planKey: string;
    dodoProductId: string;
    status: "active" | "on_hold" | "cancelled" | "expired";
    currentPeriodEnd: number;
    suffix: string;
    userId?: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      userId: opts.userId ?? "user_other",
      dodoSubscriptionId: `sub_test_${opts.suffix}`,
      dodoProductId: opts.dodoProductId,
      planKey: opts.planKey,
      status: opts.status,
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: opts.currentPeriodEnd,
      rawPayload: {},
      updatedAt: NOW,
    });
  });
}

async function seedAcceptedGrantWithInvitee(
  t: ReturnType<typeof convexTest>,
  opts: {
    businessSubscriptionId: string;
    inviteeUserId: string;
    inviteeEmail: string;
    domain: string;
    ownerUserId?: string;
  },
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("businessProGrants", {
      businessSubscriptionId: opts.businessSubscriptionId,
      ownerUserId: opts.ownerUserId ?? OWNER_ID,
      inviteeEmail: opts.inviteeEmail,
      domain: opts.domain,
      status: "accepted",
      inviteeUserId: opts.inviteeUserId,
      createdAt: now,
      acceptedAt: now,
      expiresAt: now + 14 * DAY_MS,
    });
    await ctx.db.insert("entitlements", {
      userId: opts.inviteeUserId,
      planKey: "pro_monthly",
      features: getFeaturesForPlan("pro_monthly"),
      validUntil: now + 30 * DAY_MS,
      updatedAt: now,
    });
  });
}

async function seedProductPlan(
  t: ReturnType<typeof convexTest>,
  dodoProductId: string,
  planKey: string,
  displayName: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", {
      dodoProductId,
      planKey,
      displayName,
      isActive: true,
    });
  });
}

async function fireWebhook(
  t: ReturnType<typeof convexTest>,
  opts: {
    eventType: string;
    dodoSubscriptionId: string;
    status: string;
    eventTimestamp: number;
    cancelledAt?: number;
    productId?: string;
  },
) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `msg_test_${opts.dodoSubscriptionId}_${opts.eventType}_${Math.random().toString(36).slice(2, 6)}`,
    eventType: opts.eventType,
    rawPayload: {
      type: opts.eventType,
      data: {
        subscription_id: opts.dodoSubscriptionId,
        product_id: opts.productId ?? PRODUCT_CATALOG.api_business.dodoProductId!,
        status: opts.status,
        customer: { customer_id: "cus_test" },
        metadata: { wm_user_id: OWNER_ID },
        previous_billing_date: new Date(NOW - DAY_MS).toISOString(),
        next_billing_date: new Date(NOW + 30 * DAY_MS).toISOString(),
        ...(opts.cancelledAt ? { cancelled_at: new Date(opts.cancelledAt).toISOString() } : {}),
      },
    },
    timestamp: opts.eventTimestamp,
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

  test("duplicate email within one inviteSeats call is deduped to a single grant", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_001b",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    const result = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["dupe@acme.com", "Dupe@Acme.com", "dupe@acme.com "] },
    );

    // All three entries normalize to the same email — one "created" result,
    // not three.
    expect(result.invited).toHaveLength(1);
    expect(result.invited[0].status).toBe("created");

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", "sub_business_001b"),
        )
        .collect(),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].inviteeEmail).toBe("dupe@acme.com");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
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

  test("duplicate re-invite at cap is idempotent, not SEAT_CAP_REACHED", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_cap_dup",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    // Fill all 4 seats.
    for (const email of ["a@acme.com", "b@acme.com", "c@acme.com", "d@acme.com"]) {
      await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: [email],
      });
    }

    // Re-inviting one of the 4 must be idempotent, not a cap error.
    const result = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["a@acme.com"] },
    );
    expect(result.invited[0].status).toBe("already_pending");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("re-inviting an already-accepted email is idempotent ('already_accepted')", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_already_accepted";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate",
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });

    const result = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    expect(result.invited[0].status).toBe("already_accepted");

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("owner identity without email → OWNER_EMAIL_UNAVAILABLE", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_no_email",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await expect(
      t
        .withIdentity({ subject: OWNER_ID, tokenIdentifier: `clerk|${OWNER_ID}` })
        .mutation(api.payments.businessSeats.inviteSeats, {
          emails: ["teammate@acme.com"],
        }),
    ).rejects.toThrow(/OWNER_EMAIL_UNAVAILABLE/);
  });

  test("empty/whitespace emails → NO_EMAILS_PROVIDED", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_empty_emails",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["", "   "],
      }),
    ).rejects.toThrow(/NO_EMAILS_PROVIDED/);
  });

  test("invitee free-domain → INVITEE_DOMAIN_NOT_CORPORATE", async () => {
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_free_invitee",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["friend@gmail.com"],
      }),
    ).rejects.toThrow(/INVITEE_DOMAIN_NOT_CORPORATE/);
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
    // Server-computed corporate-domain check, replacing the client's former
    // hardcoded (stale) free-domain list.
    expect(result.ownerDomain).toBe("acme.com");
    expect(result.ownerIsCorporateDomain).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("listSeats reports a lapsed pending grant as 'expired', not stale 'pending'", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_008b",
      status: "active",
      currentPeriodEnd: NOW + 60 * DAY_MS,
    });
    await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
      emails: ["teammate@acme.com"],
    });

    // Advance past the 14-day invite TTL without anything sweeping the row.
    vi.setSystemTime(NOW + 15 * DAY_MS);

    const result = await t.withIdentity(OWNER_IDENTITY).query(
      api.payments.businessSeats.listSeats,
      {},
    );
    expect(result.seats).toHaveLength(1);
    expect(result.seats[0].status).toBe("expired");

    // The stored row itself is untouched (listSeats computes, doesn't sweep) —
    // confirms this is a read-time projection, not a write.
    const storedGrant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", "sub_business_008b"),
        )
        .first(),
    );
    expect(storedGrant?.status).toBe("pending");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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

  test("removeSeat is idempotent — second call on an already-revoked grant returns status:'already_inactive'", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: "sub_business_011",
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    const grantId = invite.invited[0].grantId;

    const first = await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.removeSeat, {
      grantId,
    });
    // Discriminated status field on every response — consistent with
    // inviteSeats' always-present status enum, instead of an optional
    // `already` field only present on the no-op branch.
    expect(first).toEqual({ ok: true, status: "revoked" });

    const second = await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.removeSeat, {
      grantId,
    });
    expect(second).toEqual({ ok: true, status: "already_inactive" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("payments businessSeats acceptBusinessInvite", () => {
  async function seedPendingGrant(
    t: ReturnType<typeof convexTest>,
    opts: {
      businessSubscriptionId: string;
      inviteeEmail: string;
      domain: string;
      ownerUserId?: string;
      expiresAt?: number;
      status?: "pending" | "accepted" | "revoked" | "expired";
    },
  ) {
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: opts.businessSubscriptionId,
        ownerUserId: opts.ownerUserId ?? OWNER_ID,
        inviteeEmail: opts.inviteeEmail,
        domain: opts.domain,
        status: opts.status ?? "pending",
        createdAt: now,
        expiresAt: opts.expiresAt ?? now + 14 * DAY_MS,
      });
    });
  }

  test("valid accept → invitee gets Pro", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_001";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    const token = await signBusinessInviteToken(grant!._id);

    await t
      .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
      .mutation(api.payments.businessSeats.acceptBusinessInvite, {
        grantId: grant!._id,
        token,
      });

    const updated = await t.run(async (ctx) => ctx.db.get(grant!._id));
    expect(updated?.status).toBe("accepted");
    expect(updated?.inviteeUserId).toBe("user_teammate");
    expect(updated?.acceptedAt).toBe(NOW);

    const entitlement = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(entitlement?.planKey).toBe("pro_monthly");
    expect(entitlement?.validUntil).toBe(NOW + 30 * DAY_MS);
    vi.useRealTimers();
  });

  test("wrong-email accept → INVITE_EMAIL_MISMATCH", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_002";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    const token = await signBusinessInviteToken(grant!._id);

    await expect(
      t
        .withIdentity({ subject: "user_intruder", tokenIdentifier: "clerk|user_intruder", email: "intruder@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId: grant!._id,
          token,
        }),
    ).rejects.toThrow(/INVITE_EMAIL_MISMATCH/);
    vi.useRealTimers();
  });

  test("expired token → INVITE_EXPIRED", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_003";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
      expiresAt: NOW - DAY_MS,
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    const token = await signBusinessInviteToken(grant!._id);

    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId: grant!._id,
          token,
        }),
    ).rejects.toThrow(/INVITE_EXPIRED/);
    vi.useRealTimers();
  });

  test("replay of accepted invite → INVITE_ALREADY_USED", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_004";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
      status: "accepted",
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    const token = await signBusinessInviteToken(grant!._id);

    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId: grant!._id,
          token,
        }),
    ).rejects.toThrow(/INVITE_ALREADY_USED/);
    vi.useRealTimers();
  });

  test("accept when Business already lapsed → BUSINESS_NOT_ACTIVE", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_005";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "expired",
      currentPeriodEnd: NOW - DAY_MS,
    });
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    const token = await signBusinessInviteToken(grant!._id);

    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId: grant!._id,
          token,
        }),
    ).rejects.toThrow(/BUSINESS_NOT_ACTIVE/);
    vi.useRealTimers();
  });

  test("invalid token → INVALID_INVITE_TOKEN", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_006";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );

    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId: grant!._id,
          token: "v1.12345.invalidsignature",
        }),
    ).rejects.toThrow(/INVALID_INVITE_TOKEN/);
    vi.useRealTimers();
  });

  test("unknown grantId → GRANT_NOT_FOUND", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_007";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    // Create and delete a grant to get a valid-format ID that no longer exists.
    const grantId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("businessProGrants", {
        businessSubscriptionId: businessSubId,
        ownerUserId: OWNER_ID,
        inviteeEmail: "temp@acme.com",
        domain: "acme.com",
        status: "pending",
        createdAt: NOW,
        expiresAt: NOW + 14 * DAY_MS,
      });
      await ctx.db.delete(id);
      return id;
    });

    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId,
          token: "v1.12345.fake",
        }),
    ).rejects.toThrow(/GRANT_NOT_FOUND/);
    vi.useRealTimers();
  });

  test("identity without email → INVITEE_EMAIL_UNAVAILABLE", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_008";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    const token = await signBusinessInviteToken(grant!._id);

    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId: grant!._id,
          token,
        }),
    ).rejects.toThrow(/INVITEE_EMAIL_UNAVAILABLE/);
    vi.useRealTimers();
  });

  test("invitee free-domain at accept-time → INVITEE_DOMAIN_NOT_CORPORATE", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_accept_009";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    // Seed a pending grant whose invitee email is on a free domain (as if the
    // invite was created before the gate tightened, or via a direct DB write).
    await seedPendingGrant(t, {
      businessSubscriptionId: businessSubId,
      inviteeEmail: "friend@gmail.com",
      domain: "gmail.com",
    });
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    const token = await signBusinessInviteToken(grant!._id);

    await expect(
      t
        .withIdentity({ subject: "user_friend", tokenIdentifier: "clerk|user_friend", email: "friend@gmail.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, {
          grantId: grant!._id,
          token,
        }),
    ).rejects.toThrow(/INVITEE_DOMAIN_NOT_CORPORATE/);
    vi.useRealTimers();
  });
});

describe("payments businessSeats revoke-on-lapse", () => {
  test("Business expired → all grants revoked + invitees free", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.RESEND_API_KEY = "test-resend-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-ok" }), { status: 200 }),
    );
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_revoke_001";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate_1",
      inviteeEmail: "teammate1@acme.com",
      domain: "acme.com",
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate_2",
      inviteeEmail: "teammate2@acme.com",
      domain: "acme.com",
    });

    await fireWebhook(t, {
      eventType: "subscription.expired",
      dodoSubscriptionId: businessSubId,
      status: "expired",
      eventTimestamp: NOW + 1000,
    });

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants.every((g) => g.status === "revoked")).toBe(true);

    for (const invitee of ["user_teammate_1", "user_teammate_2"]) {
      const ent = await t.run(async (ctx) =>
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", invitee)).first(),
      );
      expect(ent?.planKey).toBe("free");
    }

    // Team-access-ended emails are scheduled for both revoked invitees.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sentTo = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body));
      return body.to?.[0];
    });
    expect(sentTo).toEqual(expect.arrayContaining(["teammate1@acme.com", "teammate2@acme.com"]));
    fetchMock.mockRestore();
    vi.useRealTimers();
  });

  test("cancelled-but-paid-through → grants persist until currentPeriodEnd, then revoked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_revoke_002";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate",
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });

    // Cancel while still paid-through: grants must persist.
    await fireWebhook(t, {
      eventType: "subscription.cancelled",
      dodoSubscriptionId: businessSubId,
      status: "cancelled",
      eventTimestamp: NOW + 1000,
      cancelledAt: NOW,
    });

    let grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants.every((g) => g.status === "accepted")).toBe(true);

    // Fast-forward past currentPeriodEnd and run the scheduled revoke.
    vi.setSystemTime(NOW + 31 * DAY_MS);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants.every((g) => g.status === "revoked")).toBe(true);

    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(ent?.planKey).toBe("free");
    vi.useRealTimers();
  });

  test("cancelled-but-paid-through, then renewed before the scheduled revoke fires → 'still covering' no-op leaves grants intact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_revoke_002b";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate_renewed",
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });

    // Cancel while still paid-through: schedules revokeBusinessProGrantsIfNotCovering
    // at the original currentPeriodEnd (NOW + 30d).
    await fireWebhook(t, {
      eventType: "subscription.cancelled",
      dodoSubscriptionId: businessSubId,
      status: "cancelled",
      eventTimestamp: NOW + 1000,
      cancelledAt: NOW,
    });

    // Owner renews before the scheduled revoke fires — subscription is
    // covering again by the time the scheduled mutation runs.
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", businessSubId))
        .unique();
      await ctx.db.patch(sub!._id, { status: "active", currentPeriodEnd: NOW + 60 * DAY_MS });
    });

    // Advance to when the ORIGINAL scheduled revoke was due to fire and run it.
    vi.setSystemTime(NOW + 31 * DAY_MS);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants.every((g) => g.status === "accepted")).toBe(true);

    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate_renewed")).first(),
    );
    expect(ent?.planKey).toBe("pro_monthly");
    vi.useRealTimers();
  });

  test("on_hold → grants persist through grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_revoke_003";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate",
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });

    await fireWebhook(t, {
      eventType: "subscription.on_hold",
      dodoSubscriptionId: businessSubId,
      status: "on_hold",
      eventTimestamp: NOW + 1000,
    });

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants.every((g) => g.status === "accepted")).toBe(true);
    vi.useRealTimers();
  });

  test("cancelled api_business with currentPeriodEnd already past → grants revoked synchronously", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_revoke_immediate";
    // Seed as cancelled with currentPeriodEnd already in the past so the
    // webhook handler's isCoveringAt check fails immediately.
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "cancelled",
      currentPeriodEnd: NOW - DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate",
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });

    await fireWebhook(t, {
      eventType: "subscription.cancelled",
      dodoSubscriptionId: businessSubId,
      status: "cancelled",
      eventTimestamp: NOW + 1000,
      cancelledAt: NOW - DAY_MS,
    });

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants.every((g) => g.status === "revoked")).toBe(true);

    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(ent?.planKey).toBe("free");
    vi.useRealTimers();
  });

  test("removeSeat → that invitee free, others unaffected", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_revoke_004";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate_1",
      inviteeEmail: "teammate1@acme.com",
      domain: "acme.com",
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate_2",
      inviteeEmail: "teammate2@acme.com",
      domain: "acme.com",
    });

    const grant1 = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .filter((q) => q.eq(q.field("inviteeUserId"), "user_teammate_1"))
        .first(),
    );

    await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.removeSeat, {
      grantId: grant1!._id,
    });

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    const revoked = grants.find((g) => g.inviteeUserId === "user_teammate_1");
    const accepted = grants.find((g) => g.inviteeUserId === "user_teammate_2");
    expect(revoked?.status).toBe("revoked");
    expect(accepted?.status).toBe("accepted");

    const ent1 = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate_1")).first(),
    );
    const ent2 = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate_2")).first(),
    );
    expect(ent1?.planKey).toBe("free");
    expect(ent2?.planKey).toBe("pro_monthly");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });

  test("owner downgrades off Business (plan_changed) → accepted grants revoked, invitees free", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.RESEND_API_KEY = "test-resend-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-ok" }), { status: 200 }),
    );
    const t = convexTest(schema, modules);
    await seedProductPlan(t, PRODUCT_CATALOG.api_starter.dodoProductId!, "api_starter", "API Starter");
    const businessSubId = "sub_business_downgrade_001";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate_1",
      inviteeEmail: "teammate1@acme.com",
      domain: "acme.com",
    });

    // Owner downgrades from api_business to api_starter — status/currentPeriodEnd
    // are untouched by this event, only planKey changes.
    await fireWebhook(t, {
      eventType: "subscription.plan_changed",
      dodoSubscriptionId: businessSubId,
      status: "active",
      eventTimestamp: NOW + 1000,
      productId: PRODUCT_CATALOG.api_starter.dodoProductId!,
    });

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", businessSubId))
        .unique(),
    );
    expect(sub?.planKey).toBe("api_starter");
    expect(sub?.status).toBe("active");

    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    expect(grant?.status).toBe("revoked");

    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate_1")).first(),
    );
    expect(ent?.planKey).toBe("free");

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.to).toEqual(["teammate1@acme.com"]);
    fetchMock.mockRestore();
    vi.useRealTimers();
  });

  test("acceptBusinessInvite defense-in-depth: rejects when the subscription's planKey is no longer api_business even though status/currentPeriodEnd still look covering", async () => {
    // Simulates the guard on businessSeats.ts's acceptBusinessInvite directly
    // (independent of the plan_changed revocation path above) — a subscription
    // row whose planKey changed without going through handleSubscriptionPlanChanged
    // (e.g. a future code path, a data migration, or a race) must still be
    // rejected by the BUSINESS_NOT_ACTIVE guard, not just by the primary
    // revoke-on-plan-change wiring.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_downgrade_003";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    const grantId = invite.invited[0].grantId;
    const token = await signBusinessInviteToken(grantId);

    // Directly flip planKey without touching status/currentPeriodEnd or the
    // grant — isCoveringAt alone would still say "covering".
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", businessSubId))
        .unique();
      await ctx.db.patch(sub!._id, { planKey: "api_starter" });
    });

    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, { grantId, token }),
    ).rejects.toThrow(/BUSINESS_NOT_ACTIVE/);

    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(ent).toBeNull();
    vi.useRealTimers();
  });

  test("pickBestAcceptedBusinessGrant defense-in-depth: an accepted grant stops conferring Pro once the parent sub's planKey leaves api_business, even though status/currentPeriodEnd still look covering", async () => {
    // Isolates the grant-resolution guard from the revocation wiring: the
    // grant row is left status:"accepted" (as if the revoke-on-plan-change
    // hook were somehow bypassed) and only the subscription's planKey is
    // flipped. recomputeEntitlementFromAllSubs must still downgrade the
    // invitee to free — proving the fix isn't solely dependent on the grant
    // itself being revoked.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_downgrade_004";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: businessSubId,
      inviteeUserId: "user_teammate_stale_grant",
      inviteeEmail: "teammate@acme.com",
      domain: "acme.com",
    });

    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", businessSubId))
        .unique();
      await ctx.db.patch(sub!._id, { planKey: "api_starter" });
    });

    await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, {
      userId: "user_teammate_stale_grant",
    });

    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate_stale_grant")).first(),
    );
    expect(ent?.planKey).toBe("free");

    // The grant row itself is untouched by this path (it's the resolution
    // guard, not a revocation pass) — confirms this is a distinct safety net
    // from the revoke-on-plan-change wiring, not a duplicate of it.
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .first(),
    );
    expect(grant?.status).toBe("accepted");
    vi.useRealTimers();
  });

  test("owner downgrades off Business (plan_changed) with a still-pending unaccepted invite → acceptBusinessInvite rejects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    await seedProductPlan(t, PRODUCT_CATALOG.api_starter.dodoProductId!, "api_starter", "API Starter");
    const businessSubId = "sub_business_downgrade_002";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    const grantId = invite.invited[0].grantId;
    const token = await signBusinessInviteToken(grantId);

    // Owner downgrades while the invite is still pending and unexpired.
    await fireWebhook(t, {
      eventType: "subscription.plan_changed",
      dodoSubscriptionId: businessSubId,
      status: "active",
      eventTimestamp: NOW + 1000,
      productId: PRODUCT_CATALOG.api_starter.dodoProductId!,
    });

    // The plan-changed handler revoked the (pending) grant outright, so the
    // teammate now gets INVITE_ALREADY_USED (status check fires first) rather
    // than BUSINESS_NOT_ACTIVE — either way, they must NOT be granted Pro.
    await expect(
      t
        .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
        .mutation(api.payments.businessSeats.acceptBusinessInvite, { grantId, token }),
    ).rejects.toThrow(/INVITE_ALREADY_USED|BUSINESS_NOT_ACTIVE/);

    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(ent).toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });
});

describe("payments businessSeats reconcileBusinessProGrants (reconciliation cron safety net)", () => {
  test("revokes a grant left stranded on a Business sub that already downgraded, and leaves a healthy grant untouched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.RESEND_API_KEY = "test-resend-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-ok" }), { status: 200 }),
    );
    const t = convexTest(schema, modules);

    // Stranded: subscription row directly patched to a non-business planKey
    // WITHOUT going through handleSubscriptionPlanChanged (simulates the
    // exact class of failure this sweep exists for — a lost webhook/dropped
    // scheduled function that never revoked the grant).
    const strandedSubId = "sub_business_reconcile_stranded";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: strandedSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: strandedSubId,
      inviteeUserId: "user_stranded",
      inviteeEmail: "stranded@acme.com",
      domain: "acme.com",
    });
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", strandedSubId))
        .unique();
      await ctx.db.patch(sub!._id, { planKey: "api_starter" });
    });

    // Healthy: normal accepted grant on a genuinely still-covering Business sub.
    const healthySubId = "sub_business_reconcile_healthy";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: healthySubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });
    await seedAcceptedGrantWithInvitee(t, {
      businessSubscriptionId: healthySubId,
      inviteeUserId: "user_healthy",
      inviteeEmail: "healthy@acme.com",
      domain: "acme.com",
    });

    const result = await t.mutation(internal.payments.subscriptionHelpers.reconcileBusinessProGrants, {});
    expect(result).toEqual({ ok: true, checked: 2, revoked: 1, failed: 0 });

    const strandedGrant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", strandedSubId),
        )
        .first(),
    );
    expect(strandedGrant?.status).toBe("revoked");
    const strandedEnt = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_stranded")).first(),
    );
    expect(strandedEnt?.planKey).toBe("free");

    const healthyGrant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", healthySubId),
        )
        .first(),
    );
    expect(healthyGrant?.status).toBe("accepted");
    const healthyEnt = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_healthy")).first(),
    );
    expect(healthyEnt?.planKey).toBe("pro_monthly");

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.to).toEqual(["stranded@acme.com"]);
    fetchMock.mockRestore();
    vi.useRealTimers();
  });

  test("is a no-op when there are no live grants", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.payments.subscriptionHelpers.reconcileBusinessProGrants, {});
    expect(result).toEqual({ ok: true, checked: 0, revoked: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// U8 — End-to-end lifecycle and edge cases (#4634/#4635)
// ---------------------------------------------------------------------------

describe("payments businessSeats end-to-end lifecycle", () => {
  test("full lifecycle: invite → accept → Pro → Business lapse → revoke", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_e2e_001";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    // 1. Invite
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    const grantId = invite.invited[0].grantId;
    const token = await signBusinessInviteToken(grantId);

    // 2. Accept
    await t
      .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
      .mutation(api.payments.businessSeats.acceptBusinessInvite, {
        grantId,
        token,
      });

    // 3. Pro entitlement
    let ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(ent?.planKey).toBe("pro_monthly");

    // 4. Business lapse
    await fireWebhook(t, {
      eventType: "subscription.expired",
      dodoSubscriptionId: businessSubId,
      status: "expired",
      eventTimestamp: NOW + 1000,
    });

    // 5. Grant revoked, invitee free
    const grant = await t.run(async (ctx) => ctx.db.get(grantId));
    expect(grant?.status).toBe("revoked");
    ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(ent?.planKey).toBe("free");
    vi.useRealTimers();
  });

  test("pending-expiry frees a slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_e2e_002";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    // Invite 4 pending grants.
    for (const email of ["a@acme.com", "b@acme.com", "c@acme.com", "d@acme.com"]) {
      await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: [email],
      });
    }

    // 5th invite is blocked.
    await expect(
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["e@acme.com"],
      }),
    ).rejects.toThrow(/SEAT_CAP_REACHED|TOO_MANY_EMAILS/);

    // Expire one pending invite.
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .filter((q) => q.eq(q.field("inviteeEmail"), "a@acme.com"))
        .first(),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(grant!._id, { expiresAt: NOW - DAY_MS, status: "expired" });
    });

    // 5th invite now succeeds.
    const result = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["e@acme.com"] },
    );
    expect(result.invited[0].status).toBe("created");
    vi.useRealTimers();
  });

  test("re-invite after revoke is clean", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_e2e_003";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    // Invite and revoke.
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.removeSeat, {
      grantId: invite.invited[0].grantId,
    });

    // Re-invite the same email.
    const reinvite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    expect(reinvite.invited[0].status).toBe("created");

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    expect(grants).toHaveLength(2);
    expect(grants.find((g) => g.status === "pending")).toBeTruthy();
    expect(grants.find((g) => g.status === "revoked")).toBeTruthy();
    vi.useRealTimers();
  });

  // NOTE on what this test does and does NOT prove (2026-07-25 review):
  // convex-test's TransactionManager.begin() holds a mutex around every
  // top-level mutation call, forcing full sequential execution — the two
  // `Promise.allSettled(t.mutation(...))` calls below run fully end-to-end
  // one after the other with zero read/write interleaving. This test
  // therefore proves the cap-check logic is correct under back-to-back
  // sequential calls (i.e. the SAME thing four single-invite calls in a
  // row would prove) — it does NOT exercise the `businessSeatLocks`
  // OCC-serialization mechanism itself, since nothing in this harness can
  // interleave two mutations' reads and writes. It would pass identically
  // even if `businessSeatLocks` were deleted outright. The lock's design is
  // architecturally sound per Convex's documented per-document OCC/retry
  // semantics, but that claim is unverified by any automated test in this
  // repo — a staging/production smoke test issuing genuinely parallel
  // `inviteSeats` calls at the cap boundary is needed to actually prove it
  // under load.
  test("sequential 5th-invite calls at the cap: cap holds (does not exercise true OCC concurrency — see note above)", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_e2e_004";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    // Seed 4 pending grants.
    for (const email of ["a@acme.com", "b@acme.com", "c@acme.com", "d@acme.com"]) {
      await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: [email],
      });
    }

    // "Concurrent" only in call-site shape — convex-test serializes these two
    // mutations end-to-end (see note above). Only one may succeed, or both
    // may fail with SEAT_CAP_REACHED / TOO_MANY_EMAILS. The cap must never
    // be exceeded.
    const results = await Promise.allSettled([
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["e@acme.com"],
      }),
      t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
        emails: ["f@acme.com"],
      }),
    ]);

    const grants = await t.run(async (ctx) =>
      ctx.db
        .query("businessProGrants")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .collect(),
    );
    const activeOrPending = grants.filter((g) => {
      if (g.status === "accepted") return true;
      if (g.status === "pending" && g.expiresAt > NOW) return true;
      return false;
    });
    expect(activeOrPending.length).toBeLessThanOrEqual(4);

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    expect(succeeded + failed).toBe(2);
    expect(activeOrPending.length).toBeLessThanOrEqual(4);
    vi.useRealTimers();
  });

  test("businessSeatLocks row is touched on every inviteSeats call (necessary precondition for the OCC mechanism to serialize concurrent calls under real Convex)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_e2e_005";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
      emails: ["a@acme.com"],
    });
    const lockAfterFirst = await t.run(async (ctx) =>
      ctx.db
        .query("businessSeatLocks")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .unique(),
    );
    expect(lockAfterFirst).not.toBeNull();
    expect(lockAfterFirst?.lastTouchedAt).toBe(NOW);

    vi.setSystemTime(NOW + 1000);
    await t.withIdentity(OWNER_IDENTITY).mutation(api.payments.businessSeats.inviteSeats, {
      emails: ["b@acme.com"],
    });
    const lockAfterSecond = await t.run(async (ctx) =>
      ctx.db
        .query("businessSeatLocks")
        .withIndex("by_businessSubscriptionId", (q) =>
          q.eq("businessSubscriptionId", businessSubId),
        )
        .unique(),
    );
    // Same lock row (not a duplicate insert), timestamp advanced — confirms
    // every call actually reads+writes the shared document, which is the
    // mechanism Convex's per-document OCC conflict detection depends on.
    expect(lockAfterSecond?._id).toBe(lockAfterFirst?._id);
    expect(lockAfterSecond?.lastTouchedAt).toBe(NOW + 1000);
    vi.useRealTimers();
  });

  test("invitee already covered by own paid sub is unaffected", async () => {
    vi.useFakeTimers();
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const businessSubId = "sub_business_e2e_005";
    await seedBusinessSubscription(t, {
      dodoSubscriptionId: businessSubId,
      status: "active",
      currentPeriodEnd: NOW + 30 * DAY_MS,
    });

    // Invitee already has own api_starter sub.
    await seedSubscription(t, {
      planKey: "api_starter",
      dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!,
      status: "active",
      currentPeriodEnd: NOW + 60 * DAY_MS,
      suffix: "own_api_starter",
      userId: "user_teammate",
    });

    // Invite and accept.
    const invite = await t.withIdentity(OWNER_IDENTITY).mutation(
      api.payments.businessSeats.inviteSeats,
      { emails: ["teammate@acme.com"] },
    );
    const token = await signBusinessInviteToken(invite.invited[0].grantId);
    await t
      .withIdentity({ subject: "user_teammate", tokenIdentifier: "clerk|user_teammate", email: "teammate@acme.com" })
      .mutation(api.payments.businessSeats.acceptBusinessInvite, {
        grantId: invite.invited[0].grantId,
        token,
      });

    // Own api_starter (tier 2) outranks the Pro grant (tier 1).
    const ent = await t.run(async (ctx) =>
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", "user_teammate")).first(),
    );
    expect(ent?.planKey).toBe("api_starter");
    expect(ent?.features.tier).toBe(2);
    vi.useRealTimers();
  });
});

describe("payments businessSeats email actions — Resend failure handling", () => {
  test("sendBusinessInviteEmail throws when Resend returns non-2xx", async () => {
    process.env.RESEND_API_KEY = "test-resend-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.payments.businessSeats.sendBusinessInviteEmail, {
        inviteeEmail: "teammate@acme.com",
        ownerEmail: "owner@acme.com",
        grantId: "fake_grant_id",
        token: "fake.token.sig",
      }),
    ).rejects.toThrow(/Resend invite email failed: 429/);

    fetchMock.mockRestore();
  });

  test("sendTeamAccessEndedEmail throws when Resend returns non-2xx", async () => {
    process.env.RESEND_API_KEY = "test-resend-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.payments.businessSeats.sendTeamAccessEndedEmail, {
        inviteeEmail: "teammate@acme.com",
      }),
    ).rejects.toThrow(/Resend team-access-ended email failed: 429/);

    fetchMock.mockRestore();
  });
});
