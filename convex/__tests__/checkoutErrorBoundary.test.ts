import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { createDodoCheckoutSession } from "../lib/dodo";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));
const modules = import.meta.glob("../**/*.ts");
const sentinel = "synthetic-private-provider-detail";
const productId = PRODUCT_CATALOG.pro_monthly.dodoProductId!;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test("checkout action masks provider details and keeps server diagnostics", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(createDodoCheckoutSession).mockRejectedValue(new Error(sentinel));
  const t = convexTest(schema, modules);
  const error = await t.action(
    internal.payments.checkout.internalCreateCheckout, { userId: "error-boundary-buyer", productId },
  ).catch((error: unknown) => error);
  expect(String(error)).toContain("CHECKOUT_FAILED");
  expect(String(error)).not.toContain(sentinel);
  expect(JSON.stringify(log.mock.calls)).toContain(sentinel);
});

test("actual edge to relay to checkout chain masks provider exceptions", async () => {
  vi.stubEnv("CONVEX_SITE_URL", "https://convex.test");
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(createDodoCheckoutSession).mockRejectedValue(new Error(sentinel));
  const t = convexTest(schema, modules);
  const edge = await import("../../api/create-checkout");
  edge.__setCreateCheckoutDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: "error-boundary-buyer" }),
    checkRateLimit: async () => null,
    fetch: async (input, init) => t.fetch(new URL(String(input)).pathname, init),
  });
  try {
    const response = await edge.default(new Request("https://worldmonitor.app/api/create-checkout", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-clerk-token", "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "CHECKOUT_FAILED" });
    expect(JSON.stringify(log.mock.calls)).toContain(sentinel);
  } finally { edge.__setCreateCheckoutDepsForTests(null); }
});

test.each([
  ["not a URL", "Invalid returnUrl: must be a valid absolute URL"],
  ["https://untrusted.example", "Invalid returnUrl: must use a trusted worldmonitor.app origin"],
])("relay masks returnUrl validation for %s and logs it server-side", async (returnUrl, message) => {
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  const response = await t.fetch("/relay/create-checkout", {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "validation-buyer", productId, returnUrl }),
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Operation failed" });
  expect(JSON.stringify(log.mock.calls)).toContain(message);
});
