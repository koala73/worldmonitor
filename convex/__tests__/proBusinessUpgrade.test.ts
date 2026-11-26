import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { PRO_BUSINESS_UPGRADE_CLAIM_TTL_MS, selectProBusinessUpgradeCandidate } from "../payments/billing";
import schema from "../schema";

const { previewChangePlan, changePlan, retrieve } = vi.hoisted(() => ({
  previewChangePlan: vi.fn(),
  changePlan: vi.fn(),
  retrieve: vi.fn(),
}));
vi.mock("dodopayments", async (importOriginal) => ({
  ...await importOriginal<typeof import("dodopayments")>(),
  DodoPayments: class {
    subscriptions = { previewChangePlan, changePlan, retrieve };
  },
}));

const modules = import.meta.glob("../**/*.ts");
const USER = { subject: "user_pro_upgrade", tokenIdentifier: "clerk|user_pro_upgrade" };
const NOW = Date.now();
const DAY_MS = 86_400_000;
const PRO_MONTHLY = PRODUCT_CATALOG.pro_monthly!.dodoProductId;
const PRO_BUSINESS_MONTHLY = PRODUCT_CATALOG.pro_business_monthly!.dodoProductId;

type Row = Parameters<typeof selectProBusinessUpgradeCandidate>[0][number];
function row(overrides: Partial<Row>): Row {
  return {
    planKey: "pro_monthly",
    status: "active",
    currentPeriodEnd: NOW + 20 * DAY_MS,
    dodoSubscriptionId: "sub_pro_1",
    dodoProductId: PRO_MONTHLY,
    rawPayload: {},
    ...overrides,
  };
}

describe("selectProBusinessUpgradeCandidate", () => {
  test("maps an active monthly Pro to Pro Business monthly", () => {
    expect(selectProBusinessUpgradeCandidate([row({})], NOW)).toEqual({
      ok: true,
      dodoSubscriptionId: "sub_pro_1",
      fromPlanKey: "pro_monthly",
      toPlanKey: "pro_business_monthly",
      fromProductId: PRO_MONTHLY,
      toProductId: PRO_BUSINESS_MONTHLY,
    });
  });

  test("keeps the annual billing period", () => {
    const result = selectProBusinessUpgradeCandidate(
      [row({ planKey: "pro_annual", dodoProductId: PRODUCT_CATALOG.pro_annual!.dodoProductId })],
      NOW,
    );
    expect(result).toMatchObject({ ok: true, toPlanKey: "pro_business_annual" });
  });

  test("refuses when Pro Business is already covering", () => {
    const result = selectProBusinessUpgradeCandidate(
      [row({}), row({ planKey: "pro_business_monthly", dodoSubscriptionId: "sub_pb" })],
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "ALREADY_PRO_BUSINESS" });
  });

  test("refuses a Pro whose cancellation is scheduled", () => {
    const result = selectProBusinessUpgradeCandidate(
      [row({ rawPayload: { cancel_at_next_billing_date: true } })],
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "PRO_CANCEL_SCHEDULED" });
  });

  test("refuses cancelled, on_hold and API-only subscriptions", () => {
    for (const sub of [
      row({ status: "cancelled" }),
      row({ status: "on_hold" }),
      row({ planKey: "api_starter" }),
    ]) {
      expect(selectProBusinessUpgradeCandidate([sub], NOW)).toEqual({ ok: false, reason: "NO_UPGRADEABLE_PRO" });
    }
  });
});

