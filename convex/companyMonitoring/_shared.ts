import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  COMPANY_MONITORING_LIMITS,
  type NormalizedMonitoredCompanyInput,
} from "../../shared/company-monitoring-contract";

export const COMPANY_LIMIT = COMPANY_MONITORING_LIMITS.maxCompaniesPerAccount;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REQUEST_CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;

type CompanyMonitoringCtx = MutationCtx | QueryCtx;

export function normalizeRequestId(value: string, field = "clientRequestId"): string {
  if (typeof value !== "string" || REQUEST_CONTROL.test(value)) {
    throw new ConvexError(`INVALID_${field.toUpperCase()}`);
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > 64) {
    throw new ConvexError(`INVALID_${field.toUpperCase()}`);
  }
  return normalized;
}

export async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeTime(time: number): string {
  let remaining = Math.max(0, Math.trunc(time));
  let result = "";
  for (let i = 0; i < 10; i += 1) {
    result = CROCKFORD[remaining % 32] + result;
    remaining = Math.floor(remaining / 32);
  }
  return result;
}

export function logicalId(kind: "account" | "company" | "claim", now = Date.now()): string {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  const suffix = encodeTime(now) + Array.from(random, (byte) => CROCKFORD[byte & 31]).join("");
  return `cm_${kind}_${suffix}`;
}

export async function activeAccountForOwner(
  ctx: CompanyMonitoringCtx,
  ownerUserId: string,
  knownEntitlement?: Doc<"entitlements"> | null,
) {
  const entitlementPromise = knownEntitlement === undefined
    ? ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", ownerUserId))
        .first()
    : Promise.resolve(knownEntitlement);
  const [account, entitlement] = await Promise.all([
    ctx.db
      .query("companyMonitoringAccounts")
      .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", ownerUserId))
      .unique(),
    entitlementPromise,
  ]);
  const activeEntitlement = Boolean(
    entitlement &&
    entitlement.planKey !== "free" &&
    entitlement.features.tier > 0 &&
    entitlement.validUntil >= Date.now(),
  );
  if (
    !account ||
    !activeEntitlement ||
    account.lifecycle !== "entitled" ||
    account.ownerUserId !== ownerUserId ||
    account.terminalReason
  ) {
    return null;
  }
  return account;
}

export async function requireActiveAccount(ctx: CompanyMonitoringCtx, ownerUserId: string) {
  const account = await activeAccountForOwner(ctx, ownerUserId);
  if (!account) throw new ConvexError("COMPANY_MONITORING_ACCESS_DENIED");
  return account;
}

function claimsFromCompany(company: NormalizedMonitoredCompanyInput) {
  return [
    ...company.aliases.map((value) => ({ type: "alias" as const, value })),
    ...company.domains.map((value) => ({ type: "domain" as const, value })),
    ...company.identifiers.map((value) => ({ type: "legal_identifier" as const, value })),
    ...company.xHandles.map((value) => ({ type: "x_handle" as const, value })),
    ...company.locations.map((value) => ({ type: "location" as const, value })),
    ...(company.customerReference
      ? [{ type: "customer_reference" as const, value: company.customerReference }]
      : []),
  ];
}

export async function insertClaims(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
  company: NormalizedMonitoredCompanyInput,
  now: number,
) {
  for (const claim of claimsFromCompany(company)) {
    await ctx.db.insert("companyMonitoringClaims", {
      ownerAccountId,
      companyId,
      claimId: logicalId("claim", now),
      ...claim,
      provenance: "customer",
      trustState: "unverified",
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function deleteCompanyClaims(
  ctx: MutationCtx,
  ownerAccountId: string,
  companyId: string,
) {
  const claims = await ctx.db
    .query("companyMonitoringClaims")
    .withIndex("by_account_company", (q) =>
      q.eq("ownerAccountId", ownerAccountId).eq("companyId", companyId),
    )
    .collect();
  for (const claim of claims) await ctx.db.delete(claim._id);
}
