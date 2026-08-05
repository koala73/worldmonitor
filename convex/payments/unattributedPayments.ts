import { internalAction, internalQuery, type MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

const ADMIN_EMAIL = "elie@worldmonitor.app";

/**
 * Per-customer quiet period for *uncharged* events only.
 *
 * A settled charge always emails immediately — money is on the line and the
 * volume is inherently tiny. Uncharged attempts are throttled because a
 * card-testing burst hits the same customer repeatedly, and one admin email per
 * attempt would train the recipient to ignore the alert.
 */
const UNCHARGED_NOTIFY_QUIET_PERIOD_MS = 24 * 60 * 60 * 1000;

/** Events where money settled, so the buyer is owed fulfillment. */
const CHARGED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "payment.succeeded",
  "refund.succeeded",
  // Dodo activates a subscription only after its first payment settles.
  "subscription.active",
]);

export function isChargedEventType(eventType: string): boolean {
  return CHARGED_EVENT_TYPES.has(eventType);
}

type DodoCustomerLike = {
  customer_id?: unknown;
  email?: unknown;
  name?: unknown;
};

type UnattributedPayloadData = {
  customer?: DodoCustomerLike;
  payment_id?: unknown;
  subscription_id?: unknown;
  product_id?: unknown;
  total_amount?: unknown;
  recurring_pre_tax_amount?: unknown;
  currency?: unknown;
  error_code?: unknown;
  error_message?: unknown;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Durably records an authenticated-but-unattributable Dodo event and queues the
 * ops notification.
 *
 * Callers MUST let a throw from here propagate: the webhook may only acknowledge
 * (200) once this row is committed. If the write fails and we acknowledged
 * anyway, the event would be lost outright — strictly worse than a retry storm.
 *
 * Returns whether a notification was queued, so tests and callers can assert the
 * throttle without reaching into the scheduler.
 */
export async function recordUnattributedEvent(
  ctx: MutationCtx,
  args: {
    webhookId: string;
    eventType: string;
    rawPayload: unknown;
    data: UnattributedPayloadData;
    eventTimestamp: number;
    /**
     * Overrides the charged/uncharged judgement for callers that know more than
     * the envelope does. `subscription.updated` carrying an active status is a
     * settled subscription, but its event type alone does not say so.
     */
    charged?: boolean;
  },
): Promise<{ notified: boolean }> {
  const now = Date.now();
  const charged = args.charged ?? isChargedEventType(args.eventType);
  const customer = args.data.customer ?? {};
  const dodoCustomerId = str(customer.customer_id);

  // Idempotency: Dodo redelivering the same message must not create a second
  // row or a second alert.
  const existing = await ctx.db
    .query("unattributedPaymentEvents")
    .withIndex("by_webhookId", (q) => q.eq("webhookId", args.webhookId))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, {
      lastSeenAt: now,
      occurrences: existing.occurrences + 1,
    });
    return { notified: false };
  }

  // Throttle uncharged alerts per customer. Charged events never throttle.
  //
  // The question is "did we ALERT about this customer recently", not "is there a
  // recent row" — most rows in a burst are themselves throttled and carry no
  // `notifiedAt`. Walk newest-first and stop at the first row we actually
  // alerted on; `take` bounds the scan so a long burst cannot walk the table.
  let shouldNotify = true;
  if (!charged && dodoCustomerId) {
    const recent = await ctx.db
      .query("unattributedPaymentEvents")
      .withIndex("by_dodoCustomerId_lastSeenAt", (q) =>
        q.eq("dodoCustomerId", dodoCustomerId),
      )
      .order("desc")
      .take(50);
    const lastNotifiedAt = recent.find((r) => r.notifiedAt !== undefined)?.notifiedAt;
    if (
      lastNotifiedAt !== undefined &&
      lastNotifiedAt > now - UNCHARGED_NOTIFY_QUIET_PERIOD_MS
    ) {
      shouldNotify = false;
    }
  }

  const rowId = await ctx.db.insert("unattributedPaymentEvents", {
    webhookId: args.webhookId,
    eventType: args.eventType,
    charged,
    dodoCustomerId,
    dodoPaymentId: str(args.data.payment_id),
    dodoSubscriptionId: str(args.data.subscription_id),
    dodoProductId: str(args.data.product_id),
    customerEmail: str(customer.email),
    customerName: str(customer.name),
    amount: num(args.data.total_amount) ?? num(args.data.recurring_pre_tax_amount),
    currency: str(args.data.currency),
    errorCode: str(args.data.error_code),
    errorMessage: str(args.data.error_message),
    rawPayload: args.rawPayload,
    eventTimestamp: args.eventTimestamp,
    receivedAt: now,
    lastSeenAt: now,
    occurrences: 1,
    notifiedAt: shouldNotify ? now : undefined,
    resolved: false,
  });

  if (!shouldNotify) return { notified: false };

  // `convex-test` cannot safely await a scheduler write started from an HTTP
  // action's mutation, matching the existing guards in subscriptionHelpers.ts.
  if (process.env.NODE_ENV !== "test") {
    await ctx.scheduler.runAfter(
      0,
      internal.payments.unattributedPayments.notifyUnattributedPayment,
      { rowId },
    );
  }
  return { notified: true };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function row(label: string, value: string | undefined): string {
  if (!value) return "";
  return `<tr><td style="color: #888; padding-right: 16px;">${escapeHtml(label)}:</td><td style="color: #fff;">${escapeHtml(value)}</td></tr>`;
}

