import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { LEGACY_PRODUCT_ALIASES, PRODUCT_CATALOG } from "../config/productCatalog";
import { createDodoCheckoutSession } from "../lib/dodo";
import schema from "../schema";

// Mock only the provider transport; checkout, guards and persistence are real.
vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const buyer = { subject: "user_product_admission", tokenIdentifier: "clerk|user_product_admission" };
beforeEach(() => {
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-product-admission-secret");
});

afterEach(() => {
  vi.mocked(createDodoCheckoutSession).mockReset();
  vi.unstubAllEnvs();
});

const allowed = Object.values(PRODUCT_CATALOG).filter((p) => p.dodoProductId && p.currentForCheckout && p.selfServe);
const rejected = [
  ...Object.values(PRODUCT_CATALOG).filter((p) => p.dodoProductId && (!p.currentForCheckout || !p.selfServe)).map((p) => p.dodoProductId!),
  ...Object.keys(LEGACY_PRODUCT_ALIASES),
  "pdt_unmapped_investigation", "not-a-product-id", "", "constructor", "__proto__",
];

for (const entryPoint of ["public", "internal"] as const) {
  const invoke = (t: ReturnType<typeof convexTest>, productId: string, bypassPendingGuard = false) =>
    entryPoint === "public"
      ? t.withIdentity(buyer).action(api.payments.checkout.createCheckout, { productId, bypassPendingGuard })
      : t.action(internal.payments.checkout.internalCreateCheckout, { userId: buyer.subject, productId, bypassPendingGuard });

  test.each(allowed)(`${entryPoint} admits $planKey`, async (plan) => {
    const t = convexTest(schema, modules);
    vi.mocked(createDodoCheckoutSession).mockResolvedValue({ checkout_url: "https://checkout.example/session" });
    await expect(invoke(t, plan.dodoProductId!)).resolves.toEqual({ checkout_url: "https://checkout.example/session" });
    expect(createDodoCheckoutSession).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(createDodoCheckoutSession).mock.calls[0][0];
    expect(payload.product_cart).toEqual([{ product_id: plan.dodoProductId, quantity: 1 }]);
    expect(payload.metadata?.wm_plan_key).toBe(plan.planKey);
  });

  test.each(rejected)(`${entryPoint} rejects %s before provider or storage effects`, async (productId) => {
    const t = convexTest(schema, modules);
    for (const bypass of [false, true]) {
      await expect(invoke(t, productId, bypass)).rejects.toThrow("INVALID_CHECKOUT_PRODUCT");
    }
    expect(createDodoCheckoutSession).not.toHaveBeenCalled();
    for (const table of ["entitlements", "subscriptions", "users"] as const) {
      expect(await t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
    }
  });
}

test("relay returns a non-retryable product rejection", async () => {
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
  const t = convexTest(schema, modules);
  const response = await t.fetch("/relay/create-checkout", {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ userId: buyer.subject, productId: Object.keys(LEGACY_PRODUCT_ALIASES)[0] }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "INVALID_CHECKOUT_PRODUCT" });
  expect(createDodoCheckoutSession).not.toHaveBeenCalled();
});

test.each(["currentForCheckout", "selfServe"] as const)("requires %s independently", async (flag) => {
  const plan = PRODUCT_CATALOG.pro_monthly;
  const original = plan[flag];
  plan[flag] = false;
  try {
    const t = convexTest(schema, modules);
    await expect(t.withIdentity(buyer).action(api.payments.checkout.createCheckout, {
      productId: plan.dodoProductId!,
    })).rejects.toThrow("INVALID_CHECKOUT_PRODUCT");
    expect(createDodoCheckoutSession).not.toHaveBeenCalled();
  } finally {
    plan[flag] = original;
  }
});
