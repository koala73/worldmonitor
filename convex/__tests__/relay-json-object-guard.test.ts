import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.RELAY_SHARED_SECRET;
    process.env.RELAY_SHARED_SECRET = RELAY_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RELAY_SHARED_SECRET;
    else process.env.RELAY_SHARED_SECRET = originalSecret;
  });

  test.each(routes)("%s rejects a JSON null body with 400 INVALID_JSON", async (path) => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: "null",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_JSON" });
  });
});
