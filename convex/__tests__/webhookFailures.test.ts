import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

async function makeT(): Promise<ReturnType<typeof convexTest>> {
  const t = convexTest(schema, modules);
  await t.mutation(
    internal.payments.webhookMutations._seedFailureSummary,
    {},
  );
  return t;
}

const BASE_TIMESTAMP = new Date("2026-07-23T10:00:00Z").getTime();
const DODO_SECRET_BYTES = new Uint8Array([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87,
  0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f,
]);
const DODO_WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...DODO_SECRET_BYTES))}`;

async function signDodoPayload(
  body: string,
  webhookId: string,
  timestampSeconds: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    DODO_SECRET_BYTES,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${webhookId}.${timestampSeconds}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

function makeProviderValidSubscriptionPayload() {
  return {
    business_id: "biz_failure_test",
    type: "subscription.active",
    timestamp: new Date(BASE_TIMESTAMP).toISOString(),
    data: {
      payload_type: "Subscription",
      addons: [],
      billing: { city: null, country: "US", state: null, street: null, zipcode: null },
      cancel_at_next_billing_date: false,
      cancelled_at: null,
      created_at: new Date(BASE_TIMESTAMP).toISOString(),
      currency: "USD",
      customer: {
        customer_id: "cus_http_failure",
        email: "bad@example.com",
        metadata: {},
        name: "Unresolved Customer",
        phone_number: null,
      },
      custom_field_responses: null,
      discount_cycles_remaining: null,
      discount_id: null,
      expires_at: null,
      credit_entitlement_cart: [],
      meter_credit_entitlement_cart: [],
      meters: [],
      metadata: {},
      next_billing_date: new Date(BASE_TIMESTAMP + 30 * 86400000).toISOString(),
      on_demand: false,
      payment_frequency_count: 1,
      payment_frequency_interval: "Month",
      payment_method_id: null,
      previous_billing_date: new Date(BASE_TIMESTAMP).toISOString(),
      product_id: "pdt_http_failure",
      quantity: 1,
      recurring_pre_tax_amount: 1999,
      status: "active",
      subscription_id: "sub_http_failure",
      subscription_period_count: 1,
      subscription_period_interval: "Month",
      tax_id: null,
      tax_inclusive: true,
      trial_period_days: 0,
    },
  };
}

function failureArgs(overrides: Record<string, unknown> = {}) {
  return {
    webhookId: "wh_failure_001",
    eventType: "subscription.renewed",
    rawPayload: {
      type: "subscription.renewed",
      data: {
        subscription_id: "sub_failure_001",
        payment_id: "pay_failure_001",
        customer: {
          customer_id: "cus_failure_001",
          email: "subscriber@example.com",
        },
        metadata: {
          wm_user_id: "user_failure_001",
          secret: "should-not-be-persisted",
        },
        next_billing_date: "2026-08-23T10:00:00Z",
      },
    },
    timestamp: BASE_TIMESTAMP,
    receivedAt: BASE_TIMESTAMP,
    errorKind: "ValidationError",
    errorMessage: "invalid subscription for subscriber@example.com secret=should-not-be-persisted",
    ...overrides,
  };
}

describe("Dodo webhook failure tracking", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
  });

  test("dead-letters an application-invalid subscription received through the HTTP handler", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    process.env.DODO_PAYMENTS_WEBHOOK_SECRET = DODO_WEBHOOK_SECRET;
    const t = await makeT();
    const body = JSON.stringify(makeProviderValidSubscriptionPayload());
    const webhookId = "wh_http_failure_001";
    const timestampSeconds = String(Math.floor(BASE_TIMESTAMP / 1000));
    const signature = await signDodoPayload(body, webhookId, timestampSeconds);

    const response = await t.fetch("/dodopayments-webhook", {
      method: "POST",
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": timestampSeconds,
        "webhook-signature": signature,
      },
      body,
    });
    await t.finishInProgressScheduledFunctions();

    expect(response.status).toBe(500);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId,
      eventType: "subscription.active",
      dodoSubscriptionId: "sub_http_failure",
      dodoCustomerId: "cus_http_failure",
      unresolved: true,
      attemptCount: 1,
    });
    expect("rawPayload" in rows[0]).toBe(false);

    const reportLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await t.mutation(
      internal.payments.webhookMutations.reportDodoWebhookFailure,
      {
        webhookId,
        eventType: "subscription.active",
        errorKind: "Error",
        errorMessage: "Cannot resolve userId",
        attemptCount: 1,
        unresolvedCount: 1,
        eventTypes: ["subscription.active"],
      },
    );
    expect(reportLog).toHaveBeenCalledWith(
      expect.stringContaining("unresolvedCount=1"),
    );
  });

  test("queues the production operations signal after the failure commits", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    try {
      vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
      process.env.DODO_PAYMENTS_WEBHOOK_SECRET = DODO_WEBHOOK_SECRET;
      const t = await makeT();
      const body = JSON.stringify(makeProviderValidSubscriptionPayload());
      const webhookId = "wh_http_signal_001";
      const timestampSeconds = String(Math.floor(BASE_TIMESTAMP / 1000));
      const signature = await signDodoPayload(body, webhookId, timestampSeconds);

      const response = await t.fetch("/dodopayments-webhook", {
        method: "POST",
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": timestampSeconds,
          "webhook-signature": signature,
        },
        body,
      });

      expect(response.status).toBe(500);
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const reportJobs = scheduled.filter((job) =>
        job.name.includes("reportDodoWebhookFailure"),
      );
      expect(reportJobs).toHaveLength(1);
      expect(reportJobs[0].args).toEqual([
        expect.objectContaining({
          webhookId,
          eventType: "subscription.active",
          attemptCount: 1,
          unresolvedCount: 1,
          eventTypes: ["subscription.active"],
        }),
      ]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  test("records sanitized context for a malformed subscription event", async () => {
    const t = await makeT();

    await expect(
      t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
        webhookId: "wh_malformed_subscription",
        eventType: "subscription.renewed",
        rawPayload: {
          type: "subscription.renewed",
          data: { payment_id: "pay_malformed", customer: { email: "bad@example.com" } },
        },
        timestamp: BASE_TIMESTAMP,
      }),
    ).rejects.toThrow(/Missing subscription_id/);

    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        webhookId: "wh_malformed_subscription",
        rawPayload: {
          type: "subscription.renewed",
          data: {
            payment_id: "pay_malformed",
            customer: { email: "bad@example.com" },
          },
        },
      }),
    );

    expect(signal).toMatchObject({
      isNew: true,
      attemptCount: 1,
      unresolvedCount: 1,
      eventTypes: ["subscription.renewed"],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId: "wh_malformed_subscription",
      eventType: "subscription.renewed",
      dodoPaymentId: "pay_malformed",
      unresolved: true,
      attemptCount: 1,
      dataKeys: ["customer", "payment_id"],
    });
    expect(rows[0].errorMessage).toBe("invalid subscription for [redacted-email] secret=[redacted]");
    expect("rawPayload" in rows[0]).toBe(false);
  });

  test("updates the same failure row for repeated webhook deliveries", async () => {
    const t = await makeT();

    const first = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    const second = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        timestamp: BASE_TIMESTAMP + 5000,
        receivedAt: BASE_TIMESTAMP + 5000,
        errorMessage: "still invalid",
      }),
    );

    expect(first.isNew).toBe(true);
    expect(second).toMatchObject({
      isNew: false,
      attemptCount: 2,
      unresolvedCount: 1,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(2);
    expect(rows[0].lastSeenAt).toBe(BASE_TIMESTAMP + 5000);
  });

  test("keeps one row across overlapping same-ID mutation requests", async () => {
    const t = await makeT();

    // convex-test currently executes top-level functions one at a time, so
    // this proves the idempotent outcome but not a production OCC retry. The
    // shared pre-seeded summary read is the production serialization point.
    const [first, second] = await Promise.all([
      t.mutation(
        internal.payments.webhookMutations.recordWebhookFailure,
        failureArgs(),
      ),
      t.mutation(
        internal.payments.webhookMutations.recordWebhookFailure,
        failureArgs({ errorMessage: "same delivery, concurrent attempt" }),
      ),
    ]);

    expect([first.isNew, second.isNew].sort()).toEqual([false, true]);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(2);

    const summary = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      {},
    );
    expect(summary.unresolvedCount).toBe(1);
  });

  test("tolerates and self-heals duplicate summary seed rows", async () => {
    const t = await makeT();
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentWebhookFailureSummary", {
        key: "global",
        unresolvedCount: 0,
        eventTypes: [],
        updatedAt: BASE_TIMESTAMP,
      });
    });

    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    expect(signal).toMatchObject({
      attemptCount: 1,
      unresolvedCount: 1,
      eventTypes: ["subscription.renewed"],
    });

    const diagnostics = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      {},
    );
    expect(diagnostics.unresolvedCount).toBe(1);

    const seed = await t.mutation(
      internal.payments.webhookMutations._seedFailureSummary,
      {},
    );
    expect(seed).toEqual({ seeded: 0, deduped: 1 });
    const summaries = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      unresolvedCount: 1,
      eventTypes: [{ eventType: "subscription.renewed", count: 1 }],
    });
  });

  test("keeps distinct webhook IDs separate for the same subscription", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({ webhookId: "wh_failure_a" }),
    );
    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({ webhookId: "wh_failure_b" }),
    );

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.dodoSubscriptionId)).toEqual([
      "sub_failure_001",
      "sub_failure_001",
    ]);
    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 2,
      eventTypes: [{ eventType: "subscription.renewed", count: 2 }],
    });

    const diagnostics = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      { limit: 10 },
    );
    expect(diagnostics).toMatchObject({
      unresolvedCount: 2,
      eventTypes: [{ eventType: "subscription.renewed", count: 2 }],
    });
    expect(diagnostics.failures).toHaveLength(2);
    expect("rawPayload" in diagnostics.failures[0]).toBe(false);
  });

  test("resolves a failure and removes it from the unresolved diagnostic query", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    await t.mutation(
      internal.payments.webhookMutations.resolveWebhookFailure,
      {
        webhookId: "wh_failure_001",
        resolvedBy: "on-call@example.com",
        resolutionNote: "Reconciled the subscription manually",
      },
    );

    const unresolved = await t.query(
      internal.payments.webhookMutations.listUnresolvedWebhookFailures,
      {},
    );
    expect(unresolved).toHaveLength(0);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows[0]).toMatchObject({
      unresolved: false,
      resolvedBy: "on-call@example.com",
      resolutionNote: "Reconciled the subscription manually",
    });
    expect(rows[0].resolvedAt).toBeTypeOf("number");

    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 0,
      eventTypes: [],
    });
  });

  test("automatically resolves a transient failure after a successful retry", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    await t.mutation(
      internal.payments.webhookMutations.markWebhookFailureRecovered,
      { webhookId: "wh_failure_001" },
    );

    const unresolved = await t.query(
      internal.payments.webhookMutations.listUnresolvedWebhookFailures,
      {},
    );
    expect(unresolved).toHaveLength(0);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows[0]).toMatchObject({
      unresolved: false,
      resolvedBy: "dodo-retry",
      resolutionNote: "Processed successfully on provider retry",
    });
  });

  test("recovers a failure through the signed HTTP retry path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    vi.stubEnv("RESEND_API_KEY", "");
    process.env.DODO_PAYMENTS_WEBHOOK_SECRET = DODO_WEBHOOK_SECRET;
    const t = await makeT();
    const payload = makeProviderValidSubscriptionPayload();
    const webhookId = "wh_http_recovery_001";

    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_http_recovery",
        dodoCustomerId: payload.data.customer.customer_id,
        email: payload.data.customer.email,
        normalizedEmail: payload.data.customer.email,
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP,
      });
    });
    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        webhookId,
        eventType: payload.type,
        rawPayload: payload,
      }),
    );

    const body = JSON.stringify(payload);
    const timestampSeconds = String(Math.floor(BASE_TIMESTAMP / 1000));
    const signature = await signDodoPayload(body, webhookId, timestampSeconds);
    const response = await t.fetch("/dodopayments-webhook", {
      method: "POST",
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": timestampSeconds,
        "webhook-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId,
      unresolved: false,
      resolvedBy: "dodo-retry",
      resolutionNote: "Processed successfully on provider retry",
    });

    const diagnostics = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      {},
    );
    expect(diagnostics.unresolvedCount).toBe(0);
    expect(diagnostics.failures).toHaveLength(0);
  });

  test("moves the event bucket when a redelivery changes event type", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        eventType: "subscription.on_hold",
        rawPayload: {
          type: "subscription.on_hold",
          data: { subscription_id: "sub_failure_001" },
        },
      }),
    );

    expect(signal).toMatchObject({
      isNew: false,
      attemptCount: 2,
      unresolvedCount: 1,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("subscription.on_hold");

    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 1,
      eventTypes: [{ eventType: "subscription.on_hold", count: 1 }],
    });
  });

  test("reopens a resolved incident as a fresh unresolved failure", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    await t.mutation(
      internal.payments.webhookMutations.resolveWebhookFailure,
      {
        webhookId: "wh_failure_001",
        resolvedBy: "on-call@example.com",
      },
    );
    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        timestamp: BASE_TIMESTAMP + 5000,
        receivedAt: BASE_TIMESTAMP + 5000,
      }),
    );

    expect(signal).toMatchObject({
      isNew: false,
      attemptCount: 2,
      unresolvedCount: 1,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unresolved: true, attemptCount: 2 });
    expect(rows[0].resolvedAt).toBeUndefined();
    expect(rows[0].resolvedBy).toBeUndefined();
    expect(rows[0].resolutionNote).toBeUndefined();

    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 1,
      eventTypes: [{ eventType: "subscription.renewed", count: 1 }],
    });
  });

  test("dead-letters an authenticated but schema-invalid payload with 500, not 401", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    process.env.DODO_PAYMENTS_WEBHOOK_SECRET = DODO_WEBHOOK_SECRET;
    const t = await makeT();
    const body = JSON.stringify({
      business_id: "biz_failure_test",
      type: "subscription.active",
      timestamp: new Date(BASE_TIMESTAMP).toISOString(),
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_schema_invalid",
      },
    });
    const webhookId = "wh_http_schema_invalid";
    const timestampSeconds = String(Math.floor(BASE_TIMESTAMP / 1000));
    const signature = await signDodoPayload(body, webhookId, timestampSeconds);

    const response = await t.fetch("/dodopayments-webhook", {
      method: "POST",
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": timestampSeconds,
        "webhook-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toBe("Invalid webhook signature");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId,
      eventType: "subscription.active",
      dodoSubscriptionId: "sub_schema_invalid",
      errorKind: "ZodError",
      unresolved: true,
      attemptCount: 1,
    });
    expect("rawPayload" in rows[0]).toBe(false);
  });

  test("dead-letters an authenticated but unparseable body with 500, not 401", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    process.env.DODO_PAYMENTS_WEBHOOK_SECRET = DODO_WEBHOOK_SECRET;
    const t = await makeT();
    const body = "this is not json";
    const webhookId = "wh_http_unparseable";
    const timestampSeconds = String(Math.floor(BASE_TIMESTAMP / 1000));
    const signature = await signDodoPayload(body, webhookId, timestampSeconds);

    const response = await t.fetch("/dodopayments-webhook", {
      method: "POST",
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": timestampSeconds,
        "webhook-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(500);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId,
      eventType: "unknown",
      errorKind: "SyntaxError",
      dataKeys: [],
      unresolved: true,
      attemptCount: 1,
    });
    expect("rawPayload" in rows[0]).toBe(false);
  });

  test("still rejects a bad signature with 401 and records no failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    process.env.DODO_PAYMENTS_WEBHOOK_SECRET = DODO_WEBHOOK_SECRET;
    const t = await makeT();
    const body = JSON.stringify(makeProviderValidSubscriptionPayload());
    const webhookId = "wh_http_bad_signature";
    const timestampSeconds = String(Math.floor(BASE_TIMESTAMP / 1000));

    const response = await t.fetch("/dodopayments-webhook", {
      method: "POST",
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": timestampSeconds,
        "webhook-signature": "v1,AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDDEEEEEEEE=",
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid webhook signature");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
