import { convexTest } from "convex-test";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import { runEraseBatch, PERSONAL_DELETE_TABLES } from "../accountDeletion/batches";

const modules = import.meta.glob("../**/*.ts");
const aws = (internal as any).awsMarketplace;
const PRODUCT = "configured-product";
const ACCOUNT = "123456789012";
const ARN = "arn:aws:license-manager:us-east-1:123456789012:license:example";
const NOW = 1_800_000_000_000;
const hash = (n: number) => n.toString(16).padStart(64, "0");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("AWS_MARKETPLACE_PRODUCT_CODES", PRODUCT);
  vi.stubEnv("AWS_MARKETPLACE_DIMENSION_PLAN_MAP", JSON.stringify({ api_mcp: "api_starter" }));
  vi.stubEnv("CONVEX_SERVER_SHARED_SECRET", "test-marketplace-shared-secret");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function stage(t: ReturnType<typeof convexTest>, n = 1, licenseArn = ARN) {
  return t.mutation(aws.stageRegistration, {
    registrationHash: hash(n), browserBindingHash: hash(n + 100),
    productCode: PRODUCT, customerAWSAccountId: ACCOUNT, licenseArn,
    expiresAt: NOW + 10 * 60_000,
  });
}
async function claim(t: ReturnType<typeof convexTest>, n = 1, userId = "clerk-user") {
  return t.mutation(aws.claimRegistration, {
    registrationHash: hash(n), browserBindingHash: hash(n + 100), userId,
  });
}
async function refresh(t: ReturnType<typeof convexTest>, options: {
  licenseArn?: string; quantity?: number; expirationDate?: number; entitlements?: unknown[];
} = {}) {
  const begin = await t.mutation(aws.beginRefresh, {
    productCode: PRODUCT, customerAWSAccountId: ACCOUNT, licenseArn: options.licenseArn ?? ARN,
  });
  const apply = await t.mutation(aws.applyRefresh, {
    licenseId: begin.licenseId, revision: begin.revision, checkedAt: Date.now(),
    entitlements: options.entitlements ?? [{
      dimension: "api_mcp", quantity: options.quantity ?? 1,
      expirationDate: options.expirationDate ?? NOW + 86400_000,
    }],
  });
  return { begin, apply };
}

