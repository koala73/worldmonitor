import { convexTest } from "convex-test";
import { afterEach, expect, test, describe, vi } from "vitest";
import { getFeaturesForPlan } from "../lib/entitlements";
import {
  CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS,
  signCheckoutLoginEmail,
  signUserId,
} from "../lib/identitySigning";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function makeSubscriptionPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "subscription.active",
    business_id: "biz_test",
    timestamp: "2026-03-21T10:00:00Z",
    data: {
      payload_type: "Subscription",
      subscription_id: "sub_test_001",
      product_id: "pdt_test_pro",
      status: "active",
      customer: {
        customer_id: "cust_test_001",
        email: "test@example.com",
        name: "Test User",
      },
      metadata: { wm_user_id: "test-user-001" },
      previous_billing_date: "2026-03-21T00:00:00Z",
      next_billing_date: "2026-04-21T00:00:00Z",
      ...overrides,
    },
  };
}

function makePaymentPayload(
  eventType:
    | "payment.succeeded"
    | "payment.failed"
    | "payment.processing"
    | "payment.cancelled",
  overrides: Record<string, unknown> = {},
) {
  return {
    type: eventType,
    business_id: "biz_test",
    timestamp: "2026-03-21T10:00:00Z",
    data: {
      payload_type: "Payment",
      payment_id: "pay_test_001",
      subscription_id: "sub_test_001",
      total_amount: 1999,
      currency: "USD",
      customer: {
        customer_id: "cust_test_001",
        email: "test@example.com",
        name: "Test User",
      },
      metadata: { wm_user_id: "test-user-001" },
      ...overrides,
    },
  };
}

const BASE_TIMESTAMP = new Date("2026-03-21T10:00:00Z").getTime();
const SIGNING_SECRET = "test-dodo-identity-signing-secret";

