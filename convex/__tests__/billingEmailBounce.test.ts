import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRODUCT_CATALOG } from "../config/productCatalog";

// The action must reach Dodo through the SDK's customer update and nothing
// else; the queries and mutations under test run through production code.
const { dodoCustomerUpdateMock, dodoCustomerRetrieveMock } = vi.hoisted(() => ({
  dodoCustomerUpdateMock: vi.fn(),
  dodoCustomerRetrieveMock: vi.fn(),
}));
vi.mock("dodopayments", () => ({
  DodoPayments: class {
    customers = { update: dodoCustomerUpdateMock, retrieve: dodoCustomerRetrieveMock };
  },
}));

const modules = import.meta.glob("../**/*.ts");

const USER_ID = "user_billing_email_001";
const IDENTITY = { subject: USER_ID, tokenIdentifier: `clerk|${USER_ID}` };
const BOUNCED = "elie.habbi@example.com";
const FIXED = "elie.habib@example.com";
const CUSTOMER_ID = "cus_billing_email_001";
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
type SuppressionReason = "bounce" | "complaint" | "manual" | "unsubscribe";

afterEach(() => {
  dodoCustomerUpdateMock.mockReset();
  dodoCustomerRetrieveMock.mockReset();
  vi.useRealTimers();
  delete process.env.DODO_API_KEY;
});

/** Dodo answers every update and every retrieve with the address it was given. */
function dodoAcceptsUpdates(): void {
  process.env.DODO_API_KEY = "test_dodo_key";
  dodoCustomerUpdateMock.mockImplementation(async (customerId: string, body: { email: string }) => ({
    customer_id: customerId,
    email: body.email,
  }));
  dodoCustomerRetrieveMock.mockImplementation(async (customerId: string) => {
    const lastUpdate = [...dodoCustomerUpdateMock.mock.calls].reverse().find((call) => call[0] === customerId);
    return { customer_id: customerId, email: lastUpdate?.[1]?.email ?? BOUNCED };
  });
}

function rawEmail(sub: { rawPayload: unknown }): string | undefined {
  return (sub.rawPayload as { customer?: { email?: string } }).customer?.email;
}

async function seedSubscription(
  t: ReturnType<typeof convexTest>,
  opts: {
    suffix?: string;
    userId?: string;
    status?: "active" | "on_hold" | "cancelled" | "expired";
    currentPeriodEnd?: number;
    /** `null` leaves `rawPayload.customer` without an email. */
    email?: string | null;
    dodoCustomerId?: string | null;
  } = {},
): Promise<Id<"subscriptions">> {
  const suffix = opts.suffix ?? "main";
  const customer: Record<string, string> = { customer_id: opts.dodoCustomerId ?? CUSTOMER_ID };
  if (opts.email !== null) customer.email = opts.email ?? BOUNCED;
  return await t.run(async (ctx) =>
    ctx.db.insert("subscriptions", {
      userId: opts.userId ?? USER_ID,
      dodoSubscriptionId: `sub_billing_email_${suffix}`,
      dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
      planKey: "pro_monthly",
      status: opts.status ?? "active",
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: opts.currentPeriodEnd ?? NOW + 30 * DAY_MS,
      ...(opts.dodoCustomerId === null ? {} : { dodoCustomerId: opts.dodoCustomerId ?? CUSTOMER_ID }),
      rawPayload: { subscription_id: `sub_billing_email_${suffix}`, customer },
      updatedAt: NOW,
    }),
  );
}

async function seedCustomer(
  t: ReturnType<typeof convexTest>,
  opts: { userId?: string; email?: string; dodoCustomerId?: string } = {},
): Promise<Id<"customers">> {
  const email = opts.email ?? BOUNCED;
  return await t.run(async (ctx) =>
    ctx.db.insert("customers", {
      userId: opts.userId ?? USER_ID,
      dodoCustomerId: opts.dodoCustomerId ?? CUSTOMER_ID,
      email,
      normalizedEmail: email.toLowerCase(),
      createdAt: NOW - DAY_MS,
      updatedAt: NOW - DAY_MS,
    }),
  );
}

async function suppress(
  t: ReturnType<typeof convexTest>,
  email: string,
  reason: SuppressionReason,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("emailSuppressions", {
      normalizedEmail: email.trim().toLowerCase(),
      reason,
      suppressedAt: NOW - 1000,
      source: "test",
    });
  });
}

