import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");

// upsertEntitlements schedules syncEntitlementCache with the exact `features`
// object it just wrote to the entitlements table. The action's argument
// validator is strict on extra keys, so a field the table accepts but the
// action does not rejects the cache sync at runtime (Sentry WORLDMONITOR-18W:
// `historyDays`). Without Upstash configured the handler returns before any
// network call, so these tests exercise argument validation alone.
describe("syncEntitlementCache accepts every catalog plan's features", () => {
  let savedUrl: string | undefined;
  beforeEach(() => {
    savedUrl = process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  });

  for (const planKey of Object.keys(PRODUCT_CATALOG)) {
    test(planKey, async () => {
      const t = convexTest(schema, modules);
      await expect(
        t.action(internal.payments.cacheActions.syncEntitlementCache, {
          userId: "user-cache-sync",
          planKey,
          features: getFeaturesForPlan(planKey),
          validUntil: Date.now() + 86_400_000,
        }),
      ).resolves.toBeNull();
    });
  }
});