afterEach(() => {
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.RESEND_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: seed a productPlans mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: call processWebhookEvent
// ---------------------------------------------------------------------------

async function processEvent(
  t: ReturnType<typeof convexTest>,
  webhookId: string,
  eventType: string,
  rawPayload: Record<string, unknown>,
  timestamp: number,
) {
  const payloadData = (rawPayload.data ?? {}) as {
    customer?: { customer_id?: string; email?: string };
    metadata?: { wm_user_id?: string };
  };
  const dodoCustomerId = payloadData.customer?.customer_id ?? "cust_test_001";
  const userId = payloadData.metadata?.wm_user_id ?? "test-user-001";
  const email = payloadData.customer?.email ?? "test@example.com";

  await t.run(async (ctx) => {
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", dodoCustomerId))
      .first();
    if (!existingCustomer) {
      await ctx.db.insert("customers", {
        userId,
        dodoCustomerId,
        email,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  });

  await t.mutation(
    internal.payments.webhookMutations.processWebhookEvent,
    {
      webhookId,
      eventType,
      rawPayload,
      timestamp,
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhook processWebhookEvent", () => {
  test("subscription.active creates new subscription", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    const payload = makeSubscriptionPayload();
    await processEvent(t, "wh_001", "subscription.active", payload, BASE_TIMESTAMP);

    // Assert subscription record
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("active");
    expect(subs[0].userId).toBe("test-user-001");
    expect(subs[0].planKey).toBe("pro_monthly");
    expect(subs[0].dodoSubscriptionId).toBe("sub_test_001");
    expect(subs[0].currentPeriodStart).toBe(
      new Date("2026-03-21T00:00:00Z").getTime(),
    );
    expect(subs[0].currentPeriodEnd).toBe(
      new Date("2026-04-21T00:00:00Z").getTime(),
    );

    // Assert entitlements record
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("pro_monthly");
    expect(entitlements[0].features).toMatchObject({
      maxDashboards: 10,
      apiAccess: false,
    });

    // Assert webhookEvents record
    const events = await t.run(async (ctx) => {
      return ctx.db.query("webhookEvents").collect();
    });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("processed");
    expect(events[0].eventType).toBe("subscription.active");
  });

  test("subscription.active reactivates existing cancelled subscription", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Seed a cancelled subscription manually
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_test_001",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "cancelled",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP,
        cancelledAt: BASE_TIMESTAMP - 3600000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    const payload = makeSubscriptionPayload();
    await processEvent(t, "wh_002", "subscription.active", payload, BASE_TIMESTAMP);

    // Assert only 1 subscription (updated, not duplicated)
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("active");
  });

  test("subscription.active reactivation sends a welcome-back email", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_test_001",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(t, "wh_002_reactivation", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
        html: string;
      });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual(["test@example.com"]);
    expect(sends[0]?.subject).toContain("Welcome back");
    expect(sends[0]?.html).toContain("subscription is active again");
  });

  test("new-checkout reactivation uses prior lapsed history instead of a new-subscriber alert", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_old_expired",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(
      t,
      "wh_new_subscription_reactivation",
      "subscription.active",
      makeSubscriptionPayload({ subscription_id: "sub_new_reactivated" }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual(["test@example.com"]);
    expect(sends[0]?.subject).toContain("Welcome back");
  });

  test("a covering sibling prevents old lapsed history from forcing welcome-back mail", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_old_expired_with_cover",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_covering_sibling",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 30 * 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await processEvent(
      t,
      "wh_new_subscription_with_covering_sibling",
      "subscription.active",
      makeSubscriptionPayload({ subscription_id: "sub_new_while_covered" }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const subjects = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { subject: string };
        return body.subject;
      });

    expect(subjects).toHaveLength(2);
    expect(subjects.some((subject) => subject.startsWith("Welcome to World Monitor"))).toBe(true);
    expect(subjects.some((subject) => subject.startsWith("[WM] New User Subscribed"))).toBe(true);
    expect(subjects.every((subject) => !subject.includes("Welcome back"))).toBe(true);
  });

  // KTD9: Pro Business is a Pro plan for lifecycle purposes — it must get the
  // Pro welcome shell (value-prop headline, brief CTA, Pro feature grid), not
  // the neutral fallback shell that api_* and unknown plan keys fall through to.
  test("subscription.active for Pro Business sends the Pro welcome variant", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro_business", "pro_business_monthly", "Pro Business Monthly");

    await processEvent(
      t,
      "wh_pro_business_welcome",
      "subscription.active",
      makeSubscriptionPayload({
        subscription_id: "sub_pro_business_001",
        product_id: "pdt_test_pro_business",
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
        html: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["test@example.com"]);
    expect(welcome?.subject).toBe("Welcome to World Monitor Pro Business (Monthly)");
    // Pro shell markers — headline, CTA, and a Pro-only feature card.
    expect(welcome?.html).toContain("your intel, delivered");
    expect(welcome?.html).toContain("Open My Brief");
    expect(welcome?.html).toContain("WM Analyst");
    // The generic fallback grid must not appear.
    expect(welcome?.html).not.toContain("Full API Access");
  });

  // #6330: lifecycle emails must target (and name) the account's login email.
  // The checkout email is unauthenticated and may be a different alias — a
  // welcome sent there steers the buyer into "account not known" at sign-in.
  test("welcome email targets the account login email when checkout email differs", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_login_email_divergence",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
        html: string;
      });

    // Exactly three sends: welcome, pointer, admin. Pins against double-sends.
    expect(sends).toHaveLength(3);

    // Welcome goes to the address that can actually sign in, and names it.
    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["login@example.com"]);
    expect(welcome?.html).toContain("login@example.com");

    // The checkout inbox gets a sign-in pointer instead of silence — that is
    // the inbox the buyer demonstrably watches (they typed it at checkout).
    // The login address is MASKED there: the checkout inbox is unverified
    // (a typo'd address reaches a stranger), so it gets a recognizable hint,
    // never the full account address.
    const pointer = sends.find((send) => send.to[0] === "checkout@example.com");
    expect(pointer).toBeDefined();
    expect(pointer?.html).toContain("l•••@example.com");
    expect(pointer?.html).not.toContain("login@example.com");
    expect(pointer?.subject).toContain("sign in");

    // Admin notification names both identities so ops can find the customer
    // from either address.
    const admin = sends.find((send) => send.subject.startsWith("[WM] New User Subscribed"));
    expect(admin?.html).toContain("login@example.com");
    expect(admin?.html).toContain("checkout@example.com");
  });

  test("welcome email flow is unchanged when login and checkout emails match", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "test@example.com",
        normalizedEmail: "test@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_login_email_match",
      "subscription.active",
      makeSubscriptionPayload(),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    // Exactly the historical pair: user welcome + admin notification. No
    // pointer email, no duplicate sends.
    expect(sends).toHaveLength(2);
    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["test@example.com"]);
  });

  test("welcome email still sends via login email when checkout email is empty", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_login_email_empty_checkout",
      "subscription.active",
      makeSubscriptionPayload({
        customer: { customer_id: "cust_test_001", email: "", name: "Test User" },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["login@example.com"]);
    // Welcome + admin only — the empty checkout email must not produce a
    // pointer send.
    expect(sends).toHaveLength(2);
  });

  test("a rejected sign-in pointer send does not swallow the admin notification", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { to: string[] };
        // The buyer-typed checkout address is one Resend rejects outright.
        if (body.to[0] === "checkout@example.com") {
          return new Response('{"message":"invalid to"}', { status: 422 });
        }
        return new Response("{}", { status: 200 });
      });
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_pointer_send_rejected",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    // The pointer WAS attempted (guards against the "remove the pointer"
    // mutant — without this, the test passes vacuously when no pointer is
    // ever sent), and despite its rejection the welcome and the admin
    // notification both fired.
    expect(sends.some((send) => send.to[0] === "checkout@example.com")).toBe(true);
    expect(sends.some((send) => send.subject.startsWith("Welcome to World Monitor"))).toBe(true);
    expect(sends.some((send) => send.subject.startsWith("[WM] New User Subscribed"))).toBe(true);
  });

  test("reactivation email targets the account login email when checkout email differs", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_test_001",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(
      t,
      "wh_reactivation_login_email",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    const welcomeBack = sends.find((send) => send.subject.includes("Welcome back"));
    expect(welcomeBack?.to).toEqual(["login@example.com"]);
    // The reactivation path gets the same #6330 treatment as the first
    // purchase: the welcome-back names the sign-in address, and the checkout
    // inbox receives a pointer (masked login) instead of silence.
    expect(welcomeBack?.html).toContain("login@example.com");
    const pointer = sends.find((send) => send.to[0] === "checkout@example.com");
    expect(pointer).toBeDefined();
    expect(pointer?.html).toContain("l•••@example.com");
    expect(sends).toHaveLength(2);
  });

  test("case- and whitespace-only checkout differences stay on the no-pointer path", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_login_email_case_only",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: " LOGIN@Example.com ",
          name: "Test User",
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    // Same inbox in different casing is NOT a divergence: welcome + admin
    // only, no pointer, no third email into the user's own inbox.
    expect(sends).toHaveLength(2);
    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["login@example.com"]);
  });

  test("a users row without an email falls back to the checkout address", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      // Phone-only signup shape: row exists, email absent.
      await ctx.db.insert("users", {
        userId: "test-user-001",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_users_row_no_email",
      "subscription.active",
      makeSubscriptionPayload(),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    expect(sends).toHaveLength(2);
    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["test@example.com"]);
  });

  // #6335: the users row is refreshed once per page load per userId
  // (src/services/convex-client.ts short-circuits on a module-level
  // lastEnsuredUserId), so a user who changes their primary email in the Clerk
  // portal and subscribes in the same long-lived tab leaves a STALE
  // users.email. The checkout carries the login email as it was at checkout
  // time, HMAC-signed — that is the fresher of the two, so it wins.
  test("a signed checkout login email outranks a stale users row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      // The address the user abandoned in the Clerk portal, mirrored here by
      // the last ensureRecord call before the change.
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "stale@example.com",
        normalizedEmail: "stale@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(
      t,
      "wh_signed_login_email_fresh",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "fresh@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "fresh@example.com",
            BASE_TIMESTAMP - 60_000,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
        html: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["fresh@example.com"]);
    expect(welcome?.html).toContain("fresh@example.com");
    // The abandoned address receives nothing at all.
    expect(sends.every((send) => send.to[0] !== "stale@example.com")).toBe(true);
    // The checkout inbox still gets the pointer, and it names the FRESH login
    // address (masked) — pointing at the stale one is the same dead end.
    const pointer = sends.find((send) => send.to[0] === "checkout@example.com");
    expect(pointer?.html).toContain("f•••@example.com");
    expect(pointer?.html).not.toContain("s•••@example.com");
  });

  // The inverse of the #6335 bug, and just as real: change the email AFTER
  // checking out, then load a page (refreshing the users row) before the
  // activation webhook lands. Now the STAMP is the stale one. A fixed
  // "stamp wins" rule would send to the abandoned address — the very failure
  // #6335 set out to fix, with the two sources swapped.
  test("a users row refreshed after checkout outranks the stamped email", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    const checkoutIssuedAt = BASE_TIMESTAMP - 3600_000;

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        // Confirmed against Clerk AFTER the checkout was stamped.
        email: "newest@example.com",
        normalizedEmail: "newest@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: checkoutIssuedAt + 60_000,
      });
    });

    await processEvent(
      t,
      "wh_users_row_fresher_than_stamp",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          // Valid signature, inside the age window — but superseded.
          wm_login_email: "abandoned@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "abandoned@example.com",
            checkoutIssuedAt,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["newest@example.com"]);
    expect(sends.every((send) => send.to[0] !== "abandoned@example.com")).toBe(true);
  });

  // The boundary between the two rules: a users row last confirmed BEFORE the
  // checkout is the stale one, so the stamp wins. Same fixture as above with
  // only the timestamps' order flipped, which is what makes the comparison
  // itself — not some other difference — the thing under test.
  test("a users row last confirmed before checkout loses to the stamped email", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    const checkoutIssuedAt = BASE_TIMESTAMP - 3600_000;

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "abandoned@example.com",
        normalizedEmail: "abandoned@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: checkoutIssuedAt - 60_000,
      });
    });

    await processEvent(
      t,
      "wh_users_row_older_than_stamp",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "newest@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "newest@example.com",
            checkoutIssuedAt,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["newest@example.com"]);
    expect(sends.every((send) => send.to[0] !== "abandoned@example.com")).toBe(true);
  });

  test("a signed login email equal to the checkout address suppresses the pointer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      // Stale row that DIVERGES from the checkout address: without the signed
      // value the run would emit a pointer, so this pins that the divergence
      // verdict is recomputed against the signed email, not just the recipient.
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "stale@example.com",
        normalizedEmail: "stale@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(
      t,
      "wh_signed_login_email_matches_checkout",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "checkout@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "checkout@example.com",
            BASE_TIMESTAMP - 60_000,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    // Welcome + admin only — one inbox, so no sign-in pointer.
    expect(sends).toHaveLength(2);
    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["checkout@example.com"]);
  });

  test.each([
    [
      "a signature minted for a different account",
      async () => ({
        wm_login_email: "attacker@example.com",
        wm_login_email_sig: await signCheckoutLoginEmail(
          "user_someone_else",
          "attacker@example.com",
          BASE_TIMESTAMP - 60_000,
        ),
      }),
    ],
    [
      "an email swapped after signing",
      async () => ({
        wm_login_email: "attacker@example.com",
        wm_login_email_sig: await signCheckoutLoginEmail(
          "test-user-001",
          "fresh@example.com",
          BASE_TIMESTAMP - 60_000,
        ),
      }),
    ],
    [
      "a token older than the checkout window",
      async () => ({
        wm_login_email: "expired@example.com",
        wm_login_email_sig: await signCheckoutLoginEmail(
          "test-user-001",
          "expired@example.com",
          BASE_TIMESTAMP - CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS - 1,
        ),
      }),
    ],
    [
      "an unsigned login email",
      async () => ({ wm_login_email: "unsigned@example.com" }),
    ],
    [
      // Producible only by hand: the stamping side trims before signing. The
      // signature here genuinely covers the padding, so this is the one shape
      // where "verify then trim" would have sent to bytes nobody proved.
      "a padded login email whose signature covers the padding",
      async () => ({
        wm_login_email: "  padded@example.com  ",
        wm_login_email_sig: await signCheckoutLoginEmail(
          "test-user-001",
          "  padded@example.com  ",
          BASE_TIMESTAMP - 60_000,
        ),
      }),
    ],
    [
      // The mirror tamper shape: strip the address, keep the signature. Both
      // halves are stamped together, so either half alone is an anomaly.
      "a signature with the address stripped",
      async () => ({
        wm_login_email_sig: await signCheckoutLoginEmail(
          "test-user-001",
          "stripped@example.com",
          BASE_TIMESTAMP - 60_000,
        ),
      }),
    ],
  ])("%s never displaces the users row", async (_label, buildMetadata) => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      `wh_login_email_rejected_${_label.replace(/\W+/g, "_")}`,
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          ...(await buildMetadata()),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["login@example.com"]);
    // Whitelist rather than blacklist: every recipient must be one of the three
    // legitimate inboxes (login, checkout pointer, admin alert), so no
    // unverifiable metadata value can reach ANY send regardless of the shape it
    // arrived in (padding included).
    expect([...new Set(sends.map((send) => send.to[0]))].sort()).toEqual([
      "checkout@example.com",
      "elie@worldmonitor.app",
      "login@example.com",
    ]);
  });

  // The steady state, not an anomaly: Dodo re-delivers the ORIGINAL checkout's
  // metadata on every later `subscription.updated`, so a mature subscription
  // ages its stamped token out on each one. That must be quiet (console.log)
  // and must not spend the tamper warning, which is reserved for a token that
  // did not come from us.
  test("an aged-out replay on a mature subscription falls back without a warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "current@example.com",
        normalizedEmail: "current@example.com",
        firstSeenAt: BASE_TIMESTAMP - 400 * 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_mature_sub_aged_replay",
      "subscription.updated",
      makeSubscriptionPayload({
        status: "active",
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "year-old@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "year-old@example.com",
            BASE_TIMESTAMP - 365 * 86400000,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The year-old stamped address loses to the users row, which a page load
    // has refreshed many times since that checkout.
    const sends = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]: [unknown]) => String(url).includes("api.resend.com"))
      .map(([, init]: [unknown, RequestInit]) => JSON.parse(String(init.body)) as {
        to: string[];
        subject: string;
      });
    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["current@example.com"]);

    // And it did so silently. Pinning the ABSENCE of the tamper warning is the
    // point: without the expired/invalid split this fires on every mature
    // subscription and the real signal drowns.
    const loginEmailWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("wm_login_email"));
    expect(loginEmailWarnings).toEqual([]);
  });

  // Rotating DODO_IDENTITY_SIGNING_SECRET invalidates every in-flight stamped
  // token at once. The recipient must degrade to the users row rather than the
  // send failing or addressing an unverified value.
  test("a rotated signing secret degrades to the users row, it does not break the send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    // Stamped under the old secret...
    const metadata = {
      wm_user_id: "test-user-001",
      wm_user_id_sig: await signUserId("test-user-001"),
      wm_login_email: "fresh@example.com",
      wm_login_email_sig: await signCheckoutLoginEmail(
        "test-user-001",
        "fresh@example.com",
        BASE_TIMESTAMP - 60_000,
      ),
    };
    // ...delivered after the rotation. `wm_user_id_sig` is rotated in lockstep,
    // so attribution falls through to the customers row seeded by processEvent.
    process.env.DODO_IDENTITY_SIGNING_SECRET = "rotated-secret-value";

    await processEvent(
      t,
      "wh_rotated_secret",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata,
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["login@example.com"]);
  });

  test("a rejected signature on the reactivation path still reaches the users row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_prior_lapsed_reject",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(
      t,
      "wh_reactivation_rejected_sig",
      "subscription.active",
      makeSubscriptionPayload({
        subscription_id: "sub_returning_reject",
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "attacker@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "somethingelse@example.com",
            BASE_TIMESTAMP - 60_000,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    // The reactivation path gets the same fallback as the first-purchase path.
    const welcomeBack = sends.find((send) => send.subject.includes("Welcome back"));
    expect(welcomeBack?.to).toEqual(["login@example.com"]);
    expect(sends.every((send) => send.to[0] !== "attacker@example.com")).toBe(true);
  });

  test("a tampered login email still spends the warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      "wh_tampered_login_email_warns",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "attacker@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "fresh@example.com",
            BASE_TIMESTAMP - 60_000,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const loginEmailWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("wm_login_email"));
    expect(loginEmailWarnings).toHaveLength(1);
    expect(loginEmailWarnings[0]).toContain("failed signature verification");
  });

  // Every metadata shape that CANNOT have come from our own stamping side is an
  // anomaly and must warn — otherwise a corruption or tampering signal is
  // invisible. Reported by presence only: the address must never reach a
  // Sentry-forwarded string.
  test.each([
    [
      "a pair with the signature stripped",
      { wm_login_email: "half@example.com" },
      "email=present, signature=absent",
    ],
    [
      "a pair with the address stripped",
      { wm_login_email_sig: "v1.1.deadbeef" },
      "email=absent, signature=present",
    ],
    [
      // The stamping side always trims before signing, so padding here is
      // corruption or tampering even though the fallback is graceful.
      "a padded address",
      {
        wm_login_email: "  padded@example.com  ",
        wm_login_email_sig: "v1.1.deadbeef",
      },
      "Padded wm_login_email",
    ],
  ])("%s warns", async (_label, half, expectedShape) => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "login@example.com",
        normalizedEmail: "login@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await processEvent(
      t,
      `wh_half_present_${expectedShape.replace(/\W+/g, "_")}`,
      "subscription.active",
      makeSubscriptionPayload({
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          ...half,
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const loginEmailWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("wm_login_email"));
    expect(loginEmailWarnings).toHaveLength(1);
    expect(loginEmailWarnings[0]).toContain(expectedShape);
    // Presence only — the address itself never reaches the log line.
    expect(loginEmailWarnings[0]).not.toContain("@example.com");
  });

  // resolveSignedCheckoutLoginEmail's docstring claims the signature is checked
  // against the userId the handler ACTUALLY resolved, not the one the metadata
  // claims — so a token minted for an anonymous checkout id cannot follow the
  // subscription after preferExistingCustomerOwner reassigns it to the real
  // account that owns the Dodo customer. Nothing tested that claim.
  test("an anon-signed login email does not survive owner reassignment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    const anonId = "33333333-3333-4333-8333-333333333333";
    const realUserId = "user_real_owner_6335";

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      // The Dodo customer already belongs to a real account...
      await ctx.db.insert("customers", {
        userId: realUserId,
        dodoCustomerId: "cust_reassign_6335",
        email: "checkout@example.com",
        normalizedEmail: "checkout@example.com",
        createdAt: BASE_TIMESTAMP - 86400000,
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
      // ...whose users row carries the address that must win.
      await ctx.db.insert("users", {
        userId: realUserId,
        email: "realowner@example.com",
        normalizedEmail: "realowner@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_anon_signed_reassigned",
      eventType: "subscription.active",
      rawPayload: makeSubscriptionPayload({
        subscription_id: "sub_reassign_6335",
        customer: {
          customer_id: "cust_reassign_6335",
          email: "checkout@example.com",
          name: "Test User",
        },
        // Signed correctly — but for the ANONYMOUS id, which
        // preferExistingCustomerOwner discards in favour of the real owner.
        metadata: {
          wm_user_id: anonId,
          wm_user_id_sig: await signUserId(anonId),
          wm_login_email: "anon-typed@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            anonId,
            "anon-typed@example.com",
            BASE_TIMESTAMP - 60_000,
          ),
        },
      }),
      timestamp: BASE_TIMESTAMP,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The subscription landed on the real owner...
    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) =>
          q.eq("dodoSubscriptionId", "sub_reassign_6335"),
        )
        .unique(),
    );
    expect(sub?.userId).toBe(realUserId);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    // ...and so did the welcome. The anon-signed address never verifies against
    // the reassigned userId, so it cannot redirect a real account's mail.
    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["realowner@example.com"]);
    expect(sends.every((send) => send.to[0] !== "anon-typed@example.com")).toBe(true);
  });

  test("a signed login email is used even when no users row exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    await processEvent(
      t,
      "wh_signed_login_email_no_users_row",
      "subscription.active",
      makeSubscriptionPayload({
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "fresh@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "fresh@example.com",
            BASE_TIMESTAMP - 60_000,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    const welcome = sends.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["fresh@example.com"]);
  });

  test("reactivation targets the signed login email over a stale users row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIMESTAMP);
    process.env.RESEND_API_KEY = "re_test";
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "test-user-001",
        email: "stale@example.com",
        normalizedEmail: "stale@example.com",
        firstSeenAt: BASE_TIMESTAMP - 86400000,
        lastSeenAt: BASE_TIMESTAMP - 86400000,
      });
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_prior_lapsed",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(
      t,
      "wh_reactivation_signed_login_email",
      "subscription.active",
      makeSubscriptionPayload({
        subscription_id: "sub_returning_001",
        customer: {
          customer_id: "cust_test_001",
          email: "checkout@example.com",
          name: "Test User",
        },
        metadata: {
          wm_user_id: "test-user-001",
          wm_user_id_sig: await signUserId("test-user-001"),
          wm_login_email: "fresh@example.com",
          wm_login_email_sig: await signCheckoutLoginEmail(
            "test-user-001",
            "fresh@example.com",
            BASE_TIMESTAMP - 60_000,
          ),
        },
      }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
        html: string;
      });

    const welcomeBack = sends.find((send) => send.subject.includes("Welcome back"));
    expect(welcomeBack?.to).toEqual(["fresh@example.com"]);
    expect(welcomeBack?.html).toContain("fresh@example.com");
  });

  test("email templates escape HTML in interpolated addresses", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await t.action(internal.payments.subscriptionEmails.sendSubscriptionEmails, {
      userEmail: 'login<script>alert(1)</script>@example.com',
      planKey: "pro_monthly",
      userId: "test-user-001",
      checkoutEmail: 'checkout<img src=x>@example.com',
    });

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        html: string;
      });

    expect(sends.length).toBeGreaterThan(0);
    for (const send of sends) {
      expect(send.html).not.toContain("<script>");
      expect(send.html).not.toContain("<img src=x>");
    }
    expect(sends.some((send) => send.html.includes("&lt;script&gt;"))).toBe(true);
  });

  test.each([
    ["on_hold", BASE_TIMESTAMP + 7 * 86400000],
    ["cancelled", BASE_TIMESTAMP],
  ] as const)("subscription.active from non-lapsed %s remains email-silent", async (status, currentPeriodEnd) => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_test_001",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status,
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await processEvent(
      t,
      `wh_non_lapsed_${status}`,
      "subscription.active",
      makeSubscriptionPayload(),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("subscription.renewed extends billing period", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create active subscription via subscription.active event
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_003",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Renew with new billing dates
    const renewPayload = makeSubscriptionPayload({
      previous_billing_date: "2026-04-21T00:00:00Z",
      next_billing_date: "2026-05-21T00:00:00Z",
    });
    await processEvent(
      t,
      "wh_004",
      "subscription.renewed",
      renewPayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].currentPeriodStart).toBe(
      new Date("2026-04-21T00:00:00Z").getTime(),
    );
    expect(subs[0].currentPeriodEnd).toBe(
      new Date("2026-05-21T00:00:00Z").getTime(),
    );

    // Assert entitlements validUntil extended
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].validUntil).toBe(
      new Date("2026-05-21T00:00:00Z").getTime(),
    );
  });

  test("subscription.on_hold marks subscription at-risk without revoking entitlements", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create active subscription
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_005",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Put on hold
    const onHoldPayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_006",
      "subscription.on_hold",
      onHoldPayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("on_hold");

    // Entitlements still exist (NOT revoked)
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("pro_monthly");
  });

  test("subscription.cancelled preserves entitlements until period end", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create active subscription
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_007",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Cancel
    const cancelPayload = makeSubscriptionPayload({
      cancelled_at: "2026-03-25T10:00:00Z",
    });
    await processEvent(
      t,
      "wh_008",
      "subscription.cancelled",
      cancelPayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("cancelled");
    expect(subs[0].cancelledAt).toBe(
      new Date("2026-03-25T10:00:00Z").getTime(),
    );

    // Entitlements still exist with original validUntil (NOT revoked early)
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].validUntil).toBe(
      new Date("2026-04-21T00:00:00Z").getTime(),
    );
  });

  test("subscription.plan_changed api_starter -> api_business resolves the Business entitlement (#4634)", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_api_starter", "api_starter", "API Starter");
    await seedProductPlan(t, "pdt_test_api_business", "api_business", "API Business");

    // Active on Starter, then the Dodo collection upgrade fires plan_changed.
    await processEvent(
      t,
      "wh_up_01",
      "subscription.active",
      makeSubscriptionPayload({ product_id: "pdt_test_api_starter" }),
      BASE_TIMESTAMP,
    );
    await processEvent(
      t,
      "wh_up_02",
      "subscription.plan_changed",
      makeSubscriptionPayload({ product_id: "pdt_test_api_business" }),
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run((ctx) => ctx.db.query("subscriptions").collect());
    expect(subs).toHaveLength(1);
    expect(subs[0].planKey).toBe("api_business");

    const entitlements = await t.run((ctx) => ctx.db.query("entitlements").collect());
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("api_business");
    expect(entitlements[0].features).toMatchObject({ apiAccess: true, apiRateLimit: 300 });
  });

  test("subscription.plan_changed updates product and entitlements", async () => {
    const t = convexTest(schema, modules);

    // Seed TWO product plans
    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await seedProductPlan(t, "pdt_test_api", "api_starter", "API Starter");

    // Create active subscription with pro_monthly
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_009",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Change plan to api_starter
    const planChangePayload = makeSubscriptionPayload({
      product_id: "pdt_test_api",
    });
    await processEvent(
      t,
      "wh_010",
      "subscription.plan_changed",
      planChangePayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].dodoProductId).toBe("pdt_test_api");
    expect(subs[0].planKey).toBe("api_starter");

    // Entitlements should match api_starter features
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("api_starter");
    expect(entitlements[0].features).toMatchObject({
      apiAccess: true,
      apiRateLimit: 60,
      maxDashboards: 25,
    });
  });

  test("payment.succeeded creates audit record", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.succeeded");
    await processEvent(
      t,
      "wh_011",
      "payment.succeeded",
      payload,
      BASE_TIMESTAMP,
    );

    const paymentEvents = await t.run(async (ctx) => {
      return ctx.db.query("paymentEvents").collect();
    });
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("succeeded");
    expect(paymentEvents[0].amount).toBe(1999);
    expect(paymentEvents[0].currency).toBe("USD");
    expect(paymentEvents[0].type).toBe("charge");
  });

  test("payment.failed creates audit record", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.failed");
    await processEvent(
      t,
      "wh_012",
      "payment.failed",
      payload,
      BASE_TIMESTAMP,
    );

    const paymentEvents = await t.run(async (ctx) => {
      return ctx.db.query("paymentEvents").collect();
    });
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("failed");
  });

  // WORLDMONITOR-YA — every other test in this file routes through `processEvent`,
  // which pre-seeds a `customers` row, so the production shape (no customer row,
  // unsigned metadata) was never exercised. These two dispatch the mutation
  // directly to cover it.
  test("payment.failed resolves the userId from a known subscription when no customer row exists", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "user_known_via_sub",
        dodoSubscriptionId: "sub_no_customer_row",
        dodoCustomerId: "cust_never_recorded",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP,
        currentPeriodEnd: BASE_TIMESTAMP + 86_400_000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP,
      });
    });

    // Unsigned metadata is ignored by resolveUserId, and no `customers` row
    // exists — the subscription row is the only identity source.
    const payload = makePaymentPayload("payment.failed", {
      payment_id: "pay_no_customer_row",
      subscription_id: "sub_no_customer_row",
      customer: { customer_id: "cust_never_recorded", email: "nobody@example.com" },
      metadata: {},
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_ya_sub_fallback",
      eventType: "payment.failed",
      rawPayload: payload,
      timestamp: BASE_TIMESTAMP,
    });

    const paymentEvents = await t.run(async (ctx) => {
      return ctx.db.query("paymentEvents").collect();
    });
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].userId).toBe("user_known_via_sub");
    expect(paymentEvents[0].status).toBe("failed");
  });

  // Previously this asserted the mutation threw. That was wrong in production:
  // the identity lookup is deterministic, so every one of Dodo's 8 retries
  // failed identically and a buyer abandoning 3DS raised a "delivery
  // permanently failed" alert. No charge settled, so there is nothing to
  // record — acknowledge it. See isChargedEventType in unattributedPayments.ts.
  test("payment.failed for a wholly unknown customer is acknowledged, not dead-lettered", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.failed", {
      payment_id: "pay_unattributable",
      subscription_id: "sub_unattributable",
      customer: { customer_id: "cust_unattributable", email: "nobody@example.com" },
      metadata: {},
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_ya_unattributable",
      eventType: "payment.failed",
      rawPayload: payload,
      timestamp: BASE_TIMESTAMP,
    });

    // Still records nothing — there is no user to attribute the row to.
    const paymentEvents = await t.run(async (ctx) => {
      return ctx.db.query("paymentEvents").collect();
    });
    expect(paymentEvents).toHaveLength(0);
  });

  test("payment.succeeded for a wholly unknown customer is captured for attribution", async () => {
    const t = convexTest(schema, modules);

    // Money moved. It must never be silently discarded — but throwing only
    // burned Dodo's retries and lost it, so it is captured durably instead and
    // flagged `charged` for the ops alert. See unattributed-payments.test.ts.
    const payload = makePaymentPayload("payment.succeeded", {
      payment_id: "pay_unattributable_paid",
      subscription_id: "sub_unattributable_paid",
      customer: { customer_id: "cust_unattributable", email: "nobody@example.com" },
      metadata: {},
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_ya_unattributable_paid",
      eventType: "payment.succeeded",
      rawPayload: payload,
      timestamp: BASE_TIMESTAMP,
    });

    const { paymentEvents, unattributed } = await t.run(async (ctx) => ({
      paymentEvents: await ctx.db.query("paymentEvents").collect(),
      unattributed: await ctx.db.query("unattributedPaymentEvents").collect(),
    }));
    // No paymentEvents row — it requires a userId we do not have.
    expect(paymentEvents).toHaveLength(0);
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0].charged).toBe(true);
    expect(unattributed[0].dodoCustomerId).toBe("cust_unattributable");
  });

  // #5056 — entitlement lifecycle integrity across claim, active webhook, and dispute races.
  test("subscription.active keeps claimed real owner when stale signed anon metadata arrives", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const realUserId = "user_claimed_subscription";
    const anonId = "22222222-2222-4222-8222-222222222222";
    const customerId = "cust_claimed_001";
    const subscriptionId = "sub_claimed_001";
    const anonSig = await signUserId(anonId);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: realUserId,
        dodoSubscriptionId: subscriptionId,
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP,
        dodoCustomerId: customerId,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId: realUserId,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_claimed_stale_anon",
      eventType: "subscription.active",
      rawPayload: makeSubscriptionPayload({
        subscription_id: subscriptionId,
        customer: {
          customer_id: customerId,
          email: "claimed@example.com",
          name: "Claimed User",
        },
        metadata: { wm_user_id: anonId, wm_user_id_sig: anonSig },
        next_billing_date: "2026-05-21T00:00:00Z",
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [sub, customer, realEntitlement, anonEntitlement] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", subscriptionId)).unique(),
        ctx.db.query("customers").withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", customerId)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", realUserId)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", anonId)).first(),
      ]);
      return { sub, customer, realEntitlement, anonEntitlement };
    });
    expect(rows.sub?.userId).toBe(realUserId);
    expect(rows.customer?.userId).toBe(realUserId);
    expect(rows.realEntitlement?.planKey).toBe("pro_monthly");
    expect(rows.realEntitlement?.validUntil).toBe(new Date("2026-05-21T00:00:00Z").getTime());
    expect(rows.anonEntitlement).toBeNull();
  });

  test("subscription.active uses signed real metadata for a new sub even when the Dodo customer row exists", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const previousUserId = "user_existing_customer";
    const newUserId = "user_new_signed_checkout";
    const customerId = "cust_shared_real";
    const subscriptionId = "sub_new_signed_real";
    const userSig = await signUserId(newUserId);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: previousUserId,
        dodoCustomerId: customerId,
        email: "shared@example.com",
        normalizedEmail: "shared@example.com",
        createdAt: BASE_TIMESTAMP - 1000,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_new_signed_real_shared_customer",
      eventType: "subscription.active",
      rawPayload: makeSubscriptionPayload({
        subscription_id: subscriptionId,
        customer: { customer_id: customerId, email: "shared@example.com", name: "Shared Customer" },
        metadata: { wm_user_id: newUserId, wm_user_id_sig: userSig },
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [sub, entitlement] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", subscriptionId)).unique(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", newUserId)).first(),
      ]);
      return { sub, entitlement };
    });
    expect(rows.sub?.userId).toBe(newUserId);
    expect(rows.entitlement?.planKey).toBe("pro_monthly");
  });

  test("dispute.lost expires only the disputed subscription when another active subscription covers the user", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_dispute_multi";

    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId,
        dodoCustomerId: "cust_dispute_multi",
        email: "multi@example.com",
        normalizedEmail: "multi@example.com",
        createdAt: BASE_TIMESTAMP - 1000,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("subscriptions", {
        userId,
        dodoSubscriptionId: "sub_disputed_multi",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 30 * 86400000,
        dodoCustomerId: "cust_dispute_multi",
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("subscriptions", {
        userId,
        dodoSubscriptionId: "sub_cover_multi",
        dodoProductId: "pdt_test_api",
        planKey: "api_starter",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 45 * 86400000,
        dodoCustomerId: "cust_dispute_multi",
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: BASE_TIMESTAMP + 30 * 86400000,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_dispute_multi",
      eventType: "dispute.lost",
      rawPayload: makePaymentPayload("payment.succeeded", {
        payment_id: "pay_dispute_multi",
        subscription_id: "sub_disputed_multi",
        customer: { customer_id: "cust_dispute_multi", email: "multi@example.com" },
        metadata: { wm_user_id: userId },
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [disputed, cover, entitlement, paymentEvent] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_disputed_multi")).unique(),
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_cover_multi")).unique(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", userId)).first(),
        ctx.db.query("paymentEvents").withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_dispute_multi")).first(),
      ]);
      return { disputed, cover, entitlement, paymentEvent };
    });
    expect(rows.disputed?.status).toBe("expired");
    expect(rows.cover?.status).toBe("active");
    expect(rows.entitlement?.planKey).toBe("api_starter");
    expect(rows.entitlement?.validUntil).toBe(BASE_TIMESTAMP + 45 * 86400000);
    expect(rows.entitlement?.features.tier).toBe(getFeaturesForPlan("api_starter").tier);
    expect(rows.paymentEvent?.status).toBe("dispute_lost");
  });

  test("dispute.lost preserves a future complimentary entitlement floor", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_dispute_comp";
    const compUntil = BASE_TIMESTAMP + 60 * 86400000;

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId,
        dodoSubscriptionId: "sub_dispute_comp",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 30 * 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: compUntil,
        compUntil,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_dispute_comp",
      eventType: "dispute.lost",
      rawPayload: makePaymentPayload("payment.succeeded", {
        payment_id: "pay_dispute_comp",
        subscription_id: "sub_dispute_comp",
        customer: { customer_id: "cust_dispute_comp", email: "comp@example.com" },
        metadata: { wm_user_id: userId },
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [sub, entitlement] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_dispute_comp")).unique(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", userId)).first(),
      ]);
      return { sub, entitlement };
    });
    expect(rows.sub?.status).toBe("expired");
    expect(rows.entitlement?.planKey).toBe("pro_monthly");
    expect(rows.entitlement?.validUntil).toBe(compUntil);
    expect(rows.entitlement?.compUntil).toBe(compUntil);
  });

  // #4436 — Dodo delivers the 3DS/SCA-pending state as a `payment.processing`
  // event whose payload `data.status` (IntentStatus) is `requires_customer_action`
  // (`payment.requires_customer_action` is NOT a Dodo event type). Before the
  // fix `payment.processing` hit the `default` branch and was silently dropped,
  // so the app had no pending-payment signal for duplicate-prevention (#4438) /
  // reconciliation (#4439).
  test.each([
    ["requires_customer_action", "requires_customer_action"],
    ["processing", "processing"],
  ] as const)(
    "payment.processing with data.status=%s persists status %s",
    async (payloadStatus, expectedStatus) => {
      const t = convexTest(schema, modules);

      const payload = makePaymentPayload("payment.processing", { status: payloadStatus });
      await processEvent(t, `wh_proc_${expectedStatus}`, "payment.processing", payload, BASE_TIMESTAMP);

      const paymentEvents = await t.run(async (ctx) =>
        ctx.db.query("paymentEvents").collect(),
      );
      expect(paymentEvents).toHaveLength(1);
      expect(paymentEvents[0].status).toBe(expectedStatus);
      expect(paymentEvents[0].type).toBe("charge");
      expect(paymentEvents[0].dodoPaymentId).toBe("pay_test_001");
    },
  );

  // #4438 — the pending-payment dedup guard needs to resolve a pending row to a
  // tier group. The session-create metadata bridge carries `wm_plan_key` the
  // same way it carries `wm_user_id`; the webhook persists it on the
  // `paymentEvents` row so a later checkout can read PRODUCT_CATALOG[planKey].
  test("payment.processing persists planKey from data.metadata.wm_plan_key", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.processing", {
      status: "requires_customer_action",
      metadata: { wm_user_id: "test-user-001", wm_plan_key: "pro_monthly" },
    });
    await processEvent(t, "wh_plankey_proc", "payment.processing", payload, BASE_TIMESTAMP);

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db.query("paymentEvents").collect(),
    );
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("requires_customer_action");
    expect(paymentEvents[0].planKey).toBe("pro_monthly");
  });

  // Backward-compat: a session created before this shipped carries no
  // `wm_plan_key`. The row must still persist (planKey simply undefined) — never
  // throw — and the guard fails open for that legacy pending payment.
  test("payment.processing without wm_plan_key persists row with undefined planKey", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.processing", { status: "processing" });
    await processEvent(t, "wh_no_plankey", "payment.processing", payload, BASE_TIMESTAMP);

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db.query("paymentEvents").collect(),
    );
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].planKey).toBeUndefined();
  });

  test("payment.cancelled persists a cancelled paymentEvents row", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.cancelled");
    await processEvent(t, "wh_pay_cancelled", "payment.cancelled", payload, BASE_TIMESTAMP);

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db.query("paymentEvents").collect(),
    );
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("cancelled");
  });

  // #4436 correction (validated): dedup is by webhookId ONLY. A later DISTINCT
  // transition (new webhookId, same payment_id) must still process — it is not
  // blocked by the earlier 3DS-pending webhook being recorded.
  test("3DS-pending (payment.processing) then a distinct succeeded webhook both persist", async () => {
    const t = convexTest(schema, modules);

    await processEvent(
      t,
      "wh_3ds_pending",
      "payment.processing",
      makePaymentPayload("payment.processing", { status: "requires_customer_action" }),
      BASE_TIMESTAMP,
    );
    await processEvent(
      t,
      "wh_3ds_succeeded",
      "payment.succeeded",
      makePaymentPayload("payment.succeeded"),
      BASE_TIMESTAMP + 5000,
    );

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db
        .query("paymentEvents")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_test_001"))
        .collect(),
    );
    expect(paymentEvents.map((e) => e.status).sort()).toEqual([
      "requires_customer_action",
      "succeeded",
    ]);

    const webhookEvents = await t.run(async (ctx) =>
      ctx.db.query("webhookEvents").collect(),
    );
    expect(webhookEvents).toHaveLength(2);
  });

  test("duplicate webhook-id is deduplicated", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    const payload = makeSubscriptionPayload();

    // Call twice with the same webhookId
    await processEvent(t, "wh_dup", "subscription.active", payload, BASE_TIMESTAMP);
    await processEvent(
      t,
      "wh_dup",
      "subscription.active",
      payload,
      BASE_TIMESTAMP + 1000,
    );

    // Only 1 webhookEvents record
    const events = await t.run(async (ctx) => {
      return ctx.db.query("webhookEvents").collect();
    });
    expect(events).toHaveLength(1);

    // Only 1 subscription record
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
  });

  test.each([
    ["dispute.opened", "dispute_opened"],
    ["dispute.won", "dispute_won"],
    ["dispute.lost", "dispute_lost"],
    ["dispute.closed", "dispute_closed"],
  ] as const)("%s maps to %s status", async (eventType, expectedStatus) => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.succeeded");
    const webhookId = `wh_${eventType.replace(".", "_")}`;
    await processEvent(t, webhookId, eventType, payload, BASE_TIMESTAMP);

    const events = await t.run(async (ctx) => ctx.db.query("paymentEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(expectedStatus);
  });

  test("out-of-order events are rejected", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create subscription with timestamp 1000
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_013",
      "subscription.active",
      activatePayload,
      1000,
    );

    // Try to put on_hold with timestamp 500 (older)
    const onHoldPayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_014",
      "subscription.on_hold",
      onHoldPayload,
      500,
    );

    // Subscription status should still be "active" (older event ignored)
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("active");
  });
});