describe("upgradeToProBusiness action", () => {
  beforeEach(() => {
    vi.stubEnv("DODO_API_KEY", "test-key");
  });
  afterEach(() => {
    previewChangePlan.mockReset();
    changePlan.mockReset();
    retrieve.mockReset();
    vi.unstubAllEnvs();
  });

  async function seed(t: ReturnType<typeof convexTest>, overrides: Partial<Row> = {}) {
    const r = row(overrides);
    await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId: USER.subject,
      dodoSubscriptionId: r.dodoSubscriptionId,
      dodoProductId: r.dodoProductId,
      planKey: r.planKey,
      status: r.status,
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: r.currentPeriodEnd,
      rawPayload: r.rawPayload ?? {},
      updatedAt: NOW,
    }));
  }

  test("preview returns the prorated charge without changing the plan", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    previewChangePlan.mockResolvedValue({
      immediate_charge: { summary: { total_amount: 667, currency: "USD" } },
      new_plan: { recurring_pre_tax_amount: 4999, currency: "USD", next_billing_date: "2026-12-07T11:03:06Z" },
    });
    const result = await t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: false });
    expect(result).toEqual({
      kind: "preview",
      fromPlanKey: "pro_monthly",
      toPlanKey: "pro_business_monthly",
      chargeAmount: 667,
      currency: "USD",
      renewalAmount: 4999,
      renewalCurrency: "USD",
      renewalDate: "2026-12-07T11:03:06Z",
      billingPeriod: "monthly",
    });
    expect(previewChangePlan).toHaveBeenCalledWith("sub_pro_1", expect.objectContaining({
      product_id: PRO_BUSINESS_MONTHLY,
      quantity: 1,
      proration_billing_mode: "prorated_immediately",
      on_payment_failure: "prevent_change",
    }));
    expect(changePlan).not.toHaveBeenCalled();
  });

  test("confirm applies the change on the existing subscription", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    changePlan.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true });
    expect(result).toEqual({ kind: "upgraded", fromPlanKey: "pro_monthly", toPlanKey: "pro_business_monthly" });
    expect(changePlan).toHaveBeenCalledWith("sub_pro_1", expect.objectContaining({ product_id: PRO_BUSINESS_MONTHLY }));
  });

  test("confirm skips a second change once the provider row is on the target", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    retrieve.mockResolvedValue({ product_id: PRO_BUSINESS_MONTHLY });
    const result = await t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true });
    expect(result).toMatchObject({ kind: "upgraded" });
    expect(changePlan).not.toHaveBeenCalled();
  });

  test("confirm refuses when the provider row moved off the quoted Pro product", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    vi.spyOn(console, "error").mockImplementation(() => {});
    retrieve.mockResolvedValue({ product_id: PRODUCT_CATALOG.api_starter!.dodoProductId });
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true }),
    ).rejects.toThrow(/DODO_PLAN_CHANGE_ERROR/);
    expect(changePlan).not.toHaveBeenCalled();
  });

  test("a concurrent confirm is refused while the first holds the claim", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    vi.spyOn(console, "log").mockImplementation(() => {});
    let releaseRetrieve: () => void = () => {};
    retrieve.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRetrieve = () => resolve({ product_id: PRO_MONTHLY });
    }));
    changePlan.mockResolvedValue(undefined);
    const first = t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true });
    await vi.waitFor(() => expect(retrieve).toHaveBeenCalledTimes(1));
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true }),
    ).rejects.toThrow(/UPGRADE_IN_PROGRESS/);
    releaseRetrieve();
    await expect(first).resolves.toMatchObject({ kind: "upgraded" });
    expect(changePlan).toHaveBeenCalledTimes(1);
  });

  test("a failed change releases the claim so the user can retry", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    changePlan
      .mockRejectedValueOnce(Object.assign(new Error("card declined"), { status: 402 }))
      .mockResolvedValueOnce(undefined);
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true }),
    ).rejects.toThrow(/DODO_PLAN_CHANGE_ERROR/);
    expect(await t.run((ctx) => ctx.db.query("proBusinessUpgradeClaims").collect())).toHaveLength(0);
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true }),
    ).resolves.toMatchObject({ kind: "upgraded" });
    expect(changePlan).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["a dropped connection", () => new Error("socket hang up")],
    ["a provider 5xx", () => Object.assign(new Error("upstream error"), { status: 502 })],
  ])("an ambiguous change failure (%s) keeps the claim until the TTL", async (_label, makeError) => {
    const t = convexTest(schema, modules);
    await seed(t);
    vi.spyOn(console, "error").mockImplementation(() => {});
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    changePlan.mockRejectedValueOnce(makeError());
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true }),
    ).rejects.toThrow(/DODO_PLAN_CHANGE_ERROR/);
    expect(await t.run((ctx) => ctx.db.query("proBusinessUpgradeClaims").collect())).toHaveLength(1);
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true }),
    ).rejects.toThrow(/UPGRADE_IN_PROGRESS/);
    expect(changePlan).toHaveBeenCalledTimes(1);
  });

  test("admission refuses an account whose deletion has started", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("accountDeletions", {
      userId: USER.subject, userIdHash: "hash_pro_upgrade", source: "self",
      status: "pending", step: "grants", dodoSubscriptionIds: [], cancelledDodoSubscriptionIds: [],
      startedAt: NOW - 2, updatedAt: NOW - 1,
    }));
    await expect(
      t.mutation(internal.payments.billing.admitProBusinessUpgrade, { userId: USER.subject, now: NOW }),
    ).rejects.toThrow(/ACCOUNT_DELETION_IN_PROGRESS/);
    expect(await t.run((ctx) => ctx.db.query("proBusinessUpgradeAdmissions").collect())).toHaveLength(0);
  });

  test("a claim older than the TTL can be taken again", async () => {
    const t = convexTest(schema, modules);
    const claim = (now: number) => t.mutation(internal.payments.billing.claimProBusinessUpgrade, {
      dodoSubscriptionId: "sub_pro_1",
      now,
    });
    expect(await claim(NOW)).toBe(true);
    expect(await claim(NOW + 1_000)).toBe(false);
    expect(await claim(NOW + PRO_BUSINESS_UPGRADE_CLAIM_TTL_MS)).toBe(true);
  });

  test("an account past the admission window limit is refused before Dodo", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run((ctx) => ctx.db.insert("proBusinessUpgradeAdmissions", {
      userId: USER.subject,
      windowStart: Date.now(),
      count: 10,
    }));
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: false }),
    ).rejects.toThrow(/UPGRADE_RATE_LIMITED/);
    expect(previewChangePlan).not.toHaveBeenCalled();
  });

  test("provider failures surface as a structured error", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    vi.spyOn(console, "error").mockImplementation(() => {});
    previewChangePlan.mockRejectedValue(new Error("provider down"));
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: false }),
    ).rejects.toThrow(/DODO_PLAN_CHANGE_ERROR/);
  });

  test("relay maps refusals to 409 for the /pro edge route", async () => {
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
    const t = convexTest(schema, modules);
    const response = await t.fetch("/relay/pro-business-upgrade", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER.subject, confirm: false }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "NO_UPGRADEABLE_PRO" });
  });
});
