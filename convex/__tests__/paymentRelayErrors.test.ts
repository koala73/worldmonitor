import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { createDodoCheckoutSession } from "../lib/dodo";
import { signDunningPortalToken } from "../lib/identitySigning";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const { portalCreate } = vi.hoisted(() => ({ portalCreate: vi.fn() }));
vi.mock("dodopayments", async (importOriginal) => ({
  ...await importOriginal<typeof import("dodopayments")>(),
  DodoPayments: class {
    customers = { customerPortal: { create: portalCreate } };
  },
}));

const modules = import.meta.glob("../**/*.ts");
const userId = "user_relay_errors";

beforeEach(() => {
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createDodoCheckoutSession).mockReset();
  portalCreate.mockReset();
  vi.unstubAllEnvs();
});

function post(t: ReturnType<typeof convexTest>, path: string) {
  return t.fetch(path, {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ userId, productId: PRODUCT_CATALOG.pro_monthly.dodoProductId! }),
  });
}

test.each([
  new Error("provider payload: customer cus_private; internal stack"),
  "provider payload: customer cus_private",
])("checkout hides unexpected failures and logs them server-side: %s", async (error) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(createDodoCheckoutSession).mockRejectedValue(error);
  const response = await post(convexTest(schema, modules), "/relay/create-checkout");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Operation failed" });
  expect(log).toHaveBeenCalledWith("[create-checkout] Operation failed", expect.anything());
});

test("portal hides unexpected configuration failures and logs them server-side", async () => {
  vi.stubEnv("DODO_API_KEY", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("customers", {
    userId, dodoCustomerId: "cus_private", email: "buyer@example.test", createdAt: 1, updatedAt: 1,
  }));
  const response = await post(t, "/relay/customer-portal");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Operation failed" });
  expect(log).toHaveBeenCalledWith("[customer-portal] Operation failed", expect.anything());
});

test("portal maps missing customers to a stable 404", async () => {
  const response = await post(convexTest(schema, modules), "/relay/customer-portal");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "NO_CUSTOMER" });
});

async function seedPortalUser(
  t: ReturnType<typeof convexTest>,
  owner: string,
  status: "active" | "on_hold" | "cancelled" | "expired",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("customers", {
      userId: owner, dodoCustomerId: `cus_${owner}`, email: "buyer@example.test", createdAt: 1, updatedAt: 1,
    });
    await ctx.db.insert("subscriptions", {
      userId: owner,
      dodoSubscriptionId: `sub_${owner}`,
      dodoProductId: "pdt_test",
      planKey: "pro_monthly",
      status,
      currentPeriodStart: Date.now() - 30 * 86_400_000,
      currentPeriodEnd: Date.now() - 60_000,
      rawPayload: {},
      updatedAt: Date.now() - 1_000,
    });
  });
}

function postToken(t: ReturnType<typeof convexTest>, body: Record<string, unknown>) {
  return t.fetch("/relay/customer-portal", {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("portal token mints a session for the signed user while a hold is open", async () => {
  vi.stubEnv("DODO_API_KEY", "synthetic-api-key");
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-dunning-portal-secret");
  const t = convexTest(schema, modules);
  await seedPortalUser(t, userId, "on_hold");
  portalCreate.mockResolvedValue({ link: "https://customer.dodopayments.com/session/token" });
  const portalToken = await signDunningPortalToken(userId, Date.now());
  const response = await postToken(t, { portalToken });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ portal_url: "https://customer.dodopayments.com/session/token" });
  expect(portalCreate).toHaveBeenCalledWith(`cus_${userId}`, { send_email: false });
});

test.each(["active", "cancelled", "expired"] as const)(
  "portal token stops minting once the hold is no longer open (%s)",
  async (status) => {
    vi.stubEnv("DODO_API_KEY", "synthetic-api-key");
    vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-dunning-portal-secret");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => { logs.push(String(line)); });
    const t = convexTest(schema, modules);
    await seedPortalUser(t, userId, status);
    const portalToken = await signDunningPortalToken(userId, Date.now());
    const response = await postToken(t, { portalToken });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_PORTAL_TOKEN" });
    expect(portalCreate).not.toHaveBeenCalled();
    expect(logs.map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({ event: "dunning_portal_token_rejected", reason: "no_open_hold" }),
    );
  },
);

test("portal token wins over a body userId", async () => {
  vi.stubEnv("DODO_API_KEY", "synthetic-api-key");
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-dunning-portal-secret");
  const t = convexTest(schema, modules);
  await seedPortalUser(t, userId, "on_hold");
  await seedPortalUser(t, "user_other_account", "active");
  portalCreate.mockResolvedValue({ link: "https://customer.dodopayments.com/session/token" });
  const portalToken = await signDunningPortalToken(userId, Date.now());
  const response = await postToken(t, { portalToken, userId: "user_other_account" });
  expect(response.status).toBe(200);
  expect(portalCreate).toHaveBeenCalledWith(`cus_${userId}`, { send_email: false });
});

test("an invalid portal token never falls back to the body userId", async () => {
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-dunning-portal-secret");
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => { logs.push(String(line)); });
  const t = convexTest(schema, modules);
  await seedPortalUser(t, userId, "on_hold");
  const response = await postToken(t, { portalToken: "v1.user_x.1.not-a-signature", userId });
  expect(response.status).toBe(401);
  expect(portalCreate).not.toHaveBeenCalled();
  expect(logs.map((l) => JSON.parse(l))).toContainEqual(
    expect.objectContaining({ event: "dunning_portal_token_rejected", reason: "invalid_or_expired" }),
  );
});

test("portal token that fails verification is 401", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  const response = await postToken(t, { portalToken: "v1.user_x.1.not-a-signature" });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "INVALID_PORTAL_TOKEN" });
});

test("portal provider failures stay server-side and a later request can recover", async () => {
  vi.stubEnv("DODO_API_KEY", "synthetic-api-key");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("customers", {
    userId, dodoCustomerId: "cus_private", email: "buyer@example.test", createdAt: 1, updatedAt: 1,
  }));
  portalCreate.mockRejectedValueOnce(new Error("private provider payload"))
    .mockResolvedValueOnce({ link: "https://billing.example.test/session" });
  const failure = await post(t, "/relay/customer-portal");
  expect(failure.status).toBe(500);
  expect(await failure.json()).toEqual({ error: "Operation failed" });
  expect(log).toHaveBeenCalledWith(expect.stringContaining("cus_private"), "private provider payload");
  expect(log).toHaveBeenCalledWith("[customer-portal] Operation failed", expect.anything());
  const recovery = await post(t, "/relay/customer-portal");
  expect(recovery.status).toBe(200);
  expect(await recovery.json()).toEqual({ portal_url: "https://billing.example.test/session" });
});
