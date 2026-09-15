import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const RELAY_SECRET = "test-relay-secret-json-object-guard";

const routes = [
  "/relay/deactivate",
  "/relay/channels",
  "/relay/notification-channels",
  "/relay/user-preferences",
  "/relay/followed-countries",
  "/relay/entitlement",
  "/relay/register-referral-code",
  "/relay/create-checkout",
  "/relay/customer-portal",
  "/relay/bulk-suppress-emails",
];

describe("relay JSON object body guard", () => {
  beforeEach(() => {
    vi.stubEnv("RELAY_SHARED_SECRET", "ingestion-only");
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", RELAY_SECRET);
    vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", "delivery-secret");
    vi.stubEnv("CONVEX_EMAIL_SUPPRESSION_SECRET", "suppression-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  test.each(routes)("%s rejects a JSON null body with 400 INVALID_JSON", async (path) => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${path === "/relay/bulk-suppress-emails" ? "suppression-secret" : ["/relay/deactivate", "/relay/channels", "/relay/user-preferences", "/relay/entitlement"].includes(path) ? "delivery-secret" : RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: "null",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_JSON" });
  });
});
