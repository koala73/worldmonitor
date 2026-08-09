// The two-dot file name is load-bearing. `convex deploy` turns every one-dot
// module under convex/ into a backend module and evaluates it in a Convex
// isolate, where the `import.meta.glob` below throws
// `InvalidModules ... import.meta unsupported` and fails the WHOLE push.
// `*.test.ts` gets that skip by accident; this file gets it on purpose.
// tests/convex-entrypoint-hygiene.test.mjs fails if either regresses.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, vi } from "vitest";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import companyMonitoringSchema from "../schema";

export const modules = import.meta.glob("../**/*.ts");
export const schema = companyMonitoringSchema;
export const NOW = Date.parse("2026-08-05T12:00:00.000Z");
export const FUTURE = NOW + 30 * 24 * 60 * 60 * 1000;
export const OWNER_A = "user_company_monitoring_a";
export const OWNER_B = "user_company_monitoring_b";
export const CM = internal.companyMonitoring;
export const TEST_DODO_IDENTITY_SIGNING_SECRET = "test-dodo-identity-signing-secret";
export const ROTATED_DODO_IDENTITY_SIGNING_SECRET = "rotated-dodo-identity-signing-secret";
export const TEST_OWNER_FENCE_SECRET = "test-company-monitoring-owner-fence-secret";
export const OLD_OWNER_FENCE_SECRET = "old-company-monitoring-owner-fence-secret";
export const INTERMEDIATE_OWNER_FENCE_SECRET = "intermediate-company-monitoring-owner-fence-secret";
export const NEW_OWNER_FENCE_SECRET = "new-company-monitoring-owner-fence-secret";

const MUTATED_ENV_KEYS = [
  "DODO_IDENTITY_SIGNING_SECRET",
  "COMPANY_MONITORING_OWNER_FENCE_SECRET",
  "COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof MUTATED_ENV_KEYS)[number], string | undefined>;

export function company(name: string, customerReference?: string) {
  return {
    name,
    domicileCountry: "US",
    aliases: [`${name} Holdings`],
    domains: [`${name.toLowerCase().replaceAll(" ", "-")}.example`],
    identifiers: [`lei:${name.toLowerCase().replaceAll(" ", "-")}`],
    xHandles: [name.toLowerCase().replaceAll(" ", "_").slice(0, 15)],
    locations: ["New York, US"],
    ...(customerReference ? { customerReference } : {}),
  };
}

export async function grant(
  t: ReturnType<typeof convexTest>,
  userId: string,
  planKey = "api_starter",
) {
  return t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId,
    planKey,
    days: 30,
    reason: "company monitoring onboarding test",
  });
}

/**
 * Grant an entitlement AND provision the account root.
 *
 * `grant` alone deliberately provisions nothing (#6256) — entitlement writes no
 * longer touch Company Monitoring. Tests that need a root as a *precondition*
 * use this; tests asserting the decoupling itself use bare `grant`.
 */
export async function grantProvisioned(
  t: ReturnType<typeof convexTest>,
  userId: string,
  planKey = "api_starter",
) {
  const result = await grant(t, userId, planKey);
  await t.mutation(CM.accounts.syncStoredEntitlement, { userId });
  return result;
}

export async function setStoredEntitlement(
  t: ReturnType<typeof convexTest>,
  userId: string,
  planKey: string,
  validUntil: number,
  updatedAt = NOW,
) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    const value = {
      planKey,
      features: getFeaturesForPlan(planKey),
      validUntil,
      updatedAt,
    };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("entitlements", { userId, ...value });
  });
  await t.mutation(CM.accounts.syncStoredEntitlement, { userId });
}

export async function accountFor(t: ReturnType<typeof convexTest>, userId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("companyMonitoringAccounts")
      .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", userId))
      .unique(),
  );
}

export function installCompanyMonitoringTestEnvironment() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const key of MUTATED_ENV_KEYS) delete process.env[key];
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_DODO_IDENTITY_SIGNING_SECRET;
    process.env.COMPANY_MONITORING_OWNER_FENCE_SECRET = TEST_OWNER_FENCE_SECRET;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of MUTATED_ENV_KEYS) {
      const original = ORIGINAL_ENV[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });
}