async function readSubscription(t: ReturnType<typeof convexTest>) {
  return await t.withIdentity(IDENTITY).query(api.payments.billing.getSubscriptionForUser, {});
}

async function snapshotBillingRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    subscriptions: await ctx.db.query("subscriptions").collect(),
    customers: await ctx.db.query("customers").collect(),
    suppressions: await ctx.db.query("emailSuppressions").collect(),
  }));
}

describe("getSubscriptionForUser billing email bounce", () => {
  test("flags a hard bounce on the live recipient", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await suppress(t, BOUNCED, "bounce");

    const result = await readSubscription(t);
    expect(result).toMatchObject({ billingEmail: BOUNCED, billingEmailBounced: true });
  });

  test("reports the recipient with no bounce when nothing is suppressed", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t);

    const result = await readSubscription(t);
    expect(result).toMatchObject({ billingEmail: BOUNCED, billingEmailBounced: false });
  });

  test("null recipient when neither the payload nor a customers row has one", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, { email: null });

    const result = await readSubscription(t);
    expect(result).toMatchObject({ billingEmail: null, billingEmailBounced: false });
  });

  test.each<SuppressionReason>(["complaint", "manual", "unsubscribe"])(
    "a %s suppression is not a bounce",
    async (reason) => {
      const t = convexTest(schema, modules);
      await seedSubscription(t);
      await suppress(t, BOUNCED, reason);

      const result = await readSubscription(t);
      expect(result).toMatchObject({ billingEmail: BOUNCED, billingEmailBounced: false });
    },
  );

  test("matches the suppression row through normalization", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t, { email: "  Elie.Habbi@Example.com " });
    await suppress(t, BOUNCED, "bounce");

    const result = await readSubscription(t);
    expect(result).toMatchObject({ billingEmail: "Elie.Habbi@Example.com", billingEmailBounced: true });
  });

  test("on_hold still reports the bounce; ended subscriptions never do", async () => {
    const onHold = convexTest(schema, modules);
    await seedSubscription(onHold, { status: "on_hold" });
    await suppress(onHold, BOUNCED, "bounce");
    expect((await readSubscription(onHold))?.billingEmailBounced).toBe(true);

    for (const status of ["cancelled", "expired"] as const) {
      const t = convexTest(schema, modules);
      await seedSubscription(t, { status, currentPeriodEnd: NOW - DAY_MS });
      await suppress(t, BOUNCED, "bounce");
      const result = await readSubscription(t);
      expect(result?.status).toBe(status);
      expect(result?.billingEmailBounced).toBe(false);
    }
  });

  test("resolves the recipient exactly as dunning does", async () => {
    const cases: Array<{ name: string; email: string | null; customerRow?: string }> = [
      { name: "payload email wins over the customers row", email: BOUNCED, customerRow: "other@example.com" },
      { name: "customers row when the payload has no email", email: null, customerRow: "row@example.com" },
      { name: "customers row when the payload email is not an address", email: "not-an-address", customerRow: "row@example.com" },
      { name: "empty when nothing is known", email: null },
    ];
    for (const c of cases) {
      const t = convexTest(schema, modules);
      await seedSubscription(t, { email: c.email });
      if (c.customerRow) await seedCustomer(t, { email: c.customerRow });

      const ui = await readSubscription(t);
      const dunning = await t.query(internal.payments.subscriptionEmails.getDunningContext, {
        dodoSubscriptionId: "sub_billing_email_main",
      });
      expect(dunning, c.name).not.toBeNull();
      expect(ui?.billingEmail ?? "", c.name).toBe(dunning!.email);
    }
  });
});

