import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { createDodoCheckoutSession } from "../lib/dodo";
import schema from "../schema";
import { checkoutRetryClock, isCheckoutRateLimitedOutcome } from "../payments/checkoutRateLimit";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));
const modules = import.meta.glob("../**/*.ts");
const productId = PRODUCT_CATALOG.pro_monthly.dodoProductId!;
const buyer = { subject: "user_admission", tokenIdentifier: "clerk|user_admission" };
const success = { checkout_url: "https://checkout.example/session" };
beforeEach(() => {
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-admission-secret");
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
  vi.mocked(createDodoCheckoutSession).mockResolvedValue(success);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); });
const relay = (t: ReturnType<typeof convexTest>) => t.fetch("/relay/create-checkout", {
  method: "POST",
  headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
  body: JSON.stringify({ userId: buyer.subject, productId, bypassPendingGuard: true }),
});

test("direct and relayed calls share an account budget, including pending-guard bypass", async () => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 5; i++) {
    if (i % 2) expect((await relay(t)).status).toBe(200);
    else await expect(t.withIdentity(buyer).action(api.payments.checkout.createCheckout, { productId })).resolves.toEqual(success);
  }
  const denied = await relay(t);
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(await denied.json()).toMatchObject({ error: "CHECKOUT_RATE_LIMITED" });
  await expect(t.withIdentity(buyer).action(api.payments.checkout.createCheckout, { productId, bypassPendingGuard: true })).rejects.toThrow("CHECKOUT_RATE_LIMITED");
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(5);
  await expect(t.action(internal.payments.checkout.internalCreateCheckout, { userId: "other_account", productId })).resolves.toEqual(success);
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(6);
});

test("concurrent creations cannot exceed five provider calls", async () => {
  const t = convexTest(schema, modules);
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    t.action(internal.payments.checkout.internalCreateCheckout, { userId: buyer.subject, productId })));
  expect(results.filter((r) => "checkout_url" in r)).toHaveLength(5);
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(5);
});


test("window expiry reuses the account row and returns an accurate retry delay", async () => {
  const t = convexTest(schema, modules);
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  for (let i = 0; i < 5; i++) await t.action(internal.payments.checkout.internalCreateCheckout, { userId: buyer.subject, productId });
  now.mockReturnValue(1_599_001);
  await expect(t.action(internal.payments.checkout.internalCreateCheckout, { userId: buyer.subject, productId })).resolves.toMatchObject({ retryAfterSeconds: 1 });
  now.mockReturnValue(1_600_000);
  await expect(t.action(internal.payments.checkout.internalCreateCheckout, { userId: buyer.subject, productId })).resolves.toEqual(success);
  const rows = await t.run((ctx) => ctx.db.query("checkoutAdmissions").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ count: 1, windowStart: 1_600_000 });
});

test("failed admission storage cannot authorize provider work", async () => {
  const t = convexTest(schema, modules);
  // Simulate unavailable accounting through a real failed database invariant.
  await t.run(async (ctx) => {
    for (let i = 0; i < 2; i++) await ctx.db.insert("checkoutAdmissions", { userId: buyer.subject, windowStart: Date.now(), count: 0 });
  });
  await expect(t.withIdentity(buyer).action(api.payments.checkout.createCheckout, { productId })).rejects.toThrow();
  expect((await relay(t)).status).toBe(500);
  expect(createDodoCheckoutSession).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual([]);
});

test("provider retries consume one slot and provider failures retain their slot", async () => {
  const t = convexTest(schema, modules);
  vi.spyOn(checkoutRetryClock, "sleep").mockResolvedValue(undefined);
  vi.mocked(createDodoCheckoutSession)
    .mockRejectedValueOnce(Object.assign(new Error("provider limit"), { status: 429 }))
    .mockResolvedValueOnce(success);
  await expect(t.action(internal.payments.checkout.internalCreateCheckout, { userId: buyer.subject, productId })).resolves.toEqual(success);
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(2);
  vi.mocked(createDodoCheckoutSession).mockRejectedValueOnce(new Error("provider unavailable"));
  await expect(t.action(internal.payments.checkout.internalCreateCheckout, { userId: buyer.subject, productId })).rejects.toThrow("provider unavailable");
  expect((await t.run((ctx) => ctx.db.query("checkoutAdmissions").unique()))?.count).toBe(2);
});

test.each([0, -1, 1.5, Infinity, NaN, 10_000, "600", undefined])("rejects malformed retry delay %s", (retryAfterSeconds) => {
  expect(isCheckoutRateLimitedOutcome({ checkoutFailed: true, code: "CHECKOUT_RATE_LIMITED", retryAfterSeconds })).toBe(false);
});
