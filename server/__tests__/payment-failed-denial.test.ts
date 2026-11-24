// @vitest-environment node

// #11213 end to end: Dodo's real failed-renewal webhook sequence, the real
// Convex /api/internal-entitlements action, and the edge gates that read it.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { PRODUCT_CATALOG } from "../../convex/config/productCatalog";
import { ON_HOLD_ACCESS_GRACE_MS } from "../../convex/payments/subscriptionHelpers";

vi.mock("../_shared/redis", () => ({
  getCachedJson: vi.fn(),
  setCachedJson: vi.fn(),
}));

import { getCachedJson, setCachedJson } from "../_shared/redis";
import {
  __resetEntitlementNegativeCacheForTests,
  checkEntitlementDetailed,
  getEntitlements,
} from "../_shared/entitlement-check";
import { checkProMcpAccess } from "../_shared/pro-mcp-gate";

const modules = import.meta.glob("../../convex/**/*.ts");
const DAY = 86_400_000;
const USER = "user-payment-failed";
const SUB_ID = "sub_payment_failed";
const PRO = PRODUCT_CATALOG.pro_monthly.dodoProductId!;
const SECRET = "test-convex-secret-payment-failed";
const PRO_PATH = "/api/market/v1/analyze-stock";

const ACTIVATED = Date.UTC(2026, 11, 1);
const RENEWAL = ACTIVATED + 31 * DAY;
const HOLD = RENEWAL + 1000;
const NEXT_RENEWAL = RENEWAL + 31 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();
const cache = new Map<string, { value: unknown; expiresAt: number }>();

type T = ReturnType<typeof convexTest>;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      payload_type: "Subscription",
      subscription_id: SUB_ID,
      product_id: PRO,
      status: "active",
      customer: { customer_id: "cust_payment_failed", email: "paused@example.com", name: "Paused" },
      metadata: { wm_user_id: USER },
      previous_billing_date: iso(ACTIVATED),
      next_billing_date: iso(RENEWAL),
      ...overrides,
    },
  };
}

async function event(t: T, id: string, type: string, body: Record<string, unknown>, at: number) {
  vi.setSystemTime(at);
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: id,
    eventType: type,
    rawPayload: body,
    timestamp: at,
  });
}

async function charge(t: T, id: string, at: number, status: "succeeded" | "failed") {
  await t.run(async (ctx) => {
    await ctx.db.insert("paymentEvents", {
      userId: USER,
      dodoPaymentId: id,
      type: "charge",
      amount: 3900,
      currency: "USD",
      status,
      dodoSubscriptionId: SUB_ID,
      rawPayload: {},
      occurredAt: at,
    });
  });
}

async function failedRenewal(): Promise<T> {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", { dodoProductId: PRO, planKey: "pro_monthly", displayName: "Pro", isActive: true });
    await ctx.db.insert("customers", {
      userId: USER,
      dodoCustomerId: "cust_payment_failed",
      email: "paused@example.com",
      createdAt: ACTIVATED,
      updatedAt: ACTIVATED,
    });
  });
  await event(t, "wh_active", "subscription.active", payload(), ACTIVATED);
  await charge(t, "pay_first", ACTIVATED, "succeeded");
  const unpaidMonth = { previous_billing_date: iso(RENEWAL), next_billing_date: iso(NEXT_RENEWAL) };
  await event(t, "wh_renewed", "subscription.renewed", payload(unpaidMonth), RENEWAL);
  await charge(t, "pay_failed", RENEWAL, "failed");
  await event(t, "wh_hold", "subscription.on_hold", payload({ ...unpaidMonth, status: "on_hold" }), HOLD);
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => t.fetch("/api/internal-entitlements", init)));
  return t;
}

function atTime(ms: number) {
  vi.setSystemTime(ms);
  cache.clear();
  __resetEntitlementNegativeCacheForTests();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", SECRET);
  cache.clear();
  vi.clearAllMocks();
  vi.mocked(getCachedJson).mockImplementation(async (key) => {
    const entry = cache.get(key);
    return entry && entry.expiresAt > Date.now() ? structuredClone(entry.value) : null;
  });
  vi.mocked(setCachedJson).mockImplementation(async (key, value, ttl) => {
    cache.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttl * 1_000 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetEntitlementNegativeCacheForTests();
});

describe("a failed renewal from webhook to edge gate", () => {
  test("keeps Pro inside the access grace", async () => {
    await failedRenewal();
    atTime(HOLD + DAY);

    expect((await checkEntitlementDetailed(USER, PRO_PATH, {})).response).toBeNull();
    expect(checkProMcpAccess(await getEntitlements(USER), Date.now())).toBeNull();
  });

  test("past the grace, free Pro features stay available while Dodo retries", async () => {
    await failedRenewal();
    atTime(HOLD + ON_HOLD_ACCESS_GRACE_MS + DAY);

    expect((await checkEntitlementDetailed(USER, PRO_PATH, {})).response).toBeNull();
    expect(checkProMcpAccess(await getEntitlements(USER), Date.now())).toEqual({
      kind: "free_account",
      paymentFailed: true,
    });
  });

  test("free Pro features stay available after the unpaid period ends", async () => {
    await failedRenewal();
    atTime(NEXT_RENEWAL + DAY);

    expect((await checkEntitlementDetailed(USER, PRO_PATH, {})).response).toBeNull();
  });
  });

  test("once the unpaid period has ended, the denial is subscription_lapsed again", async () => {
    await failedRenewal();
    atTime(NEXT_RENEWAL + DAY);

    const denied = (await checkEntitlementDetailed(USER, PRO_PATH, {})).response;
    expect(denied?.status).toBe(403);
    expect(denied?.headers.get("X-Billing-Verification")).toBe("subscription_lapsed");
  });
});
