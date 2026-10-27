import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertAccountWritable, isAccountDeleting } from "./accountDeletion/guard";
import { getFeaturesForPlan, type PlanFeatures } from "./lib/entitlements";
import {
  AWS_MARKETPLACE_PRINCIPAL_PREFIX,
  AWS_MARKETPLACE_REFRESH_INTERVAL_MS,
  AWS_MARKETPLACE_VERIFICATION_MAX_AGE_MS,
  type AwsMarketplaceEntitlement,
} from "../shared/aws-marketplace";

const REGISTRATION_MAX_AGE_MS = 30 * 60_000;
const MAX_KEYS_PER_LICENSE = 5;
const entitlementValidator = v.object({
  dimension: v.string(),
  quantity: v.number(),
  expirationDate: v.number(),
});

function fail(code: string): never { throw new ConvexError(code); }
function principalId(id: Id<"awsMarketplaceLicenses">): string {
  return `${AWS_MARKETPLACE_PRINCIPAL_PREFIX}${id}`;
}
function validText(value: string, max = 512): boolean {
  return value.length > 0 && value.length <= max && value.trim() === value;
}
function validHash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function configuredProducts(): Set<string> {
  return new Set((process.env.AWS_MARKETPLACE_PRODUCT_CODES ?? "").split(",").map((v) => v.trim()).filter(Boolean));
}
function allowedProduct(productCode: string): boolean {
  return validText(productCode, 256) && configuredProducts().has(productCode);
}
function configuredDimensionPlans(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(process.env.AWS_MARKETPLACE_DIMENSION_PLAN_MAP ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([dimension, plan]) => {
      if (!validText(dimension, 256) || typeof plan !== "string") return false;
      try {
        const features = getFeaturesForPlan(plan);
        return features.apiAccess === true && features.mcpAccess === true;
      } catch { return false; }
    })) as Record<string, string>;
  } catch { return {}; }
}

function scaledFeatures(planKey: string, quantity: number): PlanFeatures | null {
  if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
  const base = getFeaturesForPlan(planKey);
  const limits = base.planLimits;
  if (!base.apiAccess || !base.mcpAccess || !limits ||
    typeof limits.apiRequestsPerDay !== "number" ||
    !Number.isSafeInteger(limits.apiRequestsPerDay) || limits.apiRequestsPerDay < 1) return null;
  const daily = limits.apiRequestsPerDay * quantity;
  const allowance = base.apiDailyAllowance === undefined ? undefined : base.apiDailyAllowance * quantity;
  const mcp = typeof limits.mcpCallsPerDay === "number" ? limits.mcpCallsPerDay * quantity : limits.mcpCallsPerDay;
  if (!Number.isSafeInteger(daily) ||
    (allowance !== undefined && !Number.isSafeInteger(allowance)) ||
    (typeof mcp === "number" && !Number.isSafeInteger(mcp))) return null;
  return { ...base, ...(allowance !== undefined ? { apiDailyAllowance: allowance } : {}),
    planLimits: { ...limits, apiRequestsPerDay: daily, mcpCallsPerDay: mcp } };
}

async function findLicense(ctx: QueryCtx | MutationCtx, identity: {
  productCode: string; customerAWSAccountId: string; licenseArn: string;
}) {
  return ctx.db.query("awsMarketplaceLicenses").withIndex("by_identity", (q) =>
    q.eq("productCode", identity.productCode)
      .eq("customerAWSAccountId", identity.customerAWSAccountId)
      .eq("licenseArn", identity.licenseArn),
  ).unique();
}

function effectiveValidUntil(license: Doc<"awsMarketplaceLicenses">): number {
  if (license.status !== "active" || !license.checkedAt || !license.contractExpiresAt) return 0;
  return Math.min(license.contractExpiresAt, license.checkedAt + AWS_MARKETPLACE_VERIFICATION_MAX_AGE_MS);
}