describe("AWS Marketplace license ledger", () => {
  test("internal refresh route ignores registration and reconciliation metadata", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/api/internal/aws-marketplace", { method: "POST",
      headers: { "x-convex-shared-secret": "test-marketplace-shared-secret" },
      body: JSON.stringify({ operation: "beginRefresh", productCode: PRODUCT,
        customerAWSAccountId: ACCOUNT, licenseArn: ARN, id: "due-row-id",
        customerIdentifier: "legacy-customer", agreementId: "agreement-1",
        eventId: "event-1", eventTime: NOW }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 1, duplicate: false });
  });

  test("internal route authenticates and returns a retryable stale proof marker", async () => {
    const t = convexTest(schema, modules);
    const noAuth = await t.fetch("/api/internal/aws-marketplace", { method: "POST",
      body: JSON.stringify({ operation: "account", userId: "clerk-user" }) });
    expect(noAuth.status).toBe(401);
    const headers = { "x-convex-shared-secret": "test-marketplace-shared-secret" };
    const staged = await t.fetch("/api/internal/aws-marketplace", { method: "POST", headers,
      body: JSON.stringify({ operation: "stageRegistration", registrationHash: hash(1),
        browserBindingHash: hash(101), productCode: PRODUCT,
        customerAWSAccountId: ACCOUNT, licenseArn: ARN, expiresAt: NOW + 600_000 }) });
    expect(staged.status).toBe(200);
    const owner = await claim(t);
    const foreign = await t.fetch("/api/internal/aws-marketplace", { method: "POST", headers,
      body: JSON.stringify({ operation: "claimRegistration", registrationHash: hash(1),
        browserBindingHash: hash(101), userId: "other-user" }) });
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toEqual({ error: "REGISTRATION_REPLAYED" });
    await refresh(t);
    vi.setSystemTime(NOW + 15 * 60_000 + 1);
    const entitlement = await t.fetch("/api/internal-entitlements", { method: "POST", headers,
      body: JSON.stringify({ userId: owner.principalId }) });
    expect(entitlement.status).toBe(200);
    expect(await entitlement.json()).toMatchObject({ planKey: "free", verificationUnavailable: true, retryAfterSeconds: 30 });
  });

  test("claims an AWS contract without changing the buyer's Dodo entitlement", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => ctx.db.insert("entitlements", {
      userId: "clerk-user", planKey: "pro_monthly",
      features: getFeaturesForPlan("pro_monthly"), validUntil: NOW + 86400_000, updatedAt: NOW,
    }));
    await stage(t);
    const claimed = await claim(t);
    await refresh(t, { quantity: 2 });
    const awsEntitlement = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: claimed.principalId });
    expect(awsEntitlement.planKey).toBe("api_starter");
    expect(awsEntitlement.validUntil).toBe(NOW + 15 * 60_000);
    expect(awsEntitlement.features.planLimits?.apiRequestsPerDay).toBe(2_000);
    expect(awsEntitlement.features.apiDailyAllowance).toBe(2_000);
    expect(awsEntitlement.features.planLimits?.mcpCallsPerDay).toBe("shared-api-budget");
    const retail = await t.query(internal.entitlements.getEntitlementsByUserId, { userId: "clerk-user" });
    expect(retail.planKey).toBe("pro_monthly");
  });

  test("registration replay is idempotent for the owner and denied to another owner", async () => {
    const t = convexTest(schema, modules);
    await stage(t);
    const first = await claim(t);
    expect(await claim(t)).toEqual(first);
    await expect(claim(t, 1, "attacker")).rejects.toThrow(/REGISTRATION_REPLAYED/);
    await stage(t, 2);
    await expect(claim(t, 2, "attacker")).rejects.toThrow(/LICENSE_ALREADY_CLAIMED/);
    await expect(t.mutation(aws.claimRegistration, {
      registrationHash: hash(1), browserBindingHash: hash(999), userId: "clerk-user",
    })).rejects.toThrow(/REGISTRATION_NOT_FOUND/);
  });

  test("unconfigured product and expired registration cannot be claimed; expired hashes are pruned", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(aws.stageRegistration, { registrationHash: hash(1),
      browserBindingHash: hash(101), customerAWSAccountId: ACCOUNT, licenseArn: ARN,
      productCode: "other-product", expiresAt: NOW + 600_000 })).rejects.toThrow(/INVALID_REGISTRATION/);
    await stage(t);
    vi.setSystemTime(NOW + 11 * 60_000);
    await expect(claim(t)).rejects.toThrow(/REGISTRATION_EXPIRED/);
    expect(await t.mutation(aws.pruneExpiredRegistrations, {})).toEqual({ deleted: 1 });
    expect(await t.run(async (ctx) => ctx.db.query("awsMarketplaceRegistrations").collect())).toHaveLength(0);
  });

  test("separate licenses have separate principals, keys, and owner checks", async () => {
    const t = convexTest(schema, modules);
    const otherArn = `${ARN}-2`;
    await stage(t, 1);
    await stage(t, 2, otherArn);
    const a = await claim(t, 1);
    const b = await claim(t, 2);
    await refresh(t);
    await refresh(t, { licenseArn: otherArn });
    const key = await t.mutation(aws.createKey, {
      userId: "clerk-user", licenseId: a.licenseId, name: "first", keyHash: hash(200), keyPrefix: "wm_000c8",
    });
    expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: hash(200) })).toMatchObject({
      userId: a.principalId, keyKind: "api",
    });
    expect(b.principalId).not.toBe(a.principalId);
    await expect(t.mutation(aws.revokeKey, {
      userId: "clerk-user", licenseId: b.licenseId, keyId: key.keyId,
    })).rejects.toThrow(/KEY_NOT_FOUND/);
    await expect(t.mutation(aws.createKey, {
      userId: "attacker", licenseId: a.licenseId, name: "bad", keyHash: hash(201), keyPrefix: "wm_000c9",
    })).rejects.toThrow(/LICENSE_NOT_FOUND/);
    expect((await t.query(aws.account, { userId: "clerk-user" })).licenses).toHaveLength(2);
    expect((await t.query(aws.account, { userId: "attacker" })).licenses).toHaveLength(0);
  });

  test("revocation and confirmed empty snapshot immediately deny key validation", async () => {
    const t = convexTest(schema, modules);
    await stage(t);
    const owner = await claim(t);
    await refresh(t);
    const key = await t.mutation(aws.createKey, {
      userId: "clerk-user", licenseId: owner.licenseId, name: "key", keyHash: hash(202), keyPrefix: "wm_000ca",
    });
    await t.mutation(aws.revokeKey, { userId: "clerk-user", licenseId: owner.licenseId, keyId: key.keyId });
    expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: hash(202) })).toBeNull();
    const second = await t.mutation(aws.createKey, {
      userId: "clerk-user", licenseId: owner.licenseId, name: "second", keyHash: hash(203), keyPrefix: "wm_000cb",
    });
    await refresh(t, { entitlements: [] });
    expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: hash(203) })).toBeNull();
    expect((await t.query(aws.account, { userId: "clerk-user" })).licenses[0].status).toBe("inactive");
    expect(second.keyId).toBeTruthy();
  });

  test("stale or expired verification fails closed; transient refresh does not apply empty", async () => {
    const t = convexTest(schema, modules);
    await stage(t);
    const owner = await claim(t);
    await refresh(t);
    const key = await t.mutation(aws.createKey, {
      userId: "clerk-user", licenseId: owner.licenseId, name: "key", keyHash: hash(204), keyPrefix: "wm_000cc",
    });
    const pending = await t.mutation(aws.beginRefresh, {
      productCode: PRODUCT, customerAWSAccountId: ACCOUNT, licenseArn: ARN,
    });
    expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: hash(204) })).not.toBeNull();
    vi.setSystemTime(NOW + 15 * 60_000 + 1);
    expect(await t.query(internal.apiKeys.validateKeyByHash, { keyHash: hash(204) })).toMatchObject({ userId: owner.principalId });
    expect((await t.query(aws.getPrincipalAccessProjection, { userId: owner.principalId })).state).toBe("stale");
    expect((await t.query(internal.entitlements.getEntitlementsByUserId, { userId: owner.principalId })).planKey).toBe("free");
    await expect(t.mutation(aws.createKey, {
      userId: "clerk-user", licenseId: owner.licenseId, name: "late", keyHash: hash(205), keyPrefix: "wm_000cd",
    })).rejects.toThrow(/LICENSE_INACTIVE/);
    expect(pending.duplicate).toBe(false);
  });

  test("quantity zero, fraction, and overflow never grant scaled access", async () => {
    for (const quantity of [0, 1.5, Number.MAX_SAFE_INTEGER]) {
      const t = convexTest(schema, modules);
      await stage(t);
      const owner = await claim(t);
      await refresh(t, { quantity });
      expect((await t.query(internal.entitlements.getEntitlementsByUserId, { userId: owner.principalId })).planKey).toBe("free");
      expect((await t.query(aws.account, { userId: "clerk-user" })).licenses[0].status).toBe("inactive");
    }
  });

  test("a stale revision cannot overwrite a newer AWS snapshot", async () => {
    const t = convexTest(schema, modules);
    await stage(t);
    const owner = await claim(t);
    const old = await t.mutation(aws.beginRefresh, {
      productCode: PRODUCT, customerAWSAccountId: ACCOUNT, licenseArn: ARN,
      eventId: "old", eventTime: NOW - 1000,
    });
    const newer = await t.mutation(aws.beginRefresh, {
      productCode: PRODUCT, customerAWSAccountId: ACCOUNT, licenseArn: ARN,
      eventId: "new", eventTime: NOW,
    });
    expect((await t.mutation(aws.applyRefresh, { licenseId: old.licenseId, revision: old.revision,
      checkedAt: NOW, entitlements: [] } )).applied).toBe(false);
    expect((await t.mutation(aws.applyRefresh, { licenseId: newer.licenseId, revision: newer.revision,
      checkedAt: NOW, entitlements: [{ dimension: "api_mcp", quantity: 1, expirationDate: NOW + 86400_000 }], eventId: "new",
    })).applied).toBe(true);
    expect((await t.query(internal.entitlements.getEntitlementsByUserId, { userId: owner.principalId })).planKey).toBe("api_starter");
    expect((await t.mutation(aws.beginRefresh, { productCode: PRODUCT,
      customerAWSAccountId: ACCOUNT, licenseArn: ARN, eventId: "old", eventTime: NOW - 1000 })).duplicate).toBe(true);
  });

  test("an uncommitted event can retry; a failed newer event cannot suppress it", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(aws.beginRefresh, { productCode: PRODUCT,
      customerAWSAccountId: ACCOUNT, licenseArn: ARN, eventId: "first", eventTime: NOW - 1000 });
    const newer = await t.mutation(aws.beginRefresh, { productCode: PRODUCT,
      customerAWSAccountId: ACCOUNT, licenseArn: ARN, eventId: "newer", eventTime: NOW });
    expect(newer.duplicate).toBe(false);
    const retry = await t.mutation(aws.beginRefresh, { productCode: PRODUCT,
      customerAWSAccountId: ACCOUNT, licenseArn: ARN, eventId: "first", eventTime: NOW - 1000 });
    expect(retry.duplicate).toBe(false);
    expect(retry.revision).toBeGreaterThan(newer.revision);
    expect((await t.mutation(aws.applyRefresh, { licenseId: first.licenseId, revision: first.revision,
      checkedAt: NOW, entitlements: [] })).applied).toBe(false);
    expect((await t.mutation(aws.applyRefresh, { licenseId: retry.licenseId, revision: retry.revision,
      checkedAt: NOW, entitlements: [], eventId: "first" })).applied).toBe(true);
    expect((await t.mutation(aws.beginRefresh, { productCode: PRODUCT,
      customerAWSAccountId: ACCOUNT, licenseArn: ARN, eventId: "first", eventTime: NOW - 1000 })).duplicate).toBe(true);
  });

  test("owner erasure removes registration and synthetic keys while keeping AWS reconciliation identity and audit", async () => {
    const t = convexTest(schema, modules);
    await stage(t);
    const owner = await claim(t);
    await refresh(t);
    await t.mutation(aws.createKey, { userId: "clerk-user", licenseId: owner.licenseId,
      name: "key", keyHash: hash(210), keyPrefix: "wm_000d2" });
    const deletionId = await t.run(async (ctx) => ctx.db.insert("accountDeletions", {
      userId: "clerk-user", userIdHash: hash(400), source: "self", status: "pending",
      step: "personal", personalTableIndex: PERSONAL_DELETE_TABLES.indexOf("awsMarketplaceLicenses"),
      startedAt: NOW, updatedAt: NOW,
    }));
    for (let i = 0; i < 4; i++) await t.run(async (ctx) => runEraseBatch(ctx, deletionId));
    const state = await t.run(async (ctx) => ({
      license: await ctx.db.get(owner.licenseId),
      keys: await ctx.db.query("userApiKeys").withIndex("by_userId", (q) => q.eq("userId", owner.principalId)).collect(),
      registrations: await ctx.db.query("awsMarketplaceRegistrations").withIndex("by_license", (q) => q.eq("licenseId", owner.licenseId)).collect(),
      audit: await ctx.db.query("awsMarketplaceAudit").withIndex("by_license_at", (q) => q.eq("licenseId", owner.licenseId)).collect(),
      deletion: await ctx.db.get(deletionId),
    }));
    expect(state.license).toMatchObject({ licenseArn: ARN, status: "inactive" });
    expect(state.license?.ownerUserId).toBeUndefined();
    expect(state.keys).toHaveLength(0);
    expect(state.registrations).toHaveLength(0);
    expect(state.audit.map((event) => event.event)).toContain("claimed");
    expect(state.deletion?.keyHashes).toContain(hash(210));
  });
});
