/**
 * Individual Pro → API Starter in place, through its own action and relay
 * (switchToApiStarter, /relay/api-starter-switch), on the shared plan-change
 * runner. API Starter includes the Pro dashboard for one user, so a Pro holder
 * who wants the API moves the existing subscription instead of buying a second
 * one. The cadence is kept and no promotion code ever rides on the change.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { selectPlanChangeCandidate } from "../payments/billing";
import schema from "../schema";
import { ACTIVE_PROMO } from "../../shared/promo-campaign";

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
const USER = { subject: "user_api_switch", tokenIdentifier: "clerk|user_api_switch" };
// Inside the running promotion when there is one, so a code would show up if it leaked.
const NOW = ACTIVE_PROMO ? ACTIVE_PROMO.endsAtMs - 60 * 60 * 1000 : new Date("2026-11-27T10:00:00Z").getTime();
const DAY_MS = 86_400_000;
const product = (planKey: string) => PRODUCT_CATALOG[planKey]!.dodoProductId!;

type Row = Parameters<typeof selectPlanChangeCandidate>[1][number];
function row(overrides: Partial<Row>): Row {
  return {
    planKey: "pro_monthly",
    status: "active",
    currentPeriodEnd: NOW + 20 * DAY_MS,
    dodoSubscriptionId: "sub_pro_1",
    dodoProductId: product("pro_monthly"),
    rawPayload: {},
    ...overrides,
  };
}
const select = (subs: Row[]) => selectPlanChangeCandidate("api_starter", subs, NOW);

/** Shape of the read-only live preview on 2026-11-27 (Pro Monthly → API Starter). */
function starterPreview(total = 6012, currency = "USD") {
  return {
    immediate_charge: { summary: { total_amount: total, currency } },
    new_plan: { recurring_pre_tax_amount: 9999, currency: "USD", next_billing_date: "2026-12-27T10:00:00Z" },
  };
}

describe("selectPlanChangeCandidate for api_starter", () => {
  test("keeps the cadence: monthly Pro goes to API Starter, yearly Pro to API Starter Annual", () => {
    const cases: Array<[string, string]> = [
      ["pro_monthly", "api_starter"],
      ["pro_monthly_mcp", "api_starter"],
      ["pro_annual", "api_starter_annual"],
    ];
    for (const [from, to] of cases) {
      expect(select([row({ planKey: from, dodoProductId: product(from) })])).toEqual({
        ok: true,
        dodoSubscriptionId: "sub_pro_1",
        fromPlanKey: from,
        toPlanKey: to,
        fromProductId: product(from),
        toProductId: product(to),
      });
    }
  });

  test("an account that already covers any API plan is refused, so it cancels Pro instead", () => {
    for (const apiPlan of ["api_starter", "api_starter_annual", "api_business", "api_business_annual", "enterprise"]) {
      const result = select([
        row({}),
        row({ planKey: apiPlan, dodoSubscriptionId: "sub_api_1", dodoProductId: product(apiPlan) }),
      ]);
      expect(result, apiPlan).toEqual({ ok: false, reason: "ALREADY_API_PLAN" });
    }
  });

  test("a Pro Business subscription is not a source, alone or beside a Pro one", () => {
    for (const subs of [
      [row({ planKey: "pro_business_monthly", dodoProductId: product("pro_business_monthly") })],
      [row({ planKey: "pro_business_annual", dodoProductId: product("pro_business_annual") })],
      [row({}), row({ planKey: "pro_business_monthly", dodoSubscriptionId: "sub_pb_1", dodoProductId: product("pro_business_monthly") })],
    ]) {
      expect(select(subs)).toEqual({ ok: false, reason: "NO_UPGRADEABLE_PRO" });
    }
  });

  test("only an active Pro without a scheduled cancellation qualifies", () => {
    expect(select([row({ rawPayload: { cancel_at_next_billing_date: true } })]))
      .toEqual({ ok: false, reason: "PRO_CANCEL_SCHEDULED" });
    for (const subs of [
      [],
      [row({ status: "on_hold" })],
      [row({ status: "cancelled" })],
      [row({ status: "expired" })],
      [row({ status: "cancelled", currentPeriodEnd: NOW + DAY_MS }), row({ status: "on_hold", dodoSubscriptionId: "sub_pro_2" })],
    ]) {
      expect(select(subs)).toEqual({ ok: false, reason: "NO_UPGRADEABLE_PRO" });
    }
  });

  test("leaves the Pro Business and Pro Yearly selections unchanged", () => {
    expect(selectPlanChangeCandidate("pro_business", [row({})], NOW)).toMatchObject({ ok: true, toPlanKey: "pro_business_monthly" });
    expect(selectPlanChangeCandidate("pro_annual", [row({})], NOW)).toMatchObject({ ok: true, toPlanKey: "pro_annual" });
    expect(selectPlanChangeCandidate("pro_annual", [row({ planKey: "pro_monthly_mcp" })], NOW))
      .toEqual({ ok: false, reason: "NO_UPGRADEABLE_PRO" });
  });
});