export function licenseIsActive(license: Doc<"awsMarketplaceLicenses">, now = Date.now()): boolean {
  return principalState(license, now) === "active";
}

function principalState(license: Doc<"awsMarketplaceLicenses">, now = Date.now()): "active" | "stale" | "inactive" {
  const planKey = configuredDimensionPlans()[license.dimension ?? ""];
  const validContract = Boolean(
    allowedProduct(license.productCode) && license.ownerUserId &&
    license.planKey && license.planKey === planKey &&
    license.quantity && scaledFeatures(license.planKey!, license.quantity) &&
    license.status === "active" && license.contractExpiresAt && license.contractExpiresAt > now,
  );
  if (!validContract) return "inactive";
  return effectiveValidUntil(license) > now ? "active" : "stale";
}

async function invalidateLicenseKeyCaches(ctx: MutationCtx, license: Doc<"awsMarketplaceLicenses">) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  const userId = principalId(license._id);
  const keys = await ctx.db.query("userApiKeys").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
  if (keys.length) await ctx.scheduler.runAfter(0, internal.payments.cacheActions.invalidateUserApiKeyCaches, {
    keyHashes: keys.map((key) => key.keyHash),
  });
}

async function audit(ctx: MutationCtx, licenseId: Id<"awsMarketplaceLicenses">,
  event: Doc<"awsMarketplaceAudit">["event"], revision?: number, keyId?: Id<"userApiKeys">) {
  await ctx.db.insert("awsMarketplaceAudit", { licenseId, event, at: Date.now(), revision, keyId });
}

export const stageRegistration = internalMutation({
  args: {
    registrationHash: v.string(), browserBindingHash: v.string(),
    customerAWSAccountId: v.string(), licenseArn: v.string(), productCode: v.string(),
    customerIdentifier: v.optional(v.string()), agreementId: v.optional(v.string()),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!validHash(args.registrationHash) || !validHash(args.browserBindingHash) ||
      !validText(args.customerAWSAccountId, 256) || !validText(args.licenseArn, 1024) ||
      !allowedProduct(args.productCode) ||
      (args.customerIdentifier !== undefined && !validText(args.customerIdentifier, 512)) ||
      (args.agreementId !== undefined && !validText(args.agreementId, 512)) ||
      !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= now ||
      args.expiresAt > now + REGISTRATION_MAX_AGE_MS) fail("INVALID_REGISTRATION");
    const existing = await ctx.db.query("awsMarketplaceRegistrations")
      .withIndex("by_registrationHash", (q) => q.eq("registrationHash", args.registrationHash)).unique();
    if (existing) fail("REGISTRATION_REPLAYED");
    let license = await findLicense(ctx, args);
    if (!license) {
      const id = await ctx.db.insert("awsMarketplaceLicenses", {
        productCode: args.productCode,
        customerAWSAccountId: args.customerAWSAccountId,
        licenseArn: args.licenseArn,
        customerIdentifier: args.customerIdentifier,
        agreementId: args.agreementId,
        status: "pending", nextRefreshAt: now, revision: 0, updatedAt: now,
      });
      license = (await ctx.db.get(id))!;
    } else if (
      (license.customerIdentifier && args.customerIdentifier && license.customerIdentifier !== args.customerIdentifier) ||
      (license.agreementId && args.agreementId && license.agreementId !== args.agreementId)
    ) fail("IDENTITY_MISMATCH");
    const registrationId = await ctx.db.insert("awsMarketplaceRegistrations", {
      registrationHash: args.registrationHash,
      browserBindingHash: args.browserBindingHash,
      licenseId: license._id,
      expiresAt: args.expiresAt,
    });
    return { registrationId };
  },
});

