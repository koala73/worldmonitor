/**
 * Who gets which Black Friday email. Pure (no Convex APIs), so every rule is
 * unit-tested without a database; blackFriday.ts feeds it rows.
 *
 * Accounts (`users` rows) fall into one group or one exclusion:
 *   - monthly  an active Pro Monthly ($39.99) the in-place switch accepts
 *              today (the same selection Settings uses), with no cancellation
 *              scheduled, so the email only reaches people the "Switch to
 *              yearly" button works for
 *   - lapsed   has subscription history, none of it covering now, and no
 *              remaining entitlement
 *   - free     no subscription history and no paid or comped entitlement
 *
 * Waitlist contacts are `registrations` rows whose email has no account and
 * no customer record.
 *
 * A stamp for the send (blackFriday*Wave) is checked last, so a dry run
 * reports "eligible" and "already sent" separately.
 */
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { selectPlanChangeCandidate } from "../payments/billing";
import { isCoveringAt } from "../payments/subscriptionHelpers";
import { inferLocaleFromEmail } from "./_localeHeuristic";
import {
  pickBlackFridayLocale,
  type BlackFridayLocale,
  type BlackFridayRecipient,
  type BlackFridayVersion,
} from "./blackFridayEmailContent";

export type BlackFridaySend = "launch" | "last-day";

/** No wave starts, is released or is retried this close to the end: the email must arrive in time to act on. */
export const SEND_CUTOFF_BEFORE_END_MS = 2 * 60 * 60 * 1000;
export type AccountGroup = "free" | "lapsed" | "monthly";

export type AccountExclusion =
  | "no-email"
  | "suppressed"
  | "account-deleting"
  | "enterprise-member"
  | "pro-yearly"
  | "converted-during-offer"
  | "pro-business"
  | "api-plan"
  | "enterprise-plan"
  | "monthly-cancel-scheduled"
  | "on-hold"
  | "pro-monthly-mcp"
  | "monthly-cancelled-still-covered"
  | "other-covering-plan"
  | "entitled-without-subscription";

export type WaitlistExclusion = "no-email" | "suppressed" | "has-account" | "customer";

type SubscriptionFacts = Parameters<typeof selectPlanChangeCandidate>[1][number] & {
  currentPeriodStart: number;
  cancelScheduledAt?: number;
};

/**
 * A scheduled cancellation is recorded twice: Dodo's flag in the stored
 * payload, which the switch selection reads, and `cancelScheduledAt`, stamped
 * when the cancel was scheduled. Either one excludes, so the selection sees
 * the flag whenever the stamp is set.
 */
function withCancelStamp(sub: SubscriptionFacts): SubscriptionFacts {
  if (sub.status !== "active" || sub.cancelScheduledAt === undefined) return sub;
  const payload = (sub.rawPayload ?? {}) as Record<string, unknown>;
  return { ...sub, rawPayload: { ...payload, cancel_at_next_billing_date: true } };
}

export interface AccountFacts {
  normalizedEmail: string | undefined;
  suppressed: boolean;
  deleting: boolean;
  enterpriseMemberActive: boolean;
  subscriptions: readonly SubscriptionFacts[];
  entitlement: { planKey: string; validUntil: number; compUntil?: number } | null;
}

export type AccountOutcome =
  | { eligible: true; group: AccountGroup }
  | { eligible: false; reason: AccountExclusion };

function coveringExclusion(covering: readonly SubscriptionFacts[], offerStartsAtMs: number): AccountExclusion {
  const yearly = covering.find((sub) => sub.planKey === "pro_annual");
  if (yearly) {
    return yearly.currentPeriodStart >= offerStartsAtMs ? "converted-during-offer" : "pro-yearly";
  }
  const groups = new Set(covering.map((sub) => PRODUCT_CATALOG[sub.planKey]?.tierGroup));
  if (groups.has("enterprise")) return "enterprise-plan";
  if (groups.has("pro_business")) return "pro-business";
  if (groups.has("api_starter") || groups.has("api_business")) return "api-plan";
  // Pro at the MCP-only price: not the $39.99 plan the switch email describes,
  // and the in-place switch does not take it.
  if (covering.some((sub) => sub.planKey === "pro_monthly_mcp")) return "pro-monthly-mcp";
  const monthly = covering.filter((sub) => sub.planKey === "pro_monthly");
  if (monthly.some((sub) => sub.status === "active")) return "monthly-cancel-scheduled";
  if (monthly.length > 0) return "monthly-cancelled-still-covered";
  return "other-covering-plan";
}

