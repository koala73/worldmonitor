'use strict';

/**
 * Shared Resend send helper for the Railway mail workers
 * (seed-digest-notifications.mjs and notification-relay.cjs).
 *
 * - Sets a human-read Reply-To by default. Briefs come from brief@ and alerts
 *   from alerts@; without an explicit Reply-To, replies land in those role
 *   inboxes instead of support.
 * - Treats the SDK's `{ error }` result as a failure. resend@4 resolves
 *   (does not throw) on API errors such as 422 validation failures, so a bare
 *   `await resend.emails.send()` reported every rejected send as delivered.
 *
 * Suppression for these workers is enforced upstream: both workers only send
 * to email channels returned by Convex `/relay/channels`, which drops
 * addresses in the `emailSuppressions` table (bounces, complaints, manual).
 *
 * The Convex-side equivalent lives in convex/lib/resendEmail.ts.
 */

const DEFAULT_REPLY_TO = 'support@worldmonitor.app';

/**
 * @param {{ from: string, to: string, subject: string, text?: string, html?: string,
 *   replyTo?: string | null, headers?: Record<string, string> }} input
 */
function buildResendEmailPayload(input) {
  const payload = { from: input.from, to: input.to, subject: input.subject };
  if (input.text) payload.text = input.text;
  if (input.html) payload.html = input.html;
  const replyTo = input.replyTo === undefined ? DEFAULT_REPLY_TO : input.replyTo;
  if (replyTo) payload.replyTo = replyTo;
  if (input.headers && Object.keys(input.headers).length > 0) payload.headers = { ...input.headers };
  return payload;
}

/**
 * @param {{ emails: { send: (payload: object) => Promise<any> } } | null} client
 * @param {Parameters<typeof buildResendEmailPayload>[0]} input
 * @param {{ logPrefix?: string }} [options]
 * @returns {Promise<{ ok: true, id: string | null } | { ok: false, reason: string }>}
 */
async function sendResendEmail(client, input, options = {}) {
  const prefix = options.logPrefix ?? '[resend]';
  if (!client) {
    console.warn(`${prefix} RESEND_API_KEY not set — skipping email`);
    return { ok: false, reason: 'no_client' };
  }
  try {
    const result = await client.emails.send(buildResendEmailPayload(input));
    if (result && result.error) {
      const name = result.error.name ? `${result.error.name}: ` : '';
      console.warn(`${prefix} Resend rejected send: ${name}${result.error.message ?? 'unknown error'}`);
      return { ok: false, reason: 'rejected' };
    }
    const id = result && result.data && typeof result.data.id === 'string' ? result.data.id : null;
    return { ok: true, id };
  } catch (err) {
    console.warn(`${prefix} Resend failed: ${err && err.message ? err.message : String(err)}`);
    return { ok: false, reason: 'error' };
  }
}

module.exports = { DEFAULT_REPLY_TO, buildResendEmailPayload, sendResendEmail };