export const claimRegistration = internalMutation({
  args: { registrationHash: v.string(), browserBindingHash: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    if (!validHash(args.registrationHash) || !validHash(args.browserBindingHash) ||
      !validText(args.userId, 256) || args.userId.startsWith(AWS_MARKETPLACE_PRINCIPAL_PREFIX)) fail("INVALID_REGISTRATION");
    const registration = await ctx.db.query("awsMarketplaceRegistrations")
      .withIndex("by_registrationHash", (q) => q.eq("registrationHash", args.registrationHash)).unique();
    if (!registration || registration.browserBindingHash !== args.browserBindingHash) fail("REGISTRATION_NOT_FOUND");
    if (registration.claimedByUserId) {
      if (registration.claimedByUserId !== args.userId) fail("REGISTRATION_REPLAYED");
      return { licenseId: registration.licenseId, principalId: principalId(registration.licenseId) };
    }
    if (registration.expiresAt <= Date.now()) fail("REGISTRATION_EXPIRED");
    await assertAccountWritable(ctx, args.userId);
    const license = await ctx.db.get(registration.licenseId);
    if (!license) fail("LICENSE_NOT_FOUND");
    if (license.ownerUserId && license.ownerUserId !== args.userId) fail("LICENSE_ALREADY_CLAIMED");
    if (!license.ownerUserId) {
      await ctx.db.patch(license._id, { ownerUserId: args.userId, updatedAt: Date.now() });
      await audit(ctx, license._id, "claimed");
    }
    await ctx.db.patch(registration._id, { claimedByUserId: args.userId, claimedAt: Date.now() });
    return { licenseId: license._id, principalId: principalId(license._id) };
  },
});

export const account = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    if (!validText(args.userId, 256) || args.userId.startsWith(AWS_MARKETPLACE_PRINCIPAL_PREFIX)) fail("INVALID_USER_ID");
    const licenses = await ctx.db.query("awsMarketplaceLicenses")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.userId)).collect();
    return { licenses: await Promise.all(licenses.map(async (license) => {
      const keys = await ctx.db.query("userApiKeys")
        .withIndex("by_userId", (q) => q.eq("userId", principalId(license._id))).collect();
      return {
        id: license._id, productCode: license.productCode, licenseArn: license.licenseArn,
        status: licenseIsActive(license) ? "active" as const : license.status === "pending" ? "pending" as const : "inactive" as const,
        planKey: license.planKey, quantity: license.quantity,
        validUntil: effectiveValidUntil(license), checkedAt: license.checkedAt,
        keys: keys.map((key) => ({ id: key._id, name: key.name, keyPrefix: key.keyPrefix,
          createdAt: key.createdAt, revokedAt: key.revokedAt })),
      };
    })) };
  },
});

export const createKey = internalMutation({
  args: { userId: v.string(), licenseId: v.id("awsMarketplaceLicenses"), name: v.string(), keyHash: v.string(), keyPrefix: v.string() },
  handler: async (ctx, args) => {
    await assertAccountWritable(ctx, args.userId);
    const license = await ctx.db.get(args.licenseId);
    if (!license || license.ownerUserId !== args.userId) fail("LICENSE_NOT_FOUND");
    if (!licenseIsActive(license)) fail("LICENSE_INACTIVE");
    if (!validText(args.name.trim(), 80) || !validHash(args.keyHash) || !/^wm_[a-f0-9]{5}$/.test(args.keyPrefix)) fail("INVALID_KEY");
    const duplicate = await ctx.db.query("userApiKeys").withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash)).first();
    if (duplicate) fail("DUPLICATE_KEY");
    const userId = principalId(license._id);
    const keys = await ctx.db.query("userApiKeys").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
    if (keys.filter((key) => !key.revokedAt).length >= MAX_KEYS_PER_LICENSE) fail("KEY_LIMIT_REACHED");
    const keyId = await ctx.db.insert("userApiKeys", {
      userId, name: args.name.trim(), keyHash: args.keyHash, keyPrefix: args.keyPrefix,
      keyKind: "api", createdAt: Date.now(),
    });
    await audit(ctx, license._id, "key_created", undefined, keyId);
    return { keyId };
  },
});

