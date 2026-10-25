/**
 * Shared Resend transactional-email sender for Convex actions.
 *
 * Every Convex path that POSTs to Resend's `/emails` endpoint goes through
 * `sendResendEmail`, so two invariants hold for all of them:
 *
 * 1. The local `emailSuppressions` table is checked before the POST. Hard
 *    bounces, complaints and operator blocks stop every sender, not only the
 *    ones that remembered to call `isEmailSuppressed` themselves. A Resend
 *    broadcast unsubscribe (`reason: "unsubscribe"`) only blocks
 *    `purpose: "marketing"` sends; account and billing mail still delivers.
 * 2. A human-read Reply-To is set by default (`support@`). Senders use
 *    no-reply / role addresses as From, so without it replies vanish. Ops
 *    alerts addressed to our own inbox pass `replyTo: null` so a reply does
 *    not loop back to the same inbox.
 *
 * Resend's Broadcasts API (convex/broadcast/*) is a different endpoint with
 * its own unsubscribe handling and is intentionally not routed here.
 */

import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
export const DEFAULT_REPLY_TO = "support@worldmonitor.app";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "worldmonitor-convex/1.0";

export type EmailPurpose = "transactional" | "marketing";

export type ResendEmailInput = {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Reply-To address. Omit for the support@ default; pass `null` to send
   * without one (ops alerts to our own inbox).
   */
  replyTo?: string | null;
  /** Extra MIME headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /**
   * "marketing" also honours broadcast unsubscribes; "transactional" only
   * honours delivery failures and manual blocks.
   */
  purpose: EmailPurpose;
  timeoutMs?: number;
  userAgent?: string;
};

export type ResendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: "suppressed" };

/** Thrown on a non-2xx Resend response. `body` may echo the recipient. */
export class ResendSendError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Resend ${status}`);
    this.name = "ResendSendError";
    this.status = status;
    this.body = body;
  }
}

type SuppressionReader = Pick<ActionCtx, "runQuery">;

export function buildResendEmailPayload(input: ResendEmailInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
  };
  if (input.text !== undefined) payload.text = input.text;
  const replyTo = input.replyTo === undefined ? DEFAULT_REPLY_TO : input.replyTo;
  if (replyTo) payload.reply_to = replyTo;
  if (input.headers && Object.keys(input.headers).length > 0) payload.headers = input.headers;
  return payload;
}

export async function sendResendEmail(
  ctx: SuppressionReader,
  input: ResendEmailInput,
): Promise<ResendEmailResult> {
  const suppressed = await ctx.runQuery(internal.emailSuppressions.isEmailSuppressed, {
    email: input.to,
    purpose: input.purpose,
  });
  if (suppressed) {
    console.log(`[resendEmail] skipped ${input.purpose} send to a suppressed address`);
    return { sent: false, reason: "suppressed" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.apiKey}`,
    // AGENTS.md: every server fetch carries a User-Agent.
    "User-Agent": input.userAgent || DEFAULT_USER_AGENT,
  };

  const res = await fetch(RESEND_EMAILS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(buildResendEmailPayload(input)),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errorBody = typeof res.text === "function" ? await res.text().catch(() => "") : "";
    throw new ResendSendError(res.status, errorBody);
  }
  const body = typeof res.json === "function"
    ? ((await res.json().catch(() => null)) as { id?: unknown } | null)
    : null;
  return { sent: true, id: typeof body?.id === "string" ? body.id : null };
}