describe("updateBillingEmail", () => {
  test("updates Dodo first, then the customers row and every subscription payload", async () => {
    dodoAcceptsUpdates();
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await seedSubscription(t, { suffix: "old", status: "cancelled", currentPeriodEnd: NOW - 40 * DAY_MS });
    await seedCustomer(t);
    await suppress(t, BOUNCED, "bounce");
    expect((await readSubscription(t))?.billingEmailBounced).toBe(true);

    const result = await t
      .withIdentity(IDENTITY)
      .action(api.payments.billing.updateBillingEmail, { email: `  ${FIXED} ` });
    expect(result).toEqual({ email: FIXED });
    expect(dodoCustomerUpdateMock).toHaveBeenCalledTimes(1);
    expect(dodoCustomerUpdateMock).toHaveBeenCalledWith(CUSTOMER_ID, { email: FIXED });

    const rows = await snapshotBillingRows(t);
    expect(rows.customers).toHaveLength(1);
    expect(rows.customers[0]).toMatchObject({ email: FIXED, normalizedEmail: FIXED });
    expect(rows.customers[0]!.updatedAt).toBeGreaterThan(NOW - DAY_MS);
    expect(rows.subscriptions).toHaveLength(2);
    for (const sub of rows.subscriptions) {
      expect((sub.rawPayload as { customer: { email: string; customer_id: string } }).customer)
        .toEqual({ customer_id: CUSTOMER_ID, email: FIXED });
      // Not a lifecycle event: the dunning episode anchor must not move.
      expect(sub.updatedAt).toBe(NOW);
      expect(sub.billingEmailOverride?.email).toBe(FIXED);
      expect(sub.billingEmailOverride!.observedAt).toBeGreaterThan(NOW);
    }
    // The old address stays suppressed; only the recipient changed.
    expect(rows.suppressions).toHaveLength(1);
    expect(rows.suppressions[0]).toMatchObject({ normalizedEmail: BOUNCED, reason: "bounce" });

    expect(await readSubscription(t)).toMatchObject({ billingEmail: FIXED, billingEmailBounced: false });
    const dunning = await t.query(internal.payments.subscriptionEmails.getDunningContext, {
      dodoSubscriptionId: "sub_billing_email_main",
    });
    expect(dunning?.email).toBe(FIXED);
  });

  test("updates each distinct Dodo customer the user owns, once", async () => {
    dodoAcceptsUpdates();
    const t = convexTest(schema, modules);
    await seedSubscription(t, { suffix: "a", dodoCustomerId: "cus_a" });
    await seedSubscription(t, { suffix: "b", dodoCustomerId: "cus_b", status: "cancelled", currentPeriodEnd: NOW - DAY_MS });
    await seedSubscription(t, { suffix: "c", dodoCustomerId: "cus_a" });
    await seedCustomer(t, { dodoCustomerId: "cus_row" });

    await t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED });

    const updated = dodoCustomerUpdateMock.mock.calls.map((call) => call[0]).sort();
    expect(updated).toEqual(["cus_a", "cus_b", "cus_row"]);
  });

  test("a Dodo failure leaves every local row untouched", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    dodoCustomerUpdateMock.mockRejectedValue(new Error("502 upstream"));
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await seedCustomer(t);
    await suppress(t, BOUNCED, "bounce");
    const before = await snapshotBillingRows(t);

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).rejects.toThrow("DODO_CUSTOMER_UPDATE_ERROR");

    expect(await snapshotBillingRows(t)).toEqual(before);
    expect((await readSubscription(t))?.billingEmailBounced).toBe(true);
  });

  test("a second attempt inside the cooldown is refused before Dodo, and allowed after it", async () => {
    dodoAcceptsUpdates();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + 1000);
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await suppress(t, BOUNCED, "bounce");

    await t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED });
    expect(dodoCustomerUpdateMock).toHaveBeenCalledTimes(1);

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: "other@example.com" }),
    ).rejects.toThrow("BILLING_EMAIL_RATE_LIMITED");
    expect(dodoCustomerUpdateMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 1000 + 11_000);
    await t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: "other@example.com" });
    expect(dodoCustomerUpdateMock).toHaveBeenCalledTimes(2);
  });

  test("the address already on file returns without calling Dodo", async () => {
    dodoAcceptsUpdates();
    const t = convexTest(schema, modules);
    await seedSubscription(t, { email: FIXED });
    await seedCustomer(t, { email: FIXED });

    const result = await t
      .withIdentity(IDENTITY)
      .action(api.payments.billing.updateBillingEmail, { email: FIXED.toUpperCase() });
    expect(result).toEqual({ email: FIXED });
    expect(dodoCustomerUpdateMock).not.toHaveBeenCalled();
  });

  test("a later customer failing keeps what Dodo already changed for earlier ones", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    dodoCustomerUpdateMock.mockImplementation(async (customerId: string) => {
      if (customerId === "cus_b") throw new Error("502 upstream");
      return { customer_id: customerId, email: FIXED };
    });
    dodoCustomerRetrieveMock.mockResolvedValue({ customer_id: "cus_a", email: FIXED });
    const t = convexTest(schema, modules);
    await seedSubscription(t, { suffix: "a", dodoCustomerId: "cus_a" });
    await seedSubscription(t, { suffix: "b", dodoCustomerId: "cus_b" });
    await seedCustomer(t, { dodoCustomerId: "cus_a" });

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).rejects.toThrow("DODO_CUSTOMER_UPDATE_ERROR");

    const rows = await snapshotBillingRows(t);
    const subA = rows.subscriptions.find((sub) => sub.dodoCustomerId === "cus_a")!;
    const subB = rows.subscriptions.find((sub) => sub.dodoCustomerId === "cus_b")!;
    expect(rawEmail(subA)).toBe(FIXED);
    expect(subA.billingEmailOverride?.email).toBe(FIXED);
    expect(rawEmail(subB)).toBe(BOUNCED);
    expect(subB.billingEmailOverride).toBeUndefined();
    expect(rows.customers[0]).toMatchObject({ dodoCustomerId: "cus_a", email: FIXED });
  });

  test("applies the address Dodo reports after the update, not the one requested", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    dodoCustomerUpdateMock.mockResolvedValue({ customer_id: CUSTOMER_ID, email: FIXED });
    // Another tab's later update already won at Dodo.
    dodoCustomerRetrieveMock.mockResolvedValue({ customer_id: CUSTOMER_ID, email: "winner@example.com" });
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await seedCustomer(t);

    const result = await t
      .withIdentity(IDENTITY)
      .action(api.payments.billing.updateBillingEmail, { email: FIXED });
    expect(result).toEqual({ email: "winner@example.com" });
    const rows = await snapshotBillingRows(t);
    expect(rawEmail(rows.subscriptions[0]!)).toBe("winner@example.com");
    expect(rows.customers[0]!.email).toBe("winner@example.com");
  });

  test("falls back to the requested address when the read-back fails", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    dodoCustomerUpdateMock.mockResolvedValue({ customer_id: CUSTOMER_ID, email: FIXED });
    dodoCustomerRetrieveMock.mockRejectedValue(new Error("timeout"));
    const t = convexTest(schema, modules);
    await seedSubscription(t);

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).resolves.toEqual({ email: FIXED });
    expect(rawEmail((await snapshotBillingRows(t)).subscriptions[0]!)).toBe(FIXED);
  });

  test("a delayed webhook carrying the old address cannot undo the repair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 60_000);
    dodoAcceptsUpdates();
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await suppress(t, BOUNCED, "bounce");
    await t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED });

    // Generated before the repair (timestamp between the row's updatedAt and
    // observedAt), delivered after it, still naming the typo.
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_delayed_old_email",
      eventType: "subscription.on_hold",
      rawPayload: { data: { subscription_id: "sub_billing_email_main", customer: { customer_id: CUSTOMER_ID, email: BOUNCED } } },
      timestamp: NOW + 30_000,
    });
    const stale = (await snapshotBillingRows(t)).subscriptions[0]!;
    expect(rawEmail(stale)).toBe(BOUNCED);
    expect(stale.updatedAt).toBe(NOW + 30_000);
    expect(await readSubscription(t)).toMatchObject({ status: "on_hold", billingEmail: FIXED, billingEmailBounced: false });
    const dunning = await t.query(internal.payments.subscriptionEmails.getDunningContext, {
      dodoSubscriptionId: "sub_billing_email_main",
    });
    expect(dunning?.email).toBe(FIXED);

    // Generated after the repair: Dodo's current address wins again.
    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_after_repair",
      eventType: "subscription.on_hold",
      rawPayload: { data: { subscription_id: "sub_billing_email_main", customer: { customer_id: CUSTOMER_ID, email: "newer@example.com" } } },
      timestamp: NOW + 90_000,
    });
    expect((await readSubscription(t))?.billingEmail).toBe("newer@example.com");
  });

  test("an older observation applied after a newer one is a no-op", async () => {
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await seedCustomer(t);
    const apply = (email: string, observedAt: number) =>
      t.mutation(internal.payments.billing.applyBillingEmailUpdate, {
        userId: USER_ID,
        customerId: CUSTOMER_ID,
        email,
        observedAt,
        includeUnlinked: true,
      });

    await apply("second@example.com", NOW + 20);
    await apply("first@example.com", NOW + 10);

    const rows = await snapshotBillingRows(t);
    expect(rows.subscriptions[0]!.billingEmailOverride).toEqual({ email: "second@example.com", observedAt: NOW + 20 });
    expect(rawEmail(rows.subscriptions[0]!)).toBe("second@example.com");
    expect(rows.customers[0]!.email).toBe("second@example.com");
  });

  test.each<SuppressionReason>(["bounce", "complaint", "manual"])(
    "refuses a new address that is itself suppressed (%s) before touching Dodo, without naming why",
    async (reason) => {
      process.env.DODO_API_KEY = "test_dodo_key";
      const t = convexTest(schema, modules);
      await seedSubscription(t);
      await suppress(t, FIXED, reason);

      const error = await t
        .withIdentity(IDENTITY)
        .action(api.payments.billing.updateBillingEmail, { email: FIXED })
        .then(() => null, (err: unknown) => err as { data?: unknown });
      // convex-test serializes error data once per function boundary crossed
      // (internal query -> action -> caller).
      let data = error?.data;
      while (typeof data === "string") data = JSON.parse(data);
      expect(data).toEqual({ kind: "EMAIL_SUPPRESSED" });
      expect(dodoCustomerUpdateMock).not.toHaveBeenCalled();
    },
  );

  test("a user with no Dodo customer learns nothing about a suppressed address", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    const t = convexTest(schema, modules);
    await suppress(t, FIXED, "bounce");

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).rejects.toThrow("NO_CUSTOMER");
  });

  test("a broadcast unsubscribe on the new address does not block billing mail", async () => {
    dodoAcceptsUpdates();
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await suppress(t, FIXED, "unsubscribe");

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).resolves.toEqual({ email: FIXED });
  });

  test.each(["", "   ", "no-at-sign", "a b@example.com", "x@nodot", `${"a".repeat(250)}@example.com`])(
    "rejects %j as an address before touching Dodo",
    async (email) => {
      process.env.DODO_API_KEY = "test_dodo_key";
      const t = convexTest(schema, modules);
      await seedSubscription(t);

      await expect(
        t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email }),
      ).rejects.toThrow("INVALID_EMAIL");
      expect(dodoCustomerUpdateMock).not.toHaveBeenCalled();
    },
  );

  test("requires a signed-in user", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    const t = convexTest(schema, modules);
    await seedSubscription(t);

    await expect(
      t.action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).rejects.toThrow("AUTH_REQUIRED");
    expect(dodoCustomerUpdateMock).not.toHaveBeenCalled();
  });

  test("refuses an account whose deletion is in progress", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("accountDeletions", {
        userId: USER_ID,
        userIdHash: "hash_billing_email_001",
        source: "self",
        status: "pending",
        step: "grants",
        dodoSubscriptionIds: ["sub_billing_email_main"],
        cancelledDodoSubscriptionIds: [],
        startedAt: NOW - 2,
        updatedAt: NOW - 1,
      });
    });

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).rejects.toThrow("ACCOUNT_DELETION_IN_PROGRESS");
    expect(dodoCustomerUpdateMock).not.toHaveBeenCalled();
  });

  test("refuses a Dodo customer another user is linked to", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    const t = convexTest(schema, modules);
    await seedSubscription(t);
    await seedSubscription(t, { suffix: "other", userId: "user_other" });

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).rejects.toThrow("SHARED_CUSTOMER");
    expect(dodoCustomerUpdateMock).not.toHaveBeenCalled();
    const rows = await snapshotBillingRows(t);
    expect(rows.subscriptions.every((sub) => (sub.rawPayload as { customer: { email: string } }).customer.email === BOUNCED)).toBe(true);
  });

  test("reports NO_CUSTOMER when no Dodo customer id is known", async () => {
    process.env.DODO_API_KEY = "test_dodo_key";
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: USER_ID,
        dodoSubscriptionId: "sub_billing_email_bare",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - DAY_MS,
        currentPeriodEnd: NOW + 30 * DAY_MS,
        rawPayload: { customer: { email: BOUNCED } },
        updatedAt: NOW,
      });
    });

    await expect(
      t.withIdentity(IDENTITY).action(api.payments.billing.updateBillingEmail, { email: FIXED }),
    ).rejects.toThrow("NO_CUSTOMER");
    expect(dodoCustomerUpdateMock).not.toHaveBeenCalled();
  });
});