describe("switch action", () => {
  beforeEach(() => {
    vi.stubEnv("DODO_API_KEY", "test-key");
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    previewChangePlan.mockReset();
    changePlan.mockReset();
    retrieve.mockReset();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function setup(overrides: Partial<Row> = {}) {
    const t = convexTest(schema, modules);
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
    return t;
  }

  const run = (
    t: ReturnType<typeof convexTest>,
    args: { confirm: boolean; acceptedChargeAmount?: number; acceptedChargeCurrency?: string },
  ) => t.withIdentity(USER).action(api.payments.billing.switchToApiStarter, args);
  const relayPost = (t: ReturnType<typeof convexTest>, path: string, body: unknown) => t.fetch(path, {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const claims = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("proBusinessUpgradeClaims").collect());
  const accepted = { confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: "USD" };

  test("a preview quotes the prorated charge and the API Starter renewal, with no code", async () => {
    const t = await setup();
    previewChangePlan.mockResolvedValue(starterPreview());
    expect(await run(t, { confirm: false })).toEqual({
      kind: "preview",
      fromPlanKey: "pro_monthly",
      toPlanKey: "api_starter",
      chargeAmount: 6012,
      currency: "USD",
      renewalAmount: 9999,
      renewalCurrency: "USD",
      renewalDate: "2026-12-27T10:00:00Z",
      billingPeriod: "monthly",
      discounted: false,
      percentOff: null,
      acceptsQuoteGuards: true,
    });
    const [subscriptionId, params] = previewChangePlan.mock.calls[0]!;
    expect(subscriptionId).toBe("sub_pro_1");
    expect(params).toEqual({
      product_id: product("api_starter"),
      quantity: 1,
      proration_billing_mode: "prorated_immediately",
      effective_at: "immediately",
      on_payment_failure: "prevent_change",
    });
    expect(changePlan).not.toHaveBeenCalled();
  });

  test("a yearly Pro is quoted for API Starter Annual", async () => {
    const t = await setup({ planKey: "pro_annual", dodoProductId: product("pro_annual") });
    previewChangePlan.mockResolvedValue({
      immediate_charge: { summary: { total_amount: 70000, currency: "USD" } },
      new_plan: { recurring_pre_tax_amount: 89999, currency: "USD", next_billing_date: "2027-11-27T10:00:00Z" },
    });
    expect(await run(t, { confirm: false })).toMatchObject({
      fromPlanKey: "pro_annual",
      toPlanKey: "api_starter_annual",
      renewalAmount: 89999,
      billingPeriod: "annual",
    });
    expect(previewChangePlan.mock.calls[0]![1]).toMatchObject({ product_id: product("api_starter_annual") });
  });

  test("a confirm must name the charge it accepted, and is refused before Dodo without it", async () => {
    const t = await setup();
    await expect(run(t, { confirm: true })).rejects.toThrow(/PLAN_CHANGE_QUOTE_REQUIRED/);
    expect(retrieve).not.toHaveBeenCalled();
    expect(changePlan).not.toHaveBeenCalled();
    expect(await claims(t)).toEqual([]);
  });

  test("a confirm re-checks the charge with the exact changePlan body, then moves the subscription", async () => {
    const t = await setup();
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    retrieve.mockResolvedValue({ product_id: product("pro_monthly") });
    previewChangePlan.mockResolvedValue(starterPreview(6012 + 3));
    changePlan.mockResolvedValue(undefined);
    expect(await run(t, accepted)).toEqual({ kind: "upgraded", fromPlanKey: "pro_monthly", toPlanKey: "api_starter" });
    expect(changePlan).toHaveBeenCalledTimes(1);
    expect(previewChangePlan.mock.calls[0]!.slice(0, 2)).toEqual(changePlan.mock.calls[0]);
    expect(changePlan.mock.calls[0]![1]).not.toHaveProperty("discount_code");
    const events = logs.mock.calls.map(([line]) => { try { return JSON.parse(String(line)).event; } catch { return null; } });
    expect(events).toContain("api_starter_switch_applied");
  });

  test("a higher charge than the one accepted is refused before changePlan", async () => {
    const t = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    retrieve.mockResolvedValue({ product_id: product("pro_monthly") });
    previewChangePlan.mockResolvedValue(starterPreview(6012 + 6));
    await expect(run(t, accepted)).rejects.toThrow(/CHARGE_CHANGED/);
    expect(changePlan).not.toHaveBeenCalled();
    expect(await claims(t)).toEqual([]);
  });

  test("a cancellation Dodo already holds is refused before changePlan", async () => {
    const t = await setup();
    retrieve.mockResolvedValue({ product_id: product("pro_monthly"), cancel_at_next_billing_date: true });
    previewChangePlan.mockResolvedValue(starterPreview());
    await expect(run(t, accepted)).rejects.toThrow(/PRO_CANCEL_SCHEDULED/);
    expect(changePlan).not.toHaveBeenCalled();
  });

  test("an account that holds an API plan, or none that qualifies, is refused before Dodo", async () => {
    const t = await setup();
    await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId: USER.subject,
      dodoSubscriptionId: "sub_api_1",
      dodoProductId: product("api_starter"),
      planKey: "api_starter",
      status: "active",
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: NOW + 20 * DAY_MS,
      rawPayload: {},
      updatedAt: NOW,
    }));
    await expect(run(t, { confirm: false })).rejects.toThrow(/ALREADY_API_PLAN/);
    const none = convexTest(schema, modules);
    await expect(run(none, { confirm: false })).rejects.toThrow(/NO_UPGRADEABLE_PRO/);
    expect(previewChangePlan).not.toHaveBeenCalled();
  });

  test("an account whose deletion has started is refused before Dodo", async () => {
    const t = await setup();
    await t.run((ctx) => ctx.db.insert("accountDeletions", {
      userId: USER.subject, userIdHash: "hash_api_switch", source: "self",
      status: "pending", step: "grants", dodoSubscriptionIds: [], cancelledDodoSubscriptionIds: [],
      startedAt: NOW - 2, updatedAt: NOW - 1,
    }));
    await expect(run(t, { confirm: false })).rejects.toThrow(/ACCOUNT_DELETION_IN_PROGRESS/);
    expect(previewChangePlan).not.toHaveBeenCalled();
  });

  test("the relay validates the body, forwards it, and maps the new refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await setup();
    for (const bad of [
      { userId: USER.subject },
      { userId: "", confirm: false },
      { userId: USER.subject, confirm: true },
      { userId: USER.subject, confirm: true, acceptedChargeAmount: 6012 },
      { userId: USER.subject, confirm: true, acceptedChargeAmount: -1, acceptedChargeCurrency: "USD" },
      { userId: USER.subject, confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: "usd" },
      { userId: USER.subject, confirm: false, kind: "pro_annual" },
    ]) {
      expect((await relayPost(t, "/relay/api-starter-switch", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(previewChangePlan).not.toHaveBeenCalled();

    previewChangePlan.mockResolvedValue(starterPreview());
    const quoted = await relayPost(t, "/relay/api-starter-switch", { userId: USER.subject, confirm: false });
    expect(quoted.status).toBe(200);
    expect(await quoted.json()).toMatchObject({ kind: "preview", toPlanKey: "api_starter", acceptsQuoteGuards: true });

    await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId: USER.subject,
      dodoSubscriptionId: "sub_api_1",
      dodoProductId: product("api_business"),
      planKey: "api_business",
      status: "active",
      currentPeriodStart: NOW - DAY_MS,
      currentPeriodEnd: NOW + 20 * DAY_MS,
      rawPayload: {},
      updatedAt: NOW,
    }));
    const refused = await relayPost(t, "/relay/api-starter-switch", { userId: USER.subject, confirm: false });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "ALREADY_API_PLAN" });
  });

  // Each plan change keeps its own entry points, so a request for this switch
  // can never run as the Pro Business upgrade or the Pro Yearly switch.
  describe("the other plan changes refuse an API Starter request before Dodo", () => {
    test("the Pro Business and Pro Yearly relays answer INVALID_KIND", async () => {
      const t = await setup();
      for (const path of ["/relay/pro-business-upgrade", "/relay/pro-annual-switch"]) {
        for (const body of [
          { userId: USER.subject, confirm: false, kind: "api_starter" },
          { userId: USER.subject, confirm: true, kind: "api_starter", discounted: false },
        ]) {
          const res = await relayPost(t, path, body);
          expect(res.status, path).toBe(400);
          expect(await res.json()).toEqual({ error: "INVALID_KIND" });
        }
      }
      expect(previewChangePlan).not.toHaveBeenCalled();
      expect(changePlan).not.toHaveBeenCalled();
    });

    test("the Pro Business and Pro Yearly actions reject the argument", async () => {
      const t = await setup();
      for (const args of [
        { confirm: false, kind: "api_starter" },
        { confirm: true, kind: "api_starter", discounted: false },
      ]) {
        await expect(t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, args as never)).rejects.toThrow();
        await expect(t.withIdentity(USER).action(api.payments.billing.switchToProAnnual, args as never)).rejects.toThrow();
      }
      expect(previewChangePlan).not.toHaveBeenCalled();
      expect(changePlan).not.toHaveBeenCalled();
      expect(await claims(t)).toEqual([]);
    });

    test("the API Starter action rejects another kind", async () => {
      const t = await setup();
      await expect(
        t.withIdentity(USER).action(api.payments.billing.switchToApiStarter, { confirm: false, kind: "pro_business" } as never),
      ).rejects.toThrow();
      expect(previewChangePlan).not.toHaveBeenCalled();
    });
  });
});
