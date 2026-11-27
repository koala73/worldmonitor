/**
 * Pro Monthly → Pro Yearly in place, through its own action and relay
 * (switchToProAnnual, /relay/pro-annual-switch), which share the Pro Business
 * upgrade runner. The running promotion's code rides on the change while it
 * lasts; the switch itself stays available afterwards at list price.
 *
 * The clock is pinned on both sides of the promotion's end so these cases keep
 * their meaning after the real offer ends.
 */
import { convexTest } from "convex-test";
import { APIError } from "dodopayments";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { PLAN_CHANGE_CONFIRM_WORST_CASE_MS, selectPlanChangeCandidate } from "../payments/billing";
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
const USER = { subject: "user_pro_switch", tokenIdentifier: "clerk|user_pro_switch" };
const PROMO = ACTIVE_PROMO!;
const DURING = PROMO.endsAtMs - 60 * 60 * 1000;
const AFTER = PROMO.endsAtMs;
const DAY_MS = 86_400_000;
const PRO_MONTHLY = PRODUCT_CATALOG.pro_monthly!.dodoProductId!;
const PRO_ANNUAL = PRODUCT_CATALOG.pro_annual!.dodoProductId!;
const LIST_CENTS = PRODUCT_CATALOG.pro_annual!.priceCents!;

type Row = Parameters<typeof selectPlanChangeCandidate>[1][number];
function row(overrides: Partial<Row>, now = DURING): Row {
  return {
    planKey: "pro_monthly",
    status: "active",
    currentPeriodEnd: now + 20 * DAY_MS,
    dodoSubscriptionId: "sub_pm_1",
    dodoProductId: PRO_MONTHLY,
    rawPayload: {},
    ...overrides,
  };
}

// What previewChangePlan threw live (2026-11-26) for a code that does not
// exist, built the way the SDK builds it: NotFoundError, status 404.
function discountRejection(): Error {
  return APIError.generate(
    404,
    { code: "NOT_FOUND", message: "Discount code 'BLACKFRIDAY50' doesn't exist" },
    undefined,
    new Headers(),
  );
}

/** Shape of the live P2 preview: with the code, Dodo reports the discounted figure as the plan's recurring amount. */
function discountedPreview() {
  return {
    immediate_charge: { summary: { total_amount: 10496, currency: "USD" } },
    new_plan: { recurring_pre_tax_amount: 14400, currency: "USD", next_billing_date: "2027-11-26T10:00:00Z" },
  };
}

function listPreview() {
  return {
    immediate_charge: { summary: { total_amount: 32096, currency: "USD" } },
    new_plan: { recurring_pre_tax_amount: LIST_CENTS, currency: "USD", next_billing_date: "2027-11-26T10:00:00Z" },
  };
}

describe("selectPlanChangeCandidate for pro_annual", () => {
  test("maps an active Pro Monthly to Pro Yearly", () => {
    expect(selectPlanChangeCandidate("pro_annual", [row({})], DURING)).toEqual({
      ok: true,
      dodoSubscriptionId: "sub_pm_1",
      fromPlanKey: "pro_monthly",
      toPlanKey: "pro_annual",
      fromProductId: PRO_MONTHLY,
      toProductId: PRO_ANNUAL,
    });
  });

  test("refuses an account already on Pro Yearly", () => {
    const result = selectPlanChangeCandidate(
      "pro_annual",
      [row({ planKey: "pro_annual", dodoProductId: PRO_ANNUAL })],
      DURING,
    );
    expect(result).toEqual({ ok: false, reason: "ALREADY_PRO_ANNUAL" });
  });

  test("refuses a Pro Monthly whose cancellation is scheduled", () => {
    const result = selectPlanChangeCandidate(
      "pro_annual",
      [row({ rawPayload: { cancel_at_next_billing_date: true } })],
      DURING,
    );
    expect(result).toEqual({ ok: false, reason: "PRO_CANCEL_SCHEDULED" });
  });

  test("refuses on_hold, cancelled, Pro Business and API subscriptions", () => {
    for (const sub of [
      row({ status: "on_hold" }),
      row({ status: "cancelled" }),
      row({ planKey: "pro_business_monthly" }),
      row({ planKey: "api_starter" }),
    ]) {
      expect(selectPlanChangeCandidate("pro_annual", [sub], DURING)).toMatchObject({ ok: false });
    }
  });

  test("leaves the Pro Business selection unchanged", () => {
    expect(selectPlanChangeCandidate("pro_business", [row({})], DURING)).toMatchObject({
      ok: true,
      toPlanKey: "pro_business_monthly",
    });
  });
});