export const getUnattributedRow = internalQuery({
  args: { rowId: v.id("unattributedPaymentEvents") },
  handler: async (ctx, { rowId }) => ctx.db.get(rowId),
});

/**
 * Lists unresolved rows so an operator can see what is waiting on a human.
 * Newest first; `charged` rows are the ones costing money.
 */
export const listUnresolvedUnattributed = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("unattributedPaymentEvents")
      .withIndex("by_resolved_lastSeenAt", (q) => q.eq("resolved", false))
      .order("desc")
      .take(Math.min(limit ?? 50, 200));
    // rawPayload is intentionally dropped: this is an ops listing, not an export.
    return rows.map(({ rawPayload: _rawPayload, ...rest }) => rest);
  },
});

/**
 * Emails ops about an event we could not attribute.
 *
 * A charged row is an incident — someone paid and holds no access. An uncharged
 * row is a sales signal: a buyer tried to pay and could not. Both are things we
 * want to hear about; the subject line distinguishes them so neither gets lost
 * in the other's noise.
 */
export const notifyUnattributedPayment = internalAction({
  args: { rowId: v.id("unattributedPaymentEvents") },
  handler: async (ctx, { rowId }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[unattributedPayments] RESEND_API_KEY not set — no alert sent");
      return;
    }
    const record = await ctx.runQuery(
      internal.payments.unattributedPayments.getUnattributedRow,
      { rowId },
    );
    if (!record) {
      console.error(`[unattributedPayments] row ${rowId} vanished before notify`);
      return;
    }

    const money = record.amount !== undefined && record.currency
      ? `${(record.amount / 100).toFixed(2)} ${record.currency}`
      : undefined;

    const subject = record.charged
      ? `[WM] ACTION REQUIRED — paid but unattributed (${money ?? record.eventType})`
      : `[WM] Buyer could not pay — unattributed ${record.eventType}`;

    const headline = record.charged
      ? "Money settled and we could not attach it to a user. They have paid and hold no access."
      : "A payment attempt failed for someone we have no account for. Nothing was charged — this is a sales signal, not an outage.";

    const guidance = record.charged
      ? `Attribute it with <code>attributeUnattributedPayment</code> (rowId + the userId who should own it). That writes the customer mapping and replays the event, granting entitlement.`
      : `No action is required for billing. Worth a follow-up if this buyer keeps failing — repeat attempts from the same customer are throttled to one alert per 24h.`;

    const html = `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #e0e0e0;">
        <p style="color: ${record.charged ? "#f87171" : "#facc15"}; font-size: 16px; font-weight: bold;">${escapeHtml(record.charged ? "Unattributed PAID event" : "Unattributed failed payment")}</p>
        <p style="font-size: 13px; color: #ccc;">${escapeHtml(headline)}</p>
        <table style="font-size: 14px; line-height: 1.8;">
          ${row("Event", record.eventType)}
          ${row("Amount", money)}
          ${row("Email", record.customerEmail)}
          ${row("Name", record.customerName)}
          ${row("Reason", record.errorMessage ?? record.errorCode)}
          ${row("Customer", record.dodoCustomerId)}
          ${row("Subscription", record.dodoSubscriptionId)}
          ${row("Payment", record.dodoPaymentId)}
          ${row("Product", record.dodoProductId)}
          ${row("Row", rowId)}
        </table>
        <p style="font-size: 12px; color: #999; margin-top: 16px;">${guidance}</p>
      </div>`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "World Monitor <noreply@worldmonitor.app>",
        to: ADMIN_EMAIL,
        subject,
        html,
      }),
    });
    if (!response.ok) {
      // Throwing lets Convex's action retry policy have another go; the row is
      // already durable either way, so the record is never at risk.
      throw new Error(
        `[unattributedPayments] Resend failed (${response.status}) for row ${rowId}`,
      );
    }
    console.log(`[unattributedPayments] alert sent for ${rowId} (charged=${record.charged})`);
  },
});
