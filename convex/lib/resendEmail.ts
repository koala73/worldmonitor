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
  idempotencyKey?: string;
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

/**
 * Resend's 10 requests/second limit is per account, shared by every Convex
 * caller: transactional mail, the dunning fleet, broadcast contact pushes and
 * broadcast create/send. Only the dunning fleet paces itself and only contact
 * pushes retried, so a single-shot POST that landed while another caller was
 * bursting failed outright (2026-11-27: a Black Friday wave stopped at
 * `create-broadcast-failed`, and an admin plan-upgrade email was lost).
 *
 * A 429 means Resend did not accept the request, so resending it cannot
 * duplicate a send. Other statuses are returned untouched.
 */
export const RESEND_RATE_LIMIT_RETRY_DELAYS_MS: readonly number[] = [600, 1_200, 2_400];
const MAX_RETRY_AFTER_MS = 5_000;

let retrySleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Test seam: replace the wait between 429 retries. Returns a restore function. */
export function setResendRetrySleepForTests(sleep: (ms: number) => Promise<void>): () => void {
  const previous = retrySleep;
  retrySleep = sleep;
  return () => {
    retrySleep = previous;
  };
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers?.get?.("retry-after");
  const seconds = header === null || header === undefined ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  const base = RESEND_RATE_LIMIT_RETRY_DELAYS_MS[attempt] ?? MAX_RETRY_AFTER_MS;
  return base + base * 0.2 * Math.random();
}

/**
 * Run a Resend request, retrying it on HTTP 429. `doFetch` must build a fresh
 * request (and timeout signal) on every call. `stillWanted`, when given, runs
 * after each wait; returning false stops and yields `null`, so a condition
 * that changed during the wait (a new suppression) is honoured.
 *
 * Do not wrap a call that SENDS a broadcast: the campaign stop and cutoff
 * checks live in the caller, and a retry here would fire after a stop.
 */
export async function fetchResendWithRateLimitRetry(doFetch: () => Promise<Response>): Promise<Response>;
export async function fetchResendWithRateLimitRetry(
  doFetch: () => Promise<Response>,
  stillWanted: () => Promise<boolean>,
): Promise<Response | null>;
export async function fetchResendWithRateLimitRetry(
  doFetch: () => Promise<Response>,
  stillWanted?: () => Promise<boolean>,
): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch();
    if (res.status !== 429 || attempt >= RESEND_RATE_LIMIT_RETRY_DELAYS_MS.length) return res;
    await res.body?.cancel().catch(() => undefined);
    await retrySleep(retryDelayMs(res, attempt));
    if (stillWanted && !(await stillWanted())) return null;
  }
}

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
  const isSuppressed = () => ctx.runQuery(internal.emailSuppressions.isEmailSuppressed, {
    email: input.to,
    purpose: input.purpose,
  });
  if (await isSuppressed()) {
    console.log(`[resendEmail] skipped ${input.purpose} send to a suppressed address`);
    return { sent: false, reason: "suppressed" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.apiKey}`,
    // AGENTS.md: every server fetch carries a User-Agent.
    "User-Agent": input.userAgent || DEFAULT_USER_AGENT,
  };

  const res = await fetchResendWithRateLimitRetry(() => fetch(RESEND_EMAILS_URL, {
    method: "POST",
    headers: { ...headers, ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}) },
    body: JSON.stringify(buildResendEmailPayload(input)),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  }), async () => !(await isSuppressed()));
  if (res === null) {
    console.log(`[resendEmail] skipped ${input.purpose} send: address was suppressed during a 429 retry wait`);
    return { sent: false, reason: "suppressed" };
  }
  if (!res.ok) {
    const errorBody = typeof res.text === "function" ? await res.text().catch(() => "") : "";
    throw new ResendSendError(res.status, errorBody);
  }
  const body = typeof res.json === "function"
    ? ((await res.json().catch(() => null)) as { id?: unknown } | null)
    : null;
  return { sent: true, id: typeof body?.id === "string" ? body.id : null };
}