describe("switch action", () => {
  beforeEach(() => {
    vi.stubEnv("DODO_API_KEY", "test-key");
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    previewChangePlan.mockReset();
    changePlan.mockReset();
    retrieve.mockReset();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function setup(now: number, overrides: Partial<Row> = {}) {
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const r = row(overrides, now);
    await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId: USER.subject,
      dodoSubscriptionId: r.dodoSubscriptionId,
      dodoProductId: r.dodoProductId,
      planKey: r.planKey,
      status: r.status,
      currentPeriodStart: now - DAY_MS,
      currentPeriodEnd: r.currentPeriodEnd,
      rawPayload: r.rawPayload ?? {},
      updatedAt: now,
    }));
    return t;
  }

  const run = (
    t: ReturnType<typeof convexTest>,
    args: { confirm: boolean; discounted?: boolean; acceptedChargeAmount?: number; acceptedChargeCurrency?: string },
  ) => t.withIdentity(USER).action(api.payments.billing.switchToProAnnual, args);
  const claims = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("proBusinessUpgradeClaims").collect());
  const withTotal = (preview: ReturnType<typeof discountedPreview>, total: number, currency = "USD") => ({
    ...preview,
    immediate_charge: { summary: { total_amount: total, currency } },
  });

  test("a preview during the offer applies the code and quotes the list price as the renewal", async () => {
    const t = await setup(DURING);
    previewChangePlan.mockResolvedValue(discountedPreview());
    const result = await run(t, { confirm: false });
    expect(result).toEqual({
      kind: "preview",
      fromPlanKey: "pro_monthly",
      toPlanKey: "pro_annual",
      chargeAmount: 10496,
      currency: "USD",
      // Dodo's 14400 is the first year only; the renewal is the catalog price.
      renewalAmount: LIST_CENTS,
      renewalCurrency: "USD",
      renewalDate: "2027-11-26T10:00:00Z",
      billingPeriod: "annual",
      discounted: true,
      percentOff: PROMO.percentOff,
      acceptsQuoteGuards: true,
    });
    expect(previewChangePlan).toHaveBeenCalledWith("sub_pm_1", expect.objectContaining({
      product_id: PRO_ANNUAL,
      discount_code: PROMO.discountCode,
      proration_billing_mode: "prorated_immediately",
      effective_at: "immediately",
      on_payment_failure: "prevent_change",
    }), expect.objectContaining({ timeout: expect.any(Number) }));
    expect(changePlan).not.toHaveBeenCalled();
  });

  // The catalog renewal is claimed only when Dodo's discounted first period is
  // the promotion's price on that catalog figure; otherwise the copy says
  // "the Pro Yearly price" instead of naming a number Dodo may not charge.
  test("a discounted quote names the catalog renewal only when Dodo's first period matches the promotion", async () => {
    for (const recurring of [{ recurring_pre_tax_amount: 15000, currency: "USD" }, { recurring_pre_tax_amount: 14400, currency: "EUR" }]) {
      const t = await setup(DURING);
      previewChangePlan.mockReset().mockResolvedValue({
        ...discountedPreview(),
        new_plan: { ...discountedPreview().new_plan, ...recurring },
      });
      const result = await run(t, { confirm: false });
      expect(result).toMatchObject({ kind: "preview", discounted: true, renewalAmount: null, renewalCurrency: null });
    }
  });

  test("after the offer the switch still works at list price, without a code", async () => {
    const t = await setup(AFTER);
    previewChangePlan.mockResolvedValue(listPreview());
    const result = await run(t, { confirm: false });
    expect(result).toMatchObject({ kind: "preview", discounted: false, percentOff: null, renewalAmount: LIST_CENTS });
    expect(previewChangePlan.mock.calls[0]![1]).not.toHaveProperty("discount_code");
  });

  test("a preview whose code Dodo rejects falls back to a list-price quote marked not discounted", async () => {
    const t = await setup(DURING);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    previewChangePlan.mockRejectedValueOnce(discountRejection()).mockResolvedValueOnce(listPreview());
    const result = await run(t, { confirm: false });
    // The offer runs but this quote lost it: the client must say so.
    expect(result).toMatchObject({ kind: "preview", chargeAmount: 32096, discounted: false, percentOff: null, offerNotApplied: true });
    expect(previewChangePlan).toHaveBeenCalledTimes(2);
    expect(previewChangePlan.mock.calls[1]![1]).not.toHaveProperty("discount_code");
  });

  test("only a quote that lost a running offer says the offer was not applied", async () => {
    const during = await setup(DURING);
    previewChangePlan.mockResolvedValue(discountedPreview());
    expect(await run(during, { confirm: false })).not.toHaveProperty("offerNotApplied");
    const after = await setup(AFTER);
    previewChangePlan.mockReset().mockResolvedValue(listPreview());
    expect(await run(after, { confirm: false })).not.toHaveProperty("offerNotApplied");
  });

  // After a confirm's code is refused, the re-quote must not send the code
  // again: a preview that accepts it would bring back a quote the confirm
  // refuses, and the user could never switch.
  test("a list-price preview during the offer sends no code and says the offer was not applied", async () => {
    const t = await setup(DURING);
    previewChangePlan.mockResolvedValue(listPreview());
    const result = await t.withIdentity(USER).action(api.payments.billing.switchToProAnnual, {
      confirm: false, listPrice: true,
    });
    expect(result).toMatchObject({ kind: "preview", discounted: false, percentOff: null, offerNotApplied: true, chargeAmount: 32096 });
    expect(previewChangePlan).toHaveBeenCalledTimes(1);
    expect(previewChangePlan.mock.calls[0]![1]).not.toHaveProperty("discount_code");
  });

  test("the relay validates and forwards a list-price preview", async () => {
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
    const t = await setup(DURING);
    const post = (body: unknown) => t.fetch("/relay/pro-annual-switch", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await post({ userId: USER.subject, confirm: false, listPrice: "yes" })).status).toBe(400);
    previewChangePlan.mockResolvedValue(listPreview());
    const res = await post({ userId: USER.subject, confirm: false, listPrice: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ discounted: false, offerNotApplied: true });
    expect(previewChangePlan.mock.calls[0]![1]).not.toHaveProperty("discount_code");
  });

  // The /pro relay aborts at 23 s (api/_plan-change-relay.ts). Both preview
  // attempts share one 16 s budget inside it.
  test("both preview attempts share one deadline inside the relay's abort", async () => {
    const t = await setup(DURING);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    previewChangePlan
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 4_000);
        throw discountRejection();
      })
      .mockResolvedValueOnce(listPreview());
    await run(t, { confirm: false });
    const timeouts = previewChangePlan.mock.calls.map((call) => (call[2] as { timeout?: number } | undefined)?.timeout);
    expect(timeouts).toHaveLength(2);
    expect(timeouts.every((ms) => typeof ms === "number")).toBe(true);
    // The second attempt gets only what is left of the shared 16 s budget. Its
    // own 15 s cap alone would end it at 19 s, which this must catch.
    expect(timeouts[1]!).toBeLessThanOrEqual(16_000 - 4_000);
    expect(4_000 + timeouts[1]!).toBeLessThan(20_000);
  });

  test("a late rejection does not start a list-price preview that cannot finish in time", async () => {
    const t = await setup(DURING);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    previewChangePlan
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 14_900);
        throw discountRejection();
      })
      .mockResolvedValueOnce(listPreview());
    await expect(run(t, { confirm: false })).rejects.toThrow(/DODO_PLAN_CHANGE_ERROR/);
    expect(previewChangePlan).toHaveBeenCalledTimes(1);
  });

  test("a confirm of a discounted quote sends exactly the preview's parameters", async () => {
    const t = await setup(DURING);
    vi.spyOn(console, "log").mockImplementation(() => {});
    previewChangePlan.mockResolvedValue(discountedPreview());
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    changePlan.mockResolvedValue(undefined);
    await run(t, { confirm: false });
    const result = await run(t, { confirm: true, discounted: true });
    expect(result).toEqual({ kind: "upgraded", fromPlanKey: "pro_monthly", toPlanKey: "pro_annual" });
    expect(changePlan).toHaveBeenCalledTimes(1);
    // Same subscription and body; the preview also carries its share of the time budget.
    expect(changePlan.mock.calls[0]).toEqual(previewChangePlan.mock.calls[0]!.slice(0, 2));
  });

  test("a confirm of a list-price quote sends no code, even while the offer runs", async () => {
    const t = await setup(DURING);
    vi.spyOn(console, "log").mockImplementation(() => {});
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    changePlan.mockResolvedValue(undefined);
    await run(t, { confirm: true, discounted: false });
    expect(changePlan.mock.calls[0]![1]).not.toHaveProperty("discount_code");
  });

  test("a discounted quote confirmed after the offer ended is refused, never charged at list price", async () => {
    const t = await setup(AFTER);
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    await expect(run(t, { confirm: true, discounted: true })).rejects.toThrow(/PROMO_ENDED/);
    expect(changePlan).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("proBusinessUpgradeClaims").collect())).toHaveLength(0);
  });

  test("a confirm whose code Dodo rejects fails closed and is not retried at list price", async () => {
    const t = await setup(DURING);
    vi.spyOn(console, "error").mockImplementation(() => {});
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    changePlan.mockRejectedValueOnce(discountRejection());
    await expect(run(t, { confirm: true, discounted: true })).rejects.toThrow(/PROMO_CODE_REJECTED/);
    expect(changePlan).toHaveBeenCalledTimes(1);
    // A 4xx refusal changed nothing, so the user may re-preview and confirm at once.
    expect(await t.run((ctx) => ctx.db.query("proBusinessUpgradeClaims").collect())).toHaveLength(0);
  });

  test("a confirm without the quote's discount flag is refused before Dodo", async () => {
    const t = await setup(DURING);
    await expect(run(t, { confirm: true })).rejects.toThrow(/PLAN_CHANGE_QUOTE_REQUIRED/);
    expect(retrieve).not.toHaveBeenCalled();
    expect(changePlan).not.toHaveBeenCalled();
  });

  test("a confirm after an earlier one landed skips a second change", async () => {
    const t = await setup(DURING);
    retrieve.mockResolvedValue({ product_id: PRO_ANNUAL });
    await expect(run(t, { confirm: true, discounted: true })).resolves.toMatchObject({ kind: "upgraded" });
    expect(changePlan).not.toHaveBeenCalled();
  });

  test("a scheduled cancellation is refused with the existing reason", async () => {
    const t = await setup(DURING, { rawPayload: { cancel_at_next_billing_date: true } });
    await expect(run(t, { confirm: false })).rejects.toThrow(/PRO_CANCEL_SCHEDULED/);
    expect(previewChangePlan).not.toHaveBeenCalled();
  });

  // Cancelled in the portal after the quote, before the webhook reached Convex:
  // the cached row still qualifies, but Dodo already has the cancellation.
  test("a cancellation Dodo already holds is refused before changePlan, even when the charge re-check passes", async () => {
    const t = await setup(DURING);
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY, cancel_at_next_billing_date: true });
    previewChangePlan.mockResolvedValue(withTotal(discountedPreview(), 10496));
    await expect(run(t, {
      confirm: true, discounted: true, acceptedChargeAmount: 10496, acceptedChargeCurrency: "USD",
    })).rejects.toThrow(/PRO_CANCEL_SCHEDULED/);
    // A charge re-check that fails does not hide the cancellation behind a generic error.
    previewChangePlan.mockRejectedValue(new Error("synthetic re-check failure"));
    await expect(run(t, {
      confirm: true, discounted: true, acceptedChargeAmount: 10496, acceptedChargeCurrency: "USD",
    })).rejects.toThrow(/PRO_CANCEL_SCHEDULED/);
    await expect(
      t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: true }),
    ).rejects.toThrow(/PRO_CANCEL_SCHEDULED/);
    expect(changePlan).not.toHaveBeenCalled();
    expect(await claims(t)).toEqual([]);
  });

  test("the Pro Business upgrade never carries the promotion's code", async () => {
    const t = await setup(DURING);
    previewChangePlan.mockResolvedValue({
      immediate_charge: { summary: { total_amount: 667, currency: "USD" } },
      new_plan: { recurring_pre_tax_amount: 4999, currency: "USD", next_billing_date: "2026-12-26T10:00:00Z" },
    });
    const result = await t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: false });
    expect(result).toMatchObject({ toPlanKey: "pro_business_monthly", discounted: false, renewalAmount: 4999 });
    expect(previewChangePlan.mock.calls[0]![1]).not.toHaveProperty("discount_code");
  });

  // The quote's charge grows as the unused part of the month shrinks. A confirm
  // that names the charge it accepted re-checks it before changePlan.
  describe("accepted charge", () => {
    const accepted = { confirm: true, discounted: true, acceptedChargeAmount: 10496, acceptedChargeCurrency: "USD" };

    test("a higher charge than the one accepted is refused before changePlan, and the claim is released", async () => {
      const t = await setup(DURING);
      vi.spyOn(console, "error").mockImplementation(() => {});
      retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
      previewChangePlan.mockResolvedValue(withTotal(discountedPreview(), 10496 + 6));
      await expect(run(t, accepted)).rejects.toThrow(/CHARGE_CHANGED/);
      expect(changePlan).not.toHaveBeenCalled();
      expect(await claims(t)).toHaveLength(0);
    });

    test("a charge in another currency is refused before changePlan", async () => {
      const t = await setup(DURING);
      vi.spyOn(console, "error").mockImplementation(() => {});
      retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
      previewChangePlan.mockResolvedValue(withTotal(discountedPreview(), 10496, "EUR"));
      await expect(run(t, accepted)).rejects.toThrow(/CHARGE_CHANGED/);
      expect(changePlan).not.toHaveBeenCalled();
    });

    test("an equal, lower or within-tolerance charge proceeds, re-checked with the exact changePlan body", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      for (const total of [10496, 10300, 10496 + 5]) {
        const t = await setup(DURING);
        previewChangePlan.mockReset().mockResolvedValue(withTotal(discountedPreview(), total));
        retrieve.mockReset().mockResolvedValue({ product_id: PRO_MONTHLY });
        changePlan.mockReset().mockResolvedValue(undefined);
        await expect(run(t, accepted)).resolves.toMatchObject({ kind: "upgraded" });
        expect(changePlan).toHaveBeenCalledTimes(1);
        expect(previewChangePlan.mock.calls[0]!.slice(0, 2)).toEqual(changePlan.mock.calls[0]);
      }
    });

    test("a confirm that names no accepted charge does not re-preview (an older client)", async () => {
      const t = await setup(DURING);
      vi.spyOn(console, "log").mockImplementation(() => {});
      retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
      changePlan.mockResolvedValue(undefined);
      await expect(run(t, { confirm: true, discounted: true })).resolves.toMatchObject({ kind: "upgraded" });
      expect(previewChangePlan).not.toHaveBeenCalled();
      expect(changePlan).toHaveBeenCalledTimes(1);
    });

    test("a failed re-check fails closed before changePlan", async () => {
      const t = await setup(DURING);
      vi.spyOn(console, "error").mockImplementation(() => {});
      retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
      previewChangePlan.mockRejectedValue(APIError.generate(500, { message: "boom" }, undefined, new Headers()));
      await expect(run(t, accepted)).rejects.toThrow(/DODO_PLAN_CHANGE_ERROR/);
      expect(changePlan).not.toHaveBeenCalled();
      expect(await claims(t)).toHaveLength(0);
    });

    test("a subscription already on Pro Yearly reports success even when the re-check errors", async () => {
      const t = await setup(DURING);
      retrieve.mockResolvedValue({ product_id: PRO_ANNUAL });
      previewChangePlan.mockRejectedValue(new Error("already on this plan"));
      await expect(run(t, accepted)).resolves.toMatchObject({ kind: "upgraded" });
      expect(changePlan).not.toHaveBeenCalled();
    });

    // The /pro relay aborts at 23 s, under the Edge runtime's 25 s
    // first-response cap (api/_plan-change-relay.ts). A confirm must finish
    // inside it, or a switch that went through is reported as failed. The
    // reads give way; a changePlan in flight is never cut short.
    test("a confirm fits inside the /pro relay: reads get 6 s, changePlan keeps its own 15 s", async () => {
      const t = await setup(DURING);
      vi.spyOn(console, "log").mockImplementation(() => {});
      retrieve.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 6_000);
        return { product_id: PRO_MONTHLY };
      });
      previewChangePlan.mockResolvedValue(discountedPreview());
      changePlan.mockResolvedValue(undefined);
      await run(t, accepted);
      const readTimeouts = [retrieve.mock.calls[0]![1], previewChangePlan.mock.calls[0]![2]]
        .map((opts) => (opts as { timeout?: number } | undefined)?.timeout);
      for (const ms of readTimeouts) {
        expect(typeof ms).toBe("number");
        expect(ms!).toBeLessThanOrEqual(6_000);
      }
      // A changePlan in flight is never cut short by the reads' budget.
      expect(changePlan.mock.calls[0]).toHaveLength(2);
      // Reads plus changePlan, leaving 2 s of the relay's 23 s for Convex and the hop.
      expect(PLAN_CHANGE_CONFIRM_WORST_CASE_MS).toBe(21_000);
    });

    test("after a refused higher charge, a confirm of the fresh quote goes through at once", async () => {
      const t = await setup(DURING);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
      previewChangePlan.mockResolvedValue(withTotal(discountedPreview(), 10600));
      changePlan.mockResolvedValue(undefined);
      await expect(run(t, accepted)).rejects.toThrow(/CHARGE_CHANGED/);
      await expect(run(t, { ...accepted, acceptedChargeAmount: 10600 })).resolves.toMatchObject({ kind: "upgraded" });
      expect(changePlan).toHaveBeenCalledTimes(1);
    });

    test("the relay forwards the accepted charge, rejects a malformed one, and passes CHARGE_CHANGED through", async () => {
      vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = await setup(DURING);
      const post = (body: unknown) => t.fetch("/relay/pro-annual-switch", {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const base = { userId: USER.subject, confirm: true, discounted: true };
      for (const bad of [
        { acceptedChargeAmount: "10496", acceptedChargeCurrency: "USD" },
        { acceptedChargeAmount: -1, acceptedChargeCurrency: "USD" },
        { acceptedChargeAmount: 10.5, acceptedChargeCurrency: "USD" },
        { acceptedChargeAmount: 10496 },
        { acceptedChargeCurrency: "USD" },
        { acceptedChargeAmount: 10496, acceptedChargeCurrency: "" },
      ]) {
        expect((await post({ ...base, ...bad })).status).toBe(400);
      }
      expect(previewChangePlan).not.toHaveBeenCalled();
      retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
      previewChangePlan.mockResolvedValue(withTotal(discountedPreview(), 10700));
      const res = await post({ ...base, acceptedChargeAmount: 10496, acceptedChargeCurrency: "USD" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "CHARGE_CHANGED" });
      expect(changePlan).not.toHaveBeenCalled();
    });
  });

  test("the /pro switch relay validates the confirm's discount flag and maps the new refusals", async () => {
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
    const t = await setup(AFTER);
    const post = (body: unknown) => t.fetch("/relay/pro-annual-switch", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await post({ userId: USER.subject, discounted: true })).status).toBe(400);
    expect((await post({ userId: USER.subject, confirm: true })).status).toBe(400);
    expect((await post({ userId: USER.subject, confirm: true, discounted: "yes" })).status).toBe(400);
    retrieve.mockResolvedValue({ product_id: PRO_MONTHLY });
    const ended = await post({ userId: USER.subject, confirm: true, discounted: true });
    expect(ended.status).toBe(409);
    expect(await ended.json()).toEqual({ error: "PROMO_ENDED" });
  });

  // Each plan change has its own entry point, so a deploy that predates the
  // switch answers "no such function or route" instead of running a Pro
  // Business upgrade. The Pro Business entry points take what they took before
  // the switch existed, and refuse a Pro Yearly request before any Dodo call.
  describe("rollback protection", () => {
    const relayPost = (t: ReturnType<typeof convexTest>, path: string, body: unknown) => t.fetch(path, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    test("the Pro Business action refuses a Pro Yearly request before Dodo", async () => {
      const t = await setup(DURING);
      for (const args of [
        { confirm: false, kind: "pro_annual" },
        { confirm: true, kind: "pro_annual", discounted: true },
      ]) {
        await expect(
          t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, args as never),
        ).rejects.toThrow();
      }
      expect(previewChangePlan).not.toHaveBeenCalled();
      expect(changePlan).not.toHaveBeenCalled();
      expect(await claims(t)).toEqual([]);
    });

    test("the Pro Business relay refuses a Pro Yearly request before Dodo", async () => {
      vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
      const t = await setup(DURING);
      for (const body of [
        { userId: USER.subject, confirm: false, kind: "pro_annual" },
        { userId: USER.subject, confirm: true, kind: "pro_annual", discounted: true },
        { userId: USER.subject, confirm: false, kind: "pro_lifetime" },
      ]) {
        const res = await relayPost(t, "/relay/pro-business-upgrade", body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "INVALID_KIND" });
      }
      expect(previewChangePlan).not.toHaveBeenCalled();
      expect(changePlan).not.toHaveBeenCalled();
    });

    // An open /pro tab or dashboard from before the switch.
    test("the Pro Business relay and action still upgrade a Pro Monthly to Pro Business", async () => {
      vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
      const t = await setup(DURING);
      previewChangePlan.mockResolvedValue(listPreview());
      const res = await relayPost(t, "/relay/pro-business-upgrade", { userId: USER.subject, confirm: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ kind: "preview", toPlanKey: "pro_business_monthly" });
      const viaAction = await t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: false });
      expect(viaAction).toMatchObject({ kind: "preview", toPlanKey: "pro_business_monthly" });
      for (const call of previewChangePlan.mock.calls) {
        expect(call[1]).not.toHaveProperty("discount_code");
      }
    });

    test("a Pro Business quote does not advertise the switch's confirm guards", async () => {
      const t = await setup(DURING);
      previewChangePlan.mockResolvedValue(listPreview());
      const result = await t.withIdentity(USER).action(api.payments.billing.upgradeToProBusiness, { confirm: false });
      expect(result).not.toHaveProperty("acceptsQuoteGuards");
    });
  });
});
