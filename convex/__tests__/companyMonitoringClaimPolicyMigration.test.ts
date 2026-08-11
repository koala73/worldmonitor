import { convexTest } from "convex-test";
import { internal } from "../_generated/api";
import { describe, expect, test } from "vitest";
import { COMPANY_MONITORING_CLAIM_POLICY_VERSION } from "../companyMonitoring/_shared";
import { CLAIM_POLICY_MIGRATION_COMPANY_PAGE_SIZE } from "../companyMonitoring/claimPolicyMigration";
import {
  accountFor,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  OWNER_A,
  schema,
} from "./companyMonitoring.helpers";

const MIGRATION = internal.companyMonitoring.claimPolicyMigration;

installCompanyMonitoringTestEnvironment();

async function seedLegacyAccount(
  t: ReturnType<typeof convexTest>,
  companyCount: number,
) {
  const ownerAccountId = "cm_account_claim_policy_legacy";
  await t.run(async (ctx) => {
    await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: ownerAccountId,
      ownerUserId: "legacy_claim_policy_owner",
      ownerFenceHash: "legacy_claim_policy_fence",
      lifecycle: "entitled",
      lifecycleSequence: 1,
      companyCount,
      companyLimit: 500,
      snapshotGeneration: 1,
      purgeGeneration: 0,
      purgePhase: "none",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (let index = 0; index < companyCount; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      const companyId = `cm_company_legacy_policy_${suffix}`;
      await ctx.db.insert("companyMonitoringCompanies", {
        ownerAccountId,
        companyId,
        name: `Legacy Company ${suffix}`,
        sortName: `legacy company ${suffix}`,
        domicileCountry: "US",
        lifecycle: "active",
        coverageState: "awaiting_first_scan",
        observationState: "unknown",
        snapshotGeneration: 1,
        purgeGeneration: 0,
        purgePhase: "none",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId,
        companyId,
        claimId: `cm_claim_legacy_policy_${suffix}`,
        type: "domain",
        value: `legacy-${suffix}.example`,
        provenance: "customer",
        trustState: "unverified",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  });
  return ownerAccountId;
}

describe("Company Monitoring claim-policy migration", () => {
  test("resumes across bounded company pages and stamps only after the final page", async () => {
    const t = convexTest(schema, modules);
    const companyCount = CLAIM_POLICY_MIGRATION_COMPANY_PAGE_SIZE + 1;
    const ownerAccountId = await seedLegacyAccount(t, companyCount);

    const first = await t.mutation(MIGRATION.migrateAccountClaimPolicy, {
      ownerAccountId,
      cursor: null,
    });
    expect(first).toMatchObject({
      status: "in_progress",
      companiesProcessed: CLAIM_POLICY_MIGRATION_COMPANY_PAGE_SIZE,
      claimsPatched: CLAIM_POLICY_MIGRATION_COMPANY_PAGE_SIZE,
      aliasesInserted: CLAIM_POLICY_MIGRATION_COMPANY_PAGE_SIZE,
      claimPolicyVersion: null,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const afterFirstPage = await t.run(async (ctx) => ({
      account: await ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", ownerAccountId))
        .unique(),
      firstClaims: await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", "cm_company_legacy_policy_000")
        )
        .collect(),
      lastClaims: await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", "cm_company_legacy_policy_025")
        )
        .collect(),
    }));
    expect(afterFirstPage.account?.claimPolicyVersion).toBeUndefined();
    expect(afterFirstPage.firstClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "domain", allowedUses: ["attribution", "discovery"] }),
      expect.objectContaining({ type: "alias", value: "Legacy Company 000" }),
    ]));
    expect(afterFirstPage.lastClaims).toHaveLength(1);
    expect(afterFirstPage.lastClaims[0]?.allowedUses).toBeUndefined();

    const replay = await t.mutation(MIGRATION.migrateAccountClaimPolicy, {
      ownerAccountId,
      cursor: null,
    });
    expect(replay).toMatchObject({
      status: "in_progress",
      claimsPatched: 0,
      aliasesInserted: 0,
    });

    const completed = await t.mutation(MIGRATION.migrateAccountClaimPolicy, {
      ownerAccountId,
      cursor: first.nextCursor,
    });
    expect(completed).toMatchObject({
      status: "complete",
      companiesProcessed: 1,
      claimsPatched: 1,
      aliasesInserted: 1,
      nextCursor: null,
      claimPolicyVersion: COMPANY_MONITORING_CLAIM_POLICY_VERSION,
    });
    const account = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", ownerAccountId))
        .unique()
    );
    expect(account?.claimPolicyVersion).toBe(COMPANY_MONITORING_CLAIM_POLICY_VERSION);
  });

  test("repairs customer allowed uses and the current-name alias without upgrading provider claims", async () => {
    const t = convexTest(schema, modules);
    const ownerAccountId = await seedLegacyAccount(t, 1);
    const companyId = "cm_company_legacy_policy_000";
    await t.run(async (ctx) => {
      const domain = await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId)
        )
        .unique();
      await ctx.db.delete(domain!._id);
      const claimTypes = [
        ["alias", "Historical Name"],
        ["domain", "legacy.example"],
        ["legal_identifier", "lei:legacy"],
        ["x_account_id", "123456"],
        ["x_handle", "legacy_company"],
        ["location", "New York, US"],
        ["customer_reference", "legacy-reference"],
      ] as const;
      for (const [index, [type, value]] of claimTypes.entries()) {
        await ctx.db.insert("companyMonitoringClaims", {
          ownerAccountId,
          companyId,
          claimId: `cm_claim_policy_type_${index}`,
          type,
          value,
          provenance: "customer",
          trustState: "unverified",
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId,
        companyId,
        claimId: "cm_claim_policy_provider_alias",
        type: "alias",
        value: "Legacy Company 000",
        provenance: "independent_provider",
        trustState: "verified",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    const result = await t.mutation(MIGRATION.migrateAccountClaimPolicy, {
      ownerAccountId,
      cursor: null,
    });
    expect(result).toMatchObject({
      status: "complete",
      claimsPatched: 7,
      aliasesInserted: 1,
      claimPolicyVersion: COMPANY_MONITORING_CLAIM_POLICY_VERSION,
    });

    const claims = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId)
        )
        .collect()
    );
    const customerUses = Object.fromEntries(
      claims
        .filter((claim) => claim.provenance === "customer")
        .map((claim) => [claim.type, claim.allowedUses]),
    );
    expect(customerUses).toMatchObject({
      alias: ["attribution", "discovery"],
      domain: ["attribution", "discovery"],
      legal_identifier: ["attribution", "discovery"],
      x_account_id: ["attribution", "discovery"],
      x_handle: ["attribution", "discovery"],
      location: ["discovery"],
      customer_reference: ["discovery"],
    });
    const currentNameAliases = claims.filter((claim) =>
      claim.type === "alias" && claim.value === "Legacy Company 000"
    );
    expect(currentNameAliases).toHaveLength(2);
    expect(currentNameAliases.find((claim) => claim.provenance === "customer")?.allowedUses)
      .toEqual(["attribution", "discovery"]);
    expect(currentNameAliases.find((claim) => claim.provenance === "independent_provider")?.allowedUses)
      .toBeUndefined();

    const replay = await t.mutation(MIGRATION.migrateAccountClaimPolicy, {
      ownerAccountId,
      cursor: null,
    });
    expect(replay).toMatchObject({
      status: "complete",
      companiesProcessed: 0,
      claimsPatched: 0,
      aliasesInserted: 0,
    });
    const aliasesAfterReplay = await t.run(async (ctx) =>
      (await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId)
        )
        .collect())
        .filter((claim) =>
          claim.provenance === "customer" &&
          claim.type === "alias" &&
          claim.value === "Legacy Company 000"
        )
    );
    expect(aliasesAfterReplay).toHaveLength(1);
  });

  test("new entitled accounts start at the current claim-policy version", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      claimPolicyVersion: COMPANY_MONITORING_CLAIM_POLICY_VERSION,
    });
  });
});