export const revokeKey = internalMutation({
  args: { userId: v.string(), licenseId: v.id("awsMarketplaceLicenses"), keyId: v.id("userApiKeys") },
  handler: async (ctx, args) => {
    const license = await ctx.db.get(args.licenseId);
    if (!license || license.ownerUserId !== args.userId) fail("LICENSE_NOT_FOUND");
    const key = await ctx.db.get(args.keyId);
    if (!key || key.userId !== principalId(license._id)) fail("KEY_NOT_FOUND");
    if (!key.revokedAt) {
      await ctx.db.patch(key._id, { revokedAt: Date.now() });
      await audit(ctx, license._id, "key_revoked", undefined, key._id);
      if (process.env.UPSTASH_REDIS_REST_URL) await ctx.scheduler.runAfter(0,
        internal.payments.cacheActions.invalidateUserApiKeyCaches, { keyHashes: [key.keyHash] });
    }
    return { ok: true };
  },
});

export const beginRefresh = internalMutation({
  args: { productCode: v.string(), customerAWSAccountId: v.string(), licenseArn: v.string(),
    eventId: v.optional(v.string()), eventTime: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!allowedProduct(args.productCode) || !validText(args.customerAWSAccountId, 256) ||
      !validText(args.licenseArn, 1024) || (args.eventId && !validText(args.eventId, 512)) ||
      (args.eventTime !== undefined && (!Number.isSafeInteger(args.eventTime) || args.eventTime > Date.now() + 300_000))) fail("INVALID_IDENTITY");
    const now = Date.now();
    let license = await findLicense(ctx, args);
    if (!license) {
      const id = await ctx.db.insert("awsMarketplaceLicenses", {
        productCode: args.productCode, customerAWSAccountId: args.customerAWSAccountId,
        licenseArn: args.licenseArn, status: "pending", nextRefreshAt: now,
        revision: 0, updatedAt: now,
      });
      license = (await ctx.db.get(id))!;
    }
    if (args.eventId && license.lastEventId === args.eventId) return { licenseId: license._id, revision: license.revision, duplicate: true };
    if (args.eventTime !== undefined && license.lastEventTime !== undefined && args.eventTime < license.lastEventTime) {
      return { licenseId: license._id, revision: license.revision, duplicate: true };
    }
    const revision = license.revision + 1;
    await ctx.db.patch(license._id, {
      revision, pendingEventId: args.eventId, pendingEventTime: args.eventTime,
      nextRefreshAt: now + 60_000, updatedAt: now,
    });
    return { licenseId: license._id, revision, duplicate: false };
  },
});

function resolveSnapshot(entitlements: AwsMarketplaceEntitlement[], checkedAt: number) {
  const plans = configuredDimensionPlans();
  const matches = entitlements.filter((entitlement) => plans[entitlement.dimension] !== undefined &&
    Number.isSafeInteger(entitlement.quantity) && entitlement.quantity > 0 &&
    Number.isSafeInteger(entitlement.expirationDate) && entitlement.expirationDate > checkedAt &&
    scaledFeatures(plans[entitlement.dimension]!, entitlement.quantity));
  if (matches.length !== 1) return null;
  const selected = matches[0]!;
  return { dimension: selected.dimension, planKey: plans[selected.dimension]!,
    quantity: selected.quantity, contractExpiresAt: selected.expirationDate };
}

