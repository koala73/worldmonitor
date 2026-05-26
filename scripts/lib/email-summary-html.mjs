// Email summary block builder.
//
// Extracted from scripts/seed-digest-notifications.mjs so the
// HTML assembly can be unit-tested without the cron's
// env-checking side effects (DIGEST_CRON_ENABLED check, Upstash
// REST helper, Convex relay auth).
//
// The pre-canonical-brain email shipped a 5-paragraph editorial
// blob from the legacy generateAISummary call. After the
// single-canonical-synthesis refactor (PR #3396), the synthesis
// returns structured fields ({lead, threads, signals}) and
// the magazine renders each as its own page. This builder maps
// the structured output back into a multi-section HTML block so
// the email matches the old richness — a single pull-quote-only
// lead is too thin for an email body.

import { markdownToEmailHtml } from '../_digest-markdown.mjs';

/**
 * Inject the canonical synthesis (lead + threads + signals) into
 * the HTML email template's `<div data-ai-summary-slot></div>`
 * placeholder.
 *
 * `summary` may be:
 *   - null/undefined/empty-object → slot is stripped (no editorial
 *     block in the email at all). Used for the L3 stub or AI-digest
 *     opt-out paths.
 *   - a string → rendered as the lead block only, no threads/
 *     signals. Used for the L3 stub-string path and for legacy
 *     callers passing a flat string.
 *   - an object {lead, threads, signals} → rendered with all three
 *     sections, matching the magazine's editorial structure (and
 *     the pre-refactor email's 5-paragraph richness).
 *
 * @param {string} html
 * @param {string | { lead?: string; threads?: Array<{tag?: string; teaser?: string}>; signals?: string[] } | null | undefined} summary
 * @returns {string}
 */
export function injectEmailSummary(html, summary) {
  if (!html) return html;
  if (!summary || (typeof summary === 'object' && !summary.lead)) {
    return html.replace('<div data-ai-summary-slot></div>', '');
  }

  // Normalise to {lead, threads, signals}. String input (legacy /
  // stub) → just a lead, no extras.
  const payload = typeof summary === 'string'
    ? { lead: summary, threads: [], signals: [] }
    : {
        lead: typeof summary.lead === 'string' ? summary.lead : '',
        threads: Array.isArray(summary.threads) ? summary.threads : [],
        signals: Array.isArray(summary.signals) ? summary.signals : [],
      };
  if (!payload.lead) {
    return html.replace('<div data-ai-summary-slot></div>', '');
  }

  const htmlEscape = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const leadHtml = markdownToEmailHtml(payload.lead);

  // Threads: each rendered as "<b>Tag</b> — teaser" on its own line.
  // Mirrors the old "3-5 bullet points" section visually without
  // forcing an unordered list (cleaner in Gmail / Outlook clients).
  const threadsHtml = payload.threads.length > 0
    ? payload.threads.map((t) => {
        const tag = htmlEscape(t?.tag ?? '');
        const teaser = htmlEscape(t?.teaser ?? '');
        if (!tag || !teaser) return '';
        return `<div style="font-size:13px;line-height:1.7;color:#ccc;margin:0 0 8px 0;"><b style="color:#f2ede4;">${tag}</b> — ${teaser}</div>`;
      }).filter(Boolean).join('')
    : '';

  // Signals: rendered as a "Signals to watch:" trailer matching the
  // pre-refactor convention. Each signal on its own line.
  // Defensive: filter the bullets FIRST and only emit the "Signals to
  // watch:" header when at least one bullet survived. Otherwise an
  // all-malformed signals array (e.g. [null, 42, '']) renders as an
  // orphan header with no bullets beneath. Greptile P2 on PR #3411.
  const signalBullets = payload.signals
    .map((s) => {
      const text = htmlEscape(typeof s === 'string' ? s : '');
      if (!text) return '';
      return `<div style="font-size:13px;line-height:1.7;color:#ccc;margin:4px 0 0 0;">• ${text}</div>`;
    })
    .filter(Boolean);
  const signalsHtml = signalBullets.length > 0
    ? `<div style="font-size:13px;line-height:1.7;color:#ccc;margin:14px 0 0 0;"><b style="color:#f2ede4;">Signals to watch:</b></div>` +
      signalBullets.join('')
    : '';

  const summaryHtml = `<div style="background:#161616;border:1px solid #222;border-left:3px solid #4ade80;padding:18px 22px;margin:0 0 24px 0;">
<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#4ade80;margin-bottom:10px;">Executive Summary</div>
<div style="font-size:13px;line-height:1.7;color:#ccc;margin-bottom:${threadsHtml || signalsHtml ? '14px' : '0'};">${leadHtml}</div>
${threadsHtml}
${signalsHtml}
</div>`;
  return html.replace('<div data-ai-summary-slot></div>', summaryHtml);
}