export function classifyAccount(facts: AccountFacts, now: number, offerStartsAtMs: number): AccountOutcome {
  if (!facts.normalizedEmail || !facts.normalizedEmail.includes("@")) return { eligible: false, reason: "no-email" };
  if (facts.suppressed) return { eligible: false, reason: "suppressed" };
  if (facts.deleting) return { eligible: false, reason: "account-deleting" };
  if (facts.enterpriseMemberActive) return { eligible: false, reason: "enterprise-member" };

  // A failed payment Dodo may still retry, whether or not the paid period has
  // ended: the dunning emails own that conversation, and a second purchase
  // could bill twice.
  if (facts.subscriptions.some((sub) => sub.status === "on_hold")) return { eligible: false, reason: "on-hold" };

  const subscriptions = facts.subscriptions.map(withCancelStamp);
  const covering = subscriptions.filter((sub) => isCoveringAt(sub, now));
  if (covering.length > 0) {
    // Settings' own rule for who may switch: an active, non-cancelling Pro
    // Monthly with nothing at or above Pro Yearly.
    if (selectPlanChangeCandidate("pro_annual", subscriptions, now).ok) {
      return { eligible: true, group: "monthly" };
    }
    return { eligible: false, reason: coveringExclusion(covering, offerStartsAtMs) };
  }

  // Bought or switched to Pro Yearly during the offer and no longer covered
  // (refunded, charged back): the offer is not re-sent.
  if (facts.subscriptions.some((sub) => sub.planKey === "pro_annual" && sub.currentPeriodStart >= offerStartsAtMs)) {
    return { eligible: false, reason: "converted-during-offer" };
  }
  const entitlement = facts.entitlement;
  if (
    entitlement &&
    ((entitlement.planKey !== "free" && entitlement.validUntil > now) ||
      (typeof entitlement.compUntil === "number" && entitlement.compUntil > now))
  ) {
    // Comped, seat-granted or still inside a paid period with no live subscription.
    return { eligible: false, reason: "entitled-without-subscription" };
  }
  return { eligible: true, group: facts.subscriptions.length > 0 ? "lapsed" : "free" };
}

export interface WaitlistFacts {
  normalizedEmail: string | undefined;
  suppressed: boolean;
  hasAccount: boolean;
  isCustomer: boolean;
}

export type WaitlistOutcome = { eligible: true } | { eligible: false; reason: WaitlistExclusion };

export function classifyWaitlist(facts: WaitlistFacts): WaitlistOutcome {
  if (!facts.normalizedEmail || !facts.normalizedEmail.includes("@")) return { eligible: false, reason: "no-email" };
  if (facts.suppressed) return { eligible: false, reason: "suppressed" };
  if (facts.hasAccount) return { eligible: false, reason: "has-account" };
  if (facts.isCustomer) return { eligible: false, reason: "customer" };
  return { eligible: true };
}

/**
 * An account's email locale: the stored browser tag (it keeps `zh-TW`, which
 * gets English), else the primary subtag, else the email-domain heuristic.
 */
export function accountLocale(user: {
  localeTag?: string;
  localePrimary?: string;
  normalizedEmail?: string;
}): BlackFridayLocale {
  const stored = user.localeTag ?? user.localePrimary;
  if (stored) return pickBlackFridayLocale(stored);
  return pickBlackFridayLocale(inferLocaleFromEmail(user.normalizedEmail));
}

/** A waitlist contact has no stored locale: the email-domain heuristic, else English. */
export function waitlistLocale(normalizedEmail: string): BlackFridayLocale {
  return pickBlackFridayLocale(inferLocaleFromEmail(normalizedEmail));
}

/** The email version for an audience group in a send. */
export function versionFor(send: BlackFridaySend, group: AccountGroup | "waitlist"): BlackFridayVersion {
  if (send === "last-day") return group === "monthly" ? "last-day-switch" : "last-day";
  if (group === "monthly") return "monthly-switch";
  return group === "lapsed" ? "lapsed" : "new-buyer";
}

/** The audience groups a version is sent to, by recipient type. */
export function groupsFor(
  version: BlackFridayVersion,
  recipient: BlackFridayRecipient,
): ReadonlyArray<AccountGroup | "waitlist"> | null {
  if (recipient === "waitlist") {
    return version === "new-buyer" || version === "last-day" ? ["waitlist"] : null;
  }
  switch (version) {
    case "new-buyer":
      return ["free"];
    case "lapsed":
      return ["lapsed"];
    case "monthly-switch":
    case "last-day-switch":
      return ["monthly"];
    case "last-day":
      return ["free", "lapsed"];
  }
}

export function sendFor(version: BlackFridayVersion): BlackFridaySend {
  return version === "last-day" || version === "last-day-switch" ? "last-day" : "launch";
}

export function segmentKey(version: BlackFridayVersion, locale: BlackFridayLocale, recipient: BlackFridayRecipient): string {
  return `${version}/${locale}/${recipient}`;
}

/** The stamp fields for a send; the same names on `users` and `registrations`. */
export function stampFieldFor(send: BlackFridaySend): "blackFridayLaunchWave" | "blackFridayLastDayWave" {
  return send === "launch" ? "blackFridayLaunchWave" : "blackFridayLastDayWave";
}