export const applyRefresh = internalMutation({
  args: { licenseId: v.id("awsMarketplaceLicenses"), revision: v.number(), checkedAt: v.number(),
    entitlements: v.array(entitlementValidator), eventId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const license = await ctx.db.get(args.licenseId);
    if (!license) fail("LICENSE_NOT_FOUND");
    if (!Number.isSafeInteger(args.revision) || args.revision <= 0 ||
      !Number.isSafeInteger(args.checkedAt) || args.checkedAt > Date.now() + 60_000 ||
      Date.now() - args.checkedAt > 60_000 || args.entitlements.length > 100) fail("INVALID_SNAPSHOT");
    if (license.revision !== args.revision || (args.eventId && license.pendingEventId !== args.eventId)) {
      await audit(ctx, license._id, "refresh_superseded", args.revision);
      return { applied: false };
    }
    const snapshot = resolveSnapshot(args.entitlements, args.checkedAt);
    await ctx.db.patch(license._id, {
      status: snapshot ? "active" : "inactive",
      dimension: snapshot?.dimension, planKey: snapshot?.planKey,
      quantity: snapshot?.quantity, contractExpiresAt: snapshot?.contractExpiresAt,
      checkedAt: args.checkedAt,
      lastEventId: license.pendingEventId ?? license.lastEventId,
      lastEventTime: license.pendingEventTime ?? license.lastEventTime,
      pendingEventId: undefined, pendingEventTime: undefined,
      nextRefreshAt: args.checkedAt + AWS_MARKETPLACE_REFRESH_INTERVAL_MS,
      updatedAt: Date.now(),
    });
    await audit(ctx, license._id, snapshot ? "refresh_active" : "refresh_inactive", args.revision);
    await invalidateLicenseKeyCaches(ctx, license);
    return { applied: true };
  },
});

export const listDue = internalQuery({
  args: { cursor: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) fail("INVALID_LIMIT");
    const page = await ctx.db.query("awsMarketplaceLicenses")
      .withIndex("by_nextRefreshAt", (q) => q.lte("nextRefreshAt", Date.now()))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    return { licenses: page.page.map((license) => ({
      id: license._id, productCode: license.productCode,
      customerAWSAccountId: license.customerAWSAccountId, licenseArn: license.licenseArn,
    })), cursor: page.isDone ? undefined : page.continueCursor };
  },
});

export const pruneExpiredRegistrations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("awsMarketplaceRegistrations")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(100);
    for (const registration of expired) await ctx.db.delete(registration._id);
    if (expired.length === 100) await ctx.scheduler.runAfter(0, (internal as any).awsMarketplace.pruneExpiredRegistrations, {});
    return { deleted: expired.length };
  },
});

export async function principalEntitlementsForUser(ctx: QueryCtx, userId: string) {
  if (!userId.startsWith(AWS_MARKETPLACE_PRINCIPAL_PREFIX)) return null;
  const id = ctx.db.normalizeId("awsMarketplaceLicenses", userId.slice(AWS_MARKETPLACE_PRINCIPAL_PREFIX.length));
  const license = id ? await ctx.db.get(id) : null;
  if (!license || !licenseIsActive(license) ||
    (license.ownerUserId && await isAccountDeleting(ctx, license.ownerUserId))) return null;
  return { planKey: license.planKey!, features: scaledFeatures(license.planKey!, license.quantity!)!, validUntil: effectiveValidUntil(license) };
}

export async function validPrincipalKey(ctx: QueryCtx, userId: string): Promise<boolean> {
  const id = ctx.db.normalizeId("awsMarketplaceLicenses", userId.slice(AWS_MARKETPLACE_PRINCIPAL_PREFIX.length));
  const license = id ? await ctx.db.get(id) : null;
  return Boolean(license && principalState(license) !== "inactive" && license.ownerUserId && !(await isAccountDeleting(ctx, license.ownerUserId)));
}

export const getPrincipalAccessProjection = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("awsMarketplaceLicenses", args.userId.slice(AWS_MARKETPLACE_PRINCIPAL_PREFIX.length));
    const license = id ? await ctx.db.get(id) : null;
    const state = !license || !license.ownerUserId || await isAccountDeleting(ctx, license.ownerUserId)
      ? "inactive" as const : principalState(license);
    const entitlement = state === "active" && license
      ? { planKey: license.planKey!, features: scaledFeatures(license.planKey!, license.quantity!)!,
        validUntil: effectiveValidUntil(license) }
      : { planKey: "free", features: getFeaturesForPlan("free"), validUntil: 0 };
    return { state, entitlement };
  },
});
