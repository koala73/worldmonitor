'use strict';

/**
 * Coerce a Resend `from:` value into a form that renders a friendly
 * display name in Gmail / Outlook / Apple Mail. When the value is a
 * bare email address (no "Name <addr@domain>" wrapper), clients fall
 * back to the local-part as the sender name — so `alerts@worldmonitor.app`
 * shows up as "alerts" in the inbox, which reads like an incident
 * alarm when the mail is actually a curated editorial brief.
 *
 * We coerce (rather than fail-closed) so a misconfigured Railway env
 * does NOT take the cron down; the coercion emits a loud warning so
 * operators can see and fix the misconfiguration in logs.
 *
 * @param {string | null | undefined} raw - env value (possibly empty).
 * @param {string} defaultDisplayName - friendly name to wrap bare addresses with.
 * @param {(msg: string) => void} [warn] - warning sink (default: console.warn).
 * @returns {string | null} normalized sender, or null when raw is empty.
 */
function normalizeResendSender(raw, defaultDisplayName, warn) {
  const warnFn = typeof warn === 'function' ? warn : (m) => console.warn(m);
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (value.includes('<') && value.includes('>')) return value;
  warnFn(
    `[resend] sender "${value}" lacks display name — coercing to "${defaultDisplayName} <${value}>". ` +
      `Set the env var in "Name <addr@domain>" form to silence this.`,
  );
  return `${defaultDisplayName} <${value}>`;
}

module.exports = { normalizeResendSender };
