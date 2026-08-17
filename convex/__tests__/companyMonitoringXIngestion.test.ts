import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import {
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  schema,
} from "./companyMonitoring.helpers";
import { internal } from "../_generated/api";

const ORCHESTRATION = (internal as any).companyMonitoring.orchestration;
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER_ACCOUNT_ID = "cm_account_x_ingestion";
const COMPANY_A = "cm_company_01K23AAAAAAAAAAAAAAAAAAAAA";
const COMPANY_B = "cm_company_01K23BBBBBBBBBBBBBBBBBBBBB";
const DOMAIN_CLAIM_A = "cm_claim_01K24AAAAAAAAAAAAAAAAAAAAA";
const HANDLE_CLAIM_A = "cm_claim_01K25AAAAAAAAAAAAAAAAAAAAA";
const DOMAIN_CLAIM_B = "cm_claim_01K24BBBBBBBBBBBBBBBBBBBBB";
const HANDLE_CLAIM_B = "cm_claim_01K25BBBBBBBBBBBBBBBBBBBBB";
const ACCOUNT_ID = "102812444";

installCompanyMonitoringTestEnvironment();

async function seedXWork(
  t: ReturnType<typeof convexTest>,
  options: {
    companies?: 1 | 2;
    checkpoint?: string;
    domainTrust?: "verified" | "unverified";
  } = {},
) {
  const companies = options.companies ?? 1;
  const domainTrust = options.domainTrust ?? "verified";
  await t.run(async (ctx) => {
    await ctx.db.insert("companyMonitoringAccounts", {
      logicalAccountId: OWNER_ACCOUNT_ID,
      ownerUserId: "user_x_ingestion",
      ownerFenceHash: "fence_x_ingestion",
      lifecycle: "entitled",
      lifecycleSequence: 1,
      companyCount: companies,
      companyLimit: 500,
      snapshotGeneration: 1,
      purgeGeneration: 0,
      purgePhase: "none",
      destructivePurgeStarted: false,
      pendingReactivation: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const rows = [
      {
        companyId: COMPANY_A,
        name: "Stripe, Inc.",
        sortName: "stripe inc",
        domainClaimId: DOMAIN_CLAIM_A,
        handleClaimId: HANDLE_CLAIM_A,
        domain: "stripe.com",
        handle: "stripe",
      },
      {
        companyId: COMPANY_B,
        name: "Stripe Payments UK Ltd",
        sortName: "stripe payments uk ltd",
        domainClaimId: DOMAIN_CLAIM_B,
        handleClaimId: HANDLE_CLAIM_B,
        domain: "stripe-payments.example",
        handle: "stripepayments",
      },
    ].slice(0, companies);
    for (const row of rows) {
      await ctx.db.insert("companyMonitoringCompanies", {
        ownerAccountId: OWNER_ACCOUNT_ID,
        companyId: row.companyId,
        name: row.name,
        sortName: row.sortName,
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
        ownerAccountId: OWNER_ACCOUNT_ID,
        companyId: row.companyId,
        claimId: row.domainClaimId,
        type: "domain",
        value: row.domain,
        provenance: domainTrust === "verified" ? "independent_provider" : "customer",
        trustState: domainTrust,
        ...(domainTrust === "verified"
          ? {
              allowedUses: ["attribution" as const, "primary_evidence" as const],
              expiresAt: NOW + 30 * DAY_MS,
            }
          : {}),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("companyMonitoringClaims", {
        ownerAccountId: OWNER_ACCOUNT_ID,
        companyId: row.companyId,
        claimId: row.handleClaimId,
        type: "x_handle",
        value: row.handle,
        provenance: "customer",
        trustState: "unverified",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  });

  await t.mutation(ORCHESTRATION.scheduleAccountWork, {
    ownerAccountId: OWNER_ACCOUNT_ID,
    source: "x",
    companyIds: companies === 1 ? [COMPANY_A] : [COMPANY_A, COMPANY_B],
  });
  if (options.checkpoint) {
    await t.run(async (ctx) => {
      const obligation = await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A).eq("source", "x"),
        )
        .unique();
      await ctx.db.patch(obligation!._id, { checkpoint: options.checkpoint });
    });
  }
  return t.mutation(ORCHESTRATION.claimNextWorkForTest, { workerId: "x-worker" });
}

function identity(companyId = COMPANY_A, overrides: Record<string, unknown> = {}) {
  const isFirst = companyId === COMPANY_A;
  const checkedAt = Date.now();
  return {
    companyId,
    domainClaimId: isFirst ? DOMAIN_CLAIM_A : DOMAIN_CLAIM_B,
    xHandleClaimId: isFirst ? HANDLE_CLAIM_A : HANDLE_CLAIM_B,
    officialDomain: isFirst ? "stripe.com" : "stripe-payments.example",
    officialPageUrl: isFirst ? "https://stripe.com/" : "https://stripe-payments.example/",
    accountId: ACCOUNT_ID,
    currentHandle: isFirst ? "stripe" : "stripepayments",
    profileName: isFirst ? "Stripe" : "Stripe Payments UK",
    domicileCountry: "US" as const,
    authorityRole: "company" as const,
    state: "authoritative" as const,
    badgeVerified: false,
    allowedUses: ["primary_evidence" as const, "recent_search" as const],
    checkedAt,
    expiresAt: checkedAt + 7 * DAY_MS,
    evidenceHash: (isFirst ? "a" : "b").repeat(64),
    ...overrides,
  };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY_A,
    postId: "1912345678901234567",
    authorAccountId: ACCOUNT_ID,
    currentHandle: "stripe",
    createdAt: NOW - 1_000,
    observedAt: NOW,
    contentState: "active" as const,
    storageState: "full_text" as const,
    text: "Official Stripe update",
    editHistoryPostIds: ["1912345678901234567"],
    ...overrides,
  };
}

function xIngestion(
  claim: any,
  overrides: Record<string, unknown> = {},
) {
  const checkpointBefore = claim.work.obligations.find(
    (obligation: { companyId: string; checkpoint?: string }) => obligation.companyId === COMPANY_A,
  )?.checkpoint;
  return {
    requestedWindow: { startAt: claim.work.windowStart, endAt: claim.work.windowEnd },
    returnedWindow: { startAt: claim.work.windowStart, endAt: claim.work.windowEnd },
    checkpoints: [{
      companyId: COMPANY_A,
      ...(checkpointBefore ? { checkpointBefore } : {}),
      checkpointAfter: "x-checkpoint-1",
    }],
    packing: [{
      packId: "c".repeat(64),
      query: "(from:stripe) -is:retweet",
      companyIds: [COMPANY_A],
      accountIds: [ACCOUNT_ID],
      handles: ["stripe"],
    }],
    gaps: [],
    permittedStorage: "full_text" as const,
    identities: [identity()],
    posts: [post()],
    unexpectedAuthorAccountIds: [],
    requestCount: 1,
    complianceEventCount: 0,
    ...overrides,
  };
}

async function finalize(t: ReturnType<typeof convexTest>, claim: any, overrides = {}) {
  return t.mutation(ORCHESTRATION.finalizeWorkForTest, {
    workerId: "x-worker",
    workId: claim.work.workId,
    leaseToken: claim.work.leaseToken,
    result: {
      type: "result",
      itemCount: 1,
      hasMore: false,
      coverage: "complete",
      returnedRange: { startAt: claim.work.windowStart, endAt: claim.work.windowEnd },
      checkpoint: "x-checkpoint-1",
      emptyValidated: false,
      costUsdMicros: 100,
      xIngestion: xIngestion(claim),
      ...overrides,
    },
  });
}

describe("Company Monitoring compliant X ingestion", () => {
  test("does not grant official authority from customer-unverified domain claims", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t, { domainTrust: "unverified" });
    expect(claim.work.subjects[0].domains).toEqual([]);

    expect(await finalize(t, claim)).toMatchObject({
      status: "non_reassuring",
      reason: "malformed",
    });
    const state = await t.run(async (ctx) => ({
      identities: await ctx.db.query("companyMonitoringXIdentities").collect(),
      evidence: await ctx.db.query("companyMonitoringXEvidence").collect(),
      obligation: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A).eq("source", "x"),
        )
        .unique(),
    }));
    expect(state.identities).toEqual([]);
    expect(state.evidence).toEqual([]);
    expect(state.obligation?.checkpoint).toBeUndefined();
  });

  test("claims exact company evidence and persists authoritative identity, posts, and audit receipt", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t);
    expect(claim).toMatchObject({
      status: "claimed",
      work: {
        source: "x",
        subjects: [{
          companyId: COMPANY_A,
          name: "Stripe, Inc.",
          domicileCountry: "US",
          domains: [{ claimId: DOMAIN_CLAIM_A, value: "stripe.com" }],
          xHandles: [{ claimId: HANDLE_CLAIM_A, value: "stripe" }],
        }],
      },
    });

    expect(await finalize(t, claim)).toMatchObject({ status: "completed" });
    const stored = await t.run(async (ctx) => ({
      identity: await ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234567"),
        )
        .unique(),
      normalizedEvidence: await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      candidate: await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      work: await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique(),
    }));
    expect(stored.identity).toMatchObject({
      accountId: ACCOUNT_ID,
      currentHandle: "stripe",
      state: "authoritative",
      domainClaimId: DOMAIN_CLAIM_A,
      xHandleClaimId: HANDLE_CLAIM_A,
      allowedUses: ["primary_evidence", "recent_search"],
    });
    expect(stored.evidence).toMatchObject({
      contentState: "active",
      storageState: "full_text",
      text: "Official Stripe update",
    });
    expect(stored.normalizedEvidence).toMatchObject({
      provider: "x",
      providerLocator: "1912345678901234567",
      sourceAuthority: "verified_first_party",
      independence: "first_party",
      state: "active",
      authorAccountId: ACCOUNT_ID,
    });
    expect(stored.candidate).toMatchObject({
      state: "pending_classification",
      observationBlocking: true,
      referenceCount: 1,
      referencesTruncated: false,
      selectionPolicyVersion: "cm-evidence-selection-v1",
    });
    expect(stored.work).toMatchObject({
      state: "complete",
      terminalReceipt: {
        xIngestion: {
          requestedWindow: xIngestion(claim).requestedWindow,
          packing: [{ packId: "c".repeat(64) }],
          checkpoints: [{ companyId: COMPANY_A, checkpointAfter: "x-checkpoint-1" }],
          gaps: [],
        },
      },
    });
  });

  test("accepts bounded identity clock skew and rejects excessive skew in both directions", async () => {
    const positive = convexTest(schema, modules);
    const positiveClaim = await seedXWork(positive);
    const positiveCheckedAt = NOW + 1_000;
    expect(await finalize(positive, positiveClaim, {
      xIngestion: xIngestion(positiveClaim, {
        identities: [identity(COMPANY_A, {
          checkedAt: positiveCheckedAt,
          expiresAt: positiveCheckedAt + 7 * DAY_MS,
        })],
      }),
    })).toMatchObject({ status: "completed" });

    const negative = convexTest(schema, modules);
    const negativeClaim = await seedXWork(negative);
    const negativeCheckedAt = NOW - 1_000;
    expect(await finalize(negative, negativeClaim, {
      xIngestion: xIngestion(negativeClaim, {
        identities: [identity(COMPANY_A, {
          checkedAt: negativeCheckedAt,
          expiresAt: negativeCheckedAt + 7 * DAY_MS,
        })],
      }),
    })).toMatchObject({ status: "completed" });

    for (const checkedAt of [NOW + 30_001, NOW - 30_001]) {
      const rejected = convexTest(schema, modules);
      const rejectedClaim = await seedXWork(rejected);
      expect(await finalize(rejected, rejectedClaim, {
        xIngestion: xIngestion(rejectedClaim, {
          identities: [identity(COMPANY_A, {
            checkedAt,
            expiresAt: checkedAt + 7 * DAY_MS,
          })],
        }),
      })).toMatchObject({ status: "non_reassuring", reason: "malformed" });
      const rejectedRows = await rejected.run(async (ctx) => ({
        identities: await ctx.db.query("companyMonitoringXIdentities").collect(),
        evidence: await ctx.db.query("companyMonitoringXEvidence").collect(),
      }));
      expect(rejectedRows).toEqual({ identities: [], evidence: [] });
    }
  });

  test("keeps a persisted immutable-account rename authoritative on the next claim", async () => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim, {
      xIngestion: xIngestion(firstClaim, {
        identities: [identity(COMPANY_A, { currentHandle: "stripe_new" })],
        posts: [post({ currentHandle: "stripe_new" })],
      }),
    });

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    expect(secondClaim.work.subjects[0]).toMatchObject({
      xHandles: [{ claimId: HANDLE_CLAIM_A, value: "stripe" }],
      currentIdentity: {
        accountId: ACCOUNT_ID,
        currentHandle: "stripe_new",
        state: "authoritative",
        allowedUses: ["primary_evidence", "recent_search"],
      },
    });
  });

  test("demotes an identity bound only to a customer-unverified domain", async () => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);
    await t.run(async (ctx) => {
      const domainClaim = await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .filter((q) => q.eq(q.field("claimId"), DOMAIN_CLAIM_A))
        .unique();
      await ctx.db.patch(domainClaim!._id, {
        provenance: "customer",
        trustState: "unverified",
        allowedUses: undefined,
        expiresAt: undefined,
        updatedAt: NOW + DAY_MS,
      });
    });

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    expect(secondClaim.work.subjects[0]).toMatchObject({
      domains: [],
      currentIdentity: {
        accountId: ACCOUNT_ID,
        state: "demoted",
        demotionReason: "official_link_lost",
        allowedUses: [],
      },
    });
    const normalized = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      candidate: await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(normalized.evidence).toMatchObject({ state: "authority_lost" });
    expect(normalized.candidate).toMatchObject({
      state: "terminal",
      terminalReason: "authority_lost",
      observationBlocking: false,
      referenceCount: 0,
    });
  });

  test("preserves the immutable account ID after a reassignment demotion", async () => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    const replacementAccountId = "202812444";
    expect(await finalize(t, secondClaim, {
      itemCount: 0,
      emptyValidated: true,
      xIngestion: xIngestion(secondClaim, {
        identities: [identity(COMPANY_A, {
          accountId: replacementAccountId,
          state: "demoted",
          demotionReason: "account_reassigned",
          allowedUses: [],
        })],
        posts: [],
      }),
    })).toMatchObject({ status: "completed" });

    const storedIdentity = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringXIdentities")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
      )
      .unique());
    expect(storedIdentity).toMatchObject({
      accountId: ACCOUNT_ID,
      state: "demoted",
      demotionReason: "account_reassigned",
      allowedUses: [],
    });

    vi.setSystemTime(NOW + 2 * DAY_MS);
    const thirdClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    expect(thirdClaim.work.subjects[0].currentIdentity).toMatchObject({
      accountId: ACCOUNT_ID,
      state: "demoted",
    });
  });

  test("pins the prior immutable account ID when a replacement account is demoted", async () => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    const replacementAccountId = "202812445";
    await finalize(t, secondClaim, {
      xIngestion: xIngestion(secondClaim, {
        identities: [identity(COMPANY_A, {
          accountId: replacementAccountId,
          currentHandle: "stripe_alt",
          state: "demoted",
          demotionReason: "account_changed",
          allowedUses: [],
        })],
        posts: [post({
          postId: "1912345678901234569",
          authorAccountId: replacementAccountId,
          currentHandle: "stripe_alt",
          text: "replacement account content",
          editHistoryPostIds: ["1912345678901234569"],
          observedAt: NOW + DAY_MS,
        })],
      }),
    });

    const stored = await t.run(async (ctx) => ({
      identity: await ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      replacementEvidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234569"),
        )
        .unique(),
    }));
    expect(stored.identity).toMatchObject({
      accountId: ACCOUNT_ID,
      state: "demoted",
      demotionReason: "account_changed",
      allowedUses: [],
    });
    expect(stored.replacementEvidence).toBeNull();
  });

  test("redacts a full-text reconciliation update after the identity is demoted", async () => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    await finalize(t, secondClaim, {
      xIngestion: xIngestion(secondClaim, {
        identities: [identity(COMPANY_A, {
          state: "demoted",
          demotionReason: "official_link_lost",
          allowedUses: [],
        })],
        posts: [post({ text: "must be removed", observedAt: NOW + DAY_MS })],
        complianceEventCount: 1,
      }),
    });

    const evidence = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringXEvidence")
      .withIndex("by_account_postId", (q) =>
        q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234567"),
      )
      .unique());
    expect(evidence).toMatchObject({
      contentState: "active",
      storageState: "metadata_only",
    });
    expect(evidence?.text).toBeUndefined();
  });

  test.each([
    ["protected", undefined],
    ["withheld", ["DE", "FR"]],
  ] as const)("removes retained text when a post becomes %s", async (contentState, countryCodes) => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    await finalize(t, secondClaim, {
      xIngestion: xIngestion(secondClaim, {
        posts: [post({
          contentState,
          storageState: "metadata_only",
          text: undefined,
          observedAt: NOW + DAY_MS,
          ...(countryCodes ? { withheldCountryCodes: countryCodes } : {}),
        })],
        complianceEventCount: 1,
      }),
    });
    const stored = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234567"),
        )
        .unique(),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      normalizedEvidence: await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      candidate: await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(stored.evidence).toMatchObject({
      contentState,
      storageState: "metadata_only",
      ...(countryCodes ? { withheldCountryCodes: countryCodes } : {}),
    });
    expect(stored.evidence?.text).toBeUndefined();
    expect(stored.company?.evidenceRevision).toBeUndefined();
    expect(stored.company?.recomputeRequiredAt).toBeUndefined();
    expect(stored.normalizedEvidence).toMatchObject({ state: "unavailable" });
    expect(stored.candidate).toMatchObject({
      state: "terminal",
      terminalReason: "evidence_unavailable",
      observationBlocking: false,
      referenceCount: 0,
    });
  });

  test.each([
    ["domain", DOMAIN_CLAIM_A],
    ["handle", HANDLE_CLAIM_A],
  ] as const)("demotes authority when the bound %s claim is removed", async (_kind, claimId) => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);
    await t.run(async (ctx) => {
      const claim = await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .filter((q) => q.eq(q.field("claimId"), claimId))
        .unique();
      await ctx.db.delete(claim!._id);
    });
    vi.setSystemTime(NOW + DAY_MS);
    const claim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    expect(claim.work.subjects[0]).toMatchObject({
      currentIdentity: {
        accountId: ACCOUNT_ID,
        state: "demoted",
        demotionReason: "official_link_lost",
        allowedUses: [],
      },
      trackedPosts: [{
        postId: "1912345678901234567",
        authorAccountId: ACCOUNT_ID,
      }],
    });
    const storedIdentity = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringXIdentities")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
      )
      .unique());
    expect(storedIdentity).toMatchObject({
      state: "demoted",
      demotionReason: "official_link_lost",
      allowedUses: [],
    });
  });

  test("rotates bounded compliance reconciliation to evidence omitted by the prior scan", async () => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    const postIds = Array.from(
      { length: 5 },
      (_, index) => `19123456789012345${index + 60}`,
    );
    const initialPosts = postIds.map((postId) => post({
      postId,
      editHistoryPostIds: [postId],
    }));
    await finalize(t, firstClaim, {
      itemCount: initialPosts.length,
      xIngestion: xIngestion(firstClaim, { posts: initialPosts }),
    });

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    const firstBatch = secondClaim.work.subjects[0].trackedPosts as Array<{
      postId: string;
      authorAccountId: string;
    }>;
    expect(firstBatch).toHaveLength(4);
    await finalize(t, secondClaim, {
      itemCount: firstBatch.length,
      xIngestion: xIngestion(secondClaim, {
        posts: firstBatch.map(({ postId }) => post({
          postId,
          editHistoryPostIds: [postId],
          observedAt: NOW + DAY_MS,
        })),
        complianceEventCount: firstBatch.length,
      }),
    });
    const reconciledRows = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringXEvidence")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
      )
      .collect());
    const firstBatchIds = new Set(firstBatch.map(({ postId }) => postId));
    expect(reconciledRows.filter((row) => firstBatchIds.has(row.postId))).toEqual(
      expect.arrayContaining(firstBatch.map(({ postId }) => expect.objectContaining({
        postId,
        contentState: "active",
        lastReconciledAt: NOW + DAY_MS,
      }))),
    );

    vi.setSystemTime(NOW + 2 * DAY_MS);
    const thirdClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    const secondBatch = thirdClaim.work.subjects[0].trackedPosts as Array<{ postId: string }>;
    expect(secondBatch).toHaveLength(4);
    expect(secondBatch.some(({ postId }) => !firstBatchIds.has(postId))).toBe(true);
  });

  test("stores useful partial evidence but records gaps and preserves the prior checkpoint", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t, { checkpoint: "checkpoint-before" });
    const midpoint = claim.work.windowStart + DAY_MS / 2;
    const payload = xIngestion(claim, {
      returnedWindow: { startAt: midpoint, endAt: claim.work.windowEnd },
      checkpoints: [{
        companyId: COMPANY_A,
        checkpointBefore: "checkpoint-before",
        checkpointAfter: "x-partial-checkpoint",
      }],
      gaps: [{
        startAt: claim.work.windowStart,
        endAt: midpoint,
        reason: "provider_retention",
      }],
    });
    expect(await finalize(t, claim, {
      coverage: "partial",
      checkpoint: "x-partial-checkpoint",
      xIngestion: payload,
    })).toMatchObject({ status: "non_reassuring", reason: "partial" });

    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234567"),
        )
        .unique(),
      obligation: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A).eq("source", "x"),
        )
        .unique(),
      work: await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_workId", (q) => q.eq("workId", claim.work.workId))
        .unique(),
    }));
    expect(state.evidence).toBeTruthy();
    expect(state.obligation?.checkpoint).toBe("checkpoint-before");
    expect(state.work).toMatchObject({
      terminalReceipt: {
        sourceCoverage: "partial",
        xIngestion: { gaps: [{ reason: "provider_retention" }] },
      },
    });
  });

  test("rejects complete coverage when the X returned window omits requested time", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t, { checkpoint: "checkpoint-before" });
    const midpoint = claim.work.windowStart + DAY_MS / 2;
    expect(await finalize(t, claim, {
      xIngestion: xIngestion(claim, {
        returnedWindow: { startAt: midpoint, endAt: claim.work.windowEnd },
      }),
    })).toMatchObject({ status: "non_reassuring", reason: "malformed" });

    const state = await t.run(async (ctx) => ({
      identities: await ctx.db.query("companyMonitoringXIdentities").collect(),
      evidence: await ctx.db.query("companyMonitoringXEvidence").collect(),
      obligation: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A).eq("source", "x"),
        )
        .unique(),
    }));
    expect(state.identities).toEqual([]);
    expect(state.evidence).toEqual([]);
    expect(state.obligation?.checkpoint).toBe("checkpoint-before");
  });

  test("rejects a checkpoint-before mismatch without X writes or checkpoint advancement", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t, { checkpoint: "checkpoint-before" });
    const payload = xIngestion(claim, {
      checkpoints: [{
        companyId: COMPANY_A,
        checkpointBefore: "wrong-checkpoint",
        checkpointAfter: "x-checkpoint-1",
      }],
    });
    expect(await finalize(t, claim, { xIngestion: payload })).toMatchObject({
      status: "non_reassuring",
      reason: "malformed",
    });
    const state = await t.run(async (ctx) => ({
      identities: await ctx.db.query("companyMonitoringXIdentities").collect(),
      evidence: await ctx.db.query("companyMonitoringXEvidence").collect(),
      obligation: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A).eq("source", "x"),
        )
        .unique(),
    }));
    expect(state.identities).toEqual([]);
    expect(state.evidence).toEqual([]);
    expect(state.obligation?.checkpoint).toBe("checkpoint-before");
  });

  test("removes identity and evidence rows through the bounded company purge", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t);
    await finalize(t, claim);
    await t.run(async (ctx) => {
      const company = await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.patch(company!._id, {
        lifecycle: "removed",
        purgeGeneration: 1,
        purgePhase: "scan",
        removedAt: NOW,
      });
    });
    let status = "scan";
    for (let attempt = 0; attempt < 5 && status !== "complete"; attempt += 1) {
      const result = await t.mutation(
        (internal as any).companyMonitoring.companies.advanceCompanyPurge,
        { ownerAccountId: OWNER_ACCOUNT_ID, companyId: COMPANY_A, purgeGeneration: 1 },
      );
      status = result.status;
    }
    expect(status).toBe("complete");
    const rows = await t.run(async (ctx) => ({
      identities: await ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect(),
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect(),
      aliases: await ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect(),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      normalizedEvidence: await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      candidate: await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(rows.identities).toEqual([]);
    expect(rows.evidence).toEqual([]);
    expect(rows.aliases).toEqual([]);
    expect(rows.company).toMatchObject({ purgePhase: "complete" });
    expect(rows.company?.evidenceRevision).toBeUndefined();
    expect(rows.company?.recomputeRequiredAt).toBeUndefined();
    expect(rows.normalizedEvidence).toBeNull();
    expect(rows.candidate).toBeNull();
  });

  test("removes remaining edit aliases when company evidence is already absent", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t);
    await finalize(t, claim);
    await t.run(async (ctx) => {
      const evidence = await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.delete(evidence!._id);
      const company = await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique();
      await ctx.db.patch(company!._id, {
        lifecycle: "removed",
        purgeGeneration: 1,
        purgePhase: "scan",
        removedAt: NOW,
      });
    });

    let status = "scan";
    for (let attempt = 0; attempt < 5 && status !== "complete"; attempt += 1) {
      const result = await t.mutation(
        (internal as any).companyMonitoring.companies.advanceCompanyPurge,
        { ownerAccountId: OWNER_ACCOUNT_ID, companyId: COMPANY_A, purgeGeneration: 1 },
      );
      status = result.status;
    }

    expect(status).toBe("complete");
    expect(await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect()
    )).toEqual([]);
  });

  test("removes identity and evidence rows before account payload purge", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t);
    await finalize(t, claim);
    await t.run(async (ctx) => {
      const account = await ctx.db
        .query("companyMonitoringAccounts")
        .withIndex("by_logicalAccountId", (q) => q.eq("logicalAccountId", OWNER_ACCOUNT_ID))
        .unique();
      await ctx.db.patch(account!._id, {
        lifecycle: "denied",
        terminalReason: "account_deleted",
        purgeGeneration: 1,
        purgePhase: "scan",
        destructivePurgeStarted: true,
      });
    });
    expect(await t.mutation(
      (internal as any).companyMonitoring.accounts.advanceAccountPurge,
      { ownerFenceHash: "fence_x_ingestion", purgeGeneration: 1 },
    )).toEqual({ status: "companies" });
    const rows = await t.run(async (ctx) => ({
      identities: await ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) => q.eq("ownerAccountId", OWNER_ACCOUNT_ID))
        .collect(),
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_company", (q) => q.eq("ownerAccountId", OWNER_ACCOUNT_ID))
        .collect(),
      aliases: await ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_company", (q) => q.eq("ownerAccountId", OWNER_ACCOUNT_ID))
        .collect(),
    }));
    expect(rows).toEqual({ identities: [], evidence: [], aliases: [] });
  });

  test("turns deletions into tombstones and requests downstream recomputation once", async () => {
    const t = convexTest(schema, modules);
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);
    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    const deleted = post({
      contentState: "deleted",
      storageState: "tombstone",
      text: undefined,
      observedAt: NOW + DAY_MS,
    });
    await finalize(t, secondClaim, {
      xIngestion: xIngestion(secondClaim, { posts: [deleted], complianceEventCount: 1 }),
    });
    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234567"),
        )
        .unique(),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      normalizedEvidence: await ctx.db
        .query("companyMonitoringEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
      candidate: await ctx.db
        .query("companyMonitoringCandidates")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(state.evidence).toMatchObject({
      contentState: "deleted",
      storageState: "tombstone",
    });
    expect(state.evidence?.text).toBeUndefined();
    expect(state.company).toMatchObject({
      evidenceRevision: 1,
      recomputeRequiredAt: NOW + DAY_MS,
    });
    expect(state.normalizedEvidence).toMatchObject({ state: "deleted" });
    expect(state.candidate).toMatchObject({
      state: "terminal",
      terminalReason: "evidence_deleted",
      observationBlocking: false,
      referenceCount: 0,
    });

    vi.setSystemTime(NOW + 2 * DAY_MS);
    const replayClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    await finalize(t, replayClaim, {
      xIngestion: xIngestion(replayClaim, {
        posts: [post({
          contentState: "deleted",
          storageState: "tombstone",
          text: undefined,
          observedAt: NOW + 2 * DAY_MS,
        })],
        complianceEventCount: 1,
      }),
    });
    const replayedCompany = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringCompanies")
      .withIndex("by_account_companyId", (q) =>
        q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
      )
      .unique());
    expect(replayedCompany).toMatchObject({
      evidenceRevision: 1,
      recomputeRequiredAt: NOW + DAY_MS,
    });

    vi.setSystemTime(NOW + 3 * DAY_MS);
    const recoveryClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    expect(recoveryClaim.work.subjects[0].trackedPosts).toEqual(
      expect.arrayContaining([expect.objectContaining({
        postId: "1912345678901234567",
        contentState: "deleted",
      })]),
    );
    await finalize(t, recoveryClaim, {
      xIngestion: xIngestion(recoveryClaim, {
        posts: [post({ observedAt: NOW + 3 * DAY_MS })],
        complianceEventCount: 1,
      }),
    });
    const recovered = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234567"),
        )
        .unique(),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(recovered.evidence).toMatchObject({
      contentState: "active",
      storageState: "full_text",
      text: "Official Stripe update",
      evidenceRevision: 2,
    });
    expect(recovered.company).toMatchObject({
      evidenceRevision: 2,
      recomputeRequiredAt: NOW + 3 * DAY_MS,
    });
  });

  test("keeps one canonical evidence row across edit-history deletion", async () => {
    const t = convexTest(schema, modules);
    const originalPostId = "1912345678901234567";
    const editedPostId = "1912345678901234569";
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim);

    vi.setSystemTime(NOW + DAY_MS);
    const editClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    await finalize(t, editClaim, {
      xIngestion: xIngestion(editClaim, {
        posts: [post({
          postId: editedPostId,
          contentState: "edited",
          text: "Edited official Stripe update",
          editHistoryPostIds: [originalPostId, editedPostId],
          observedAt: NOW + DAY_MS,
        })],
      }),
    });

    vi.setSystemTime(NOW + 2 * DAY_MS);
    const deleteClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    await finalize(t, deleteClaim, {
      xIngestion: xIngestion(deleteClaim, {
        posts: [post({
          postId: editedPostId,
          contentState: "deleted",
          storageState: "tombstone",
          text: undefined,
          editHistoryPostIds: [editedPostId],
          observedAt: NOW + 2 * DAY_MS,
        })],
        complianceEventCount: 1,
      }),
    });

    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect(),
      aliases: await ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect(),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(state.evidence).toHaveLength(1);
    expect(state.evidence[0]).toMatchObject({
      postId: originalPostId,
      contentState: "deleted",
      storageState: "tombstone",
      editHistoryPostIds: [originalPostId, editedPostId],
    });
    expect(state.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ postId: originalPostId, canonicalPostId: originalPostId }),
      expect.objectContaining({ postId: editedPostId, canonicalPostId: originalPostId }),
    ]));
    expect(state.company).toMatchObject({
      evidenceRevision: 1,
      recomputeRequiredAt: NOW + 2 * DAY_MS,
    });
  });

  test("keeps an edit-family tombstone when a later sibling is active in the same payload", async () => {
    const t = convexTest(schema, modules);
    const originalPostId = "1912345678901234567";
    const editedPostId = "1912345678901234569";
    const claim = await seedXWork(t);
    await finalize(t, claim, {
      itemCount: 2,
      xIngestion: xIngestion(claim, {
        posts: [
          post({
            contentState: "deleted",
            storageState: "tombstone",
            text: undefined,
            editHistoryPostIds: [originalPostId],
          }),
          post({
            postId: editedPostId,
            contentState: "edited",
            text: "A later active sibling must not resurrect deleted evidence",
            editHistoryPostIds: [originalPostId, editedPostId],
          }),
        ],
        complianceEventCount: 1,
      }),
    });

    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect(),
      aliases: await ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .collect(),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("companyId", COMPANY_A),
        )
        .unique(),
    }));
    expect(state.evidence).toHaveLength(1);
    expect(state.evidence[0]).toMatchObject({
      postId: originalPostId,
      contentState: "deleted",
      storageState: "tombstone",
      editHistoryPostIds: [originalPostId, editedPostId],
    });
    expect(state.evidence[0]?.text).toBeUndefined();
    expect(state.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ postId: originalPostId, canonicalPostId: originalPostId }),
      expect.objectContaining({ postId: editedPostId, canonicalPostId: originalPostId }),
    ]));
    expect(state.company).toMatchObject({ evidenceRevision: 1 });
  });

  test("does not overwrite a conflicting historical edit alias", async () => {
    const t = convexTest(schema, modules);
    const originalPostId = "1912345678901234567";
    const historicalPostId = "1912345678901234569";
    const firstClaim = await seedXWork(t);
    await finalize(t, firstClaim, {
      xIngestion: xIngestion(firstClaim, {
        posts: [post({ editHistoryPostIds: [originalPostId, historicalPostId] })],
      }),
    });
    await t.run(async (ctx) => {
      const historicalAlias = await ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", historicalPostId),
        )
        .unique();
      await ctx.db.patch(historicalAlias!._id, { companyId: COMPANY_B });
    });

    vi.setSystemTime(NOW + DAY_MS);
    const secondClaim = await t.mutation(ORCHESTRATION.claimNextWorkForTest, {
      workerId: "x-worker",
    });
    await finalize(t, secondClaim, {
      xIngestion: xIngestion(secondClaim, {
        posts: [post({
          text: "Must not overwrite the poisoned historical alias",
          observedAt: NOW + DAY_MS,
        })],
      }),
    });

    const state = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", originalPostId),
        )
        .unique(),
      historicalAlias: await ctx.db
        .query("companyMonitoringXPostAliases")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", historicalPostId),
        )
        .unique(),
    }));
    expect(state.evidence).toMatchObject({
      text: "Official Stripe update",
      observedAt: NOW,
    });
    expect(state.historicalAlias).toMatchObject({ companyId: COMPANY_B });
  });

  test("does not cross-bind one immutable account ID across a corporate family", async () => {
    const t = convexTest(schema, modules);
    const claim = await seedXWork(t, { companies: 2 });
    const secondPost = post({
      companyId: COMPANY_B,
      postId: "1912345678901234568",
      currentHandle: "stripepayments",
    });
    await finalize(t, claim, {
      itemCount: 2,
      xIngestion: xIngestion(claim, {
        checkpoints: [
          { companyId: COMPANY_A, checkpointAfter: "x-checkpoint-1" },
          { companyId: COMPANY_B, checkpointAfter: "x-checkpoint-1" },
        ],
        packing: [{
          packId: "d".repeat(64),
          query: "(from:stripe OR from:stripepayments) -is:retweet",
          companyIds: [COMPANY_A, COMPANY_B],
          accountIds: [ACCOUNT_ID, ACCOUNT_ID],
          handles: ["stripe", "stripepayments"],
        }],
        identities: [identity(COMPANY_A), identity(COMPANY_B)],
        posts: [post(), secondPost],
      }),
    });
    const state = await t.run(async (ctx) => ({
      identities: await ctx.db
        .query("companyMonitoringXIdentities")
        .withIndex("by_account_company", (q) => q.eq("ownerAccountId", OWNER_ACCOUNT_ID))
        .collect(),
      secondEvidence: await ctx.db
        .query("companyMonitoringXEvidence")
        .withIndex("by_account_postId", (q) =>
          q.eq("ownerAccountId", OWNER_ACCOUNT_ID).eq("postId", "1912345678901234568"),
        )
        .unique(),
    }));
    expect(state.identities).toHaveLength(2);
    expect(state.identities.find((row) => row.companyId === COMPANY_A)).toMatchObject({
      state: "authoritative",
    });
    expect(state.identities.find((row) => row.companyId === COMPANY_B)).toMatchObject({
      state: "demoted",
      demotionReason: "family_conflict",
      allowedUses: [],
    });
    expect(state.secondEvidence).toBeNull();
  });
});
