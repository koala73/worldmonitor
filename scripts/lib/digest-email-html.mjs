// Daily digest email HTML: story cards, brief CTA, and the Gmail size cap.
//
// Extracted from scripts/seed-digest-notifications.mjs so the rendered
// email can be measured in tests without the cron's env-checking side
// effects. The cron imports everything it renders from here.

import { escapeHtml, safeHttpUrl } from '../_digest-markdown.mjs';
import { formatStoryPhaseBadge } from '../../shared/story-phase.js';
import { stripSourceSuffix } from './brief-dedup-jaccard.mjs';
import { injectEmailSummary } from './email-summary-html.mjs';
import { digestCoverageText } from './digest-corroboration.mjs';

export const DIGEST_CRITICAL_LIMIT = Infinity;
export const DIGEST_HIGH_LIMIT = 15;
export const DIGEST_MEDIUM_LIMIT = 10;

const DEFAULT_SEVERITY_LIMITS = {
  critical: DIGEST_CRITICAL_LIMIT,
  high: DIGEST_HIGH_LIMIT,
  medium: DIGEST_MEDIUM_LIMIT,
};
const SEVERITY_ORDER = ['critical', 'high', 'medium'];

/**
 * Gmail clips a message whose HTML exceeds ~102KB and hides the rest
 * (including the footer) behind "View entire message". The cap is 90,000
 * bytes of UTF-8 HTML, not ~100KB, because Resend click tracking (if on)
 * rewrites every link into a longer redirect URL after we hand over the
 * HTML. A digest has up to ~70 links; at ~150 extra bytes each that is
 * ~10KB, so 90KB plus rewriting still stays below Gmail's cut-off
 * (counted conservatively as 102,000 bytes).
 */
export const GMAIL_CLIP_BYTES = 102 * 1000;
export const DIGEST_EMAIL_MAX_HTML_BYTES = 90_000;

const DASHBOARD_URL = 'https://worldmonitor.app/dashboard';

function fullBriefNoticeHtml(link) {
  if (!link?.url) return '';
  return `<div style="margin: 0 0 24px; padding: 14px 16px; background: #161616; border: 1px solid #222; font-size: 13px; color: #bbb; line-height: 1.5;">This email was shortened to fit your inbox. <a href="${escapeHtml(link.url)}" style="color: #4ade80; font-weight: 700; text-decoration: none;">${escapeHtml(link.label)} &rarr;</a></div>`;
}

/**
 * @param {Array<object>} stories formatter-shaped digest stories
 * @param {number} nowMs
 * @param {{ limits?: { critical?: number, high?: number, medium?: number },
 *           fullBriefLink?: { url: string, label: string } | null }} [options]
 *   `limits` overrides the per-severity card caps (the size cap uses this to
 *   drop cards). `fullBriefLink` renders a "shortened to fit" notice that
 *   points at the full brief.
 */
export function formatDigestHtml(stories, nowMs, options = {}) {
  if (!stories || stories.length === 0) return null;
  const dateStr = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(nowMs));

  const buckets = { critical: [], high: [], medium: [] };
  for (const s of stories) {
    const b = buckets[s.severity] ?? buckets.high;
    b.push(s);
  }

  const totalCount = stories.length;
  const criticalCount = buckets.critical.length;
  const highCount = buckets.high.length;

  const SEVERITY_BORDER = { critical: '#ef4444', high: '#f97316', medium: '#eab308' };

  function storyCard(s) {
    const borderColor = SEVERITY_BORDER[s.severity] ?? '#4ade80';
    const phaseBadge = formatStoryPhaseBadge(s.phase);
    const phaseColor = phaseBadge?.color;
    const phaseCap = phaseBadge?.label ?? '';
    const srcText = s.sources.length > 0
      ? s.sources.slice(0, 3).join(', ') + (s.sources.length > 3 ? ` +${s.sources.length - 3}` : '')
      : '';
    const coverageText = digestCoverageText(s);
    const cleanTitle = stripSourceSuffix(s.title);
    const href = safeHttpUrl(s.link);
    const titleEl = href
      ? `<a href="${escapeHtml(href)}" style="color: #e0e0e0; text-decoration: none; font-size: 14px; font-weight: 600; line-height: 1.4;">${escapeHtml(cleanTitle)}</a>`
      : `<span style="color: #e0e0e0; font-size: 14px; font-weight: 600; line-height: 1.4;">${escapeHtml(cleanTitle)}</span>`;
    // RSS description: truncated ~200 chars at a word boundary, rendered
    // between title and meta when present. Empty → section omitted (R6).
    let snippetEl = '';
    if (typeof s.description === 'string' && s.description.length > 0) {
      const trimmed = s.description.length > 200
        ? s.description.slice(0, 200).replace(/\s+\S*$/, '') + '…'
        : s.description;
      snippetEl = `<div style="margin-top: 6px; font-size: 12px; color: #999; line-height: 1.45;">${escapeHtml(trimmed)}</div>`;
    }
    const meta = [
      phaseBadge ? `<span style="font-size: 10px; color: ${phaseColor}; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">${phaseCap}</span>` : '',
      srcText ? `<span style="font-size: 11px; color: #555;">${escapeHtml(srcText)}</span>` : '',
      coverageText ? `<span style="font-size: 11px; color: #888;">${escapeHtml(coverageText)}</span>` : '',
    ].filter(Boolean).join('<span style="color: #333; margin: 0 6px;">&bull;</span>');
    return `<div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid ${borderColor}; padding: 12px 16px; margin-bottom: 8px;">${titleEl}${snippetEl}${meta ? `<div style="margin-top: 6px;">${meta}</div>` : ''}</div>`;
  }

  const SEVERITY_LIMITS = { ...DEFAULT_SEVERITY_LIMITS, ...(options.limits ?? {}) };

  function sectionHtml(severity, items) {
    if (items.length === 0) return '';
    const limit = SEVERITY_LIMITS[severity] ?? DIGEST_MEDIUM_LIMIT;
    const SEVERITY_LABEL = { critical: '&#128308; Critical', high: '&#128992; High', medium: '&#128993; Medium' };
    const label = SEVERITY_LABEL[severity] ?? severity.toUpperCase();
    const cards = items.slice(0, limit).map(storyCard).join('');
    const overflow = items.length > limit
      ? `<p style="font-size: 12px; color: #555; margin: 4px 0 16px; padding-left: 4px;">... and ${items.length - limit} more</p>`
      : '';
    return `<div style="margin-bottom: 24px;"><div style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px;">${label} (${items.length})</div>${cards}${overflow}</div>`;
  }

  const sectionsHtml = ['critical', 'high', 'medium']
    .map((sev) => sectionHtml(sev, buckets[sev]))
    .join('');

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #111; color: #e0e0e0;">
  <div style="max-width: 680px; margin: 0 auto;">
    <div style="background: #4ade80; height: 3px;"></div>
    <div style="background: #0d0d0d; padding: 32px 36px 0;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 28px;">
        <tr>
          <td style="vertical-align: middle;">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="width: 36px; height: 36px; vertical-align: middle;">
                  <img src="https://www.worldmonitor.app/favico/android-chrome-192x192.png" width="36" height="36" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
                </td>
                <td style="padding-left: 10px;">
                  <div style="font-size: 15px; font-weight: 800; color: #fff; letter-spacing: -0.3px;">WORLD MONITOR</div>
                </td>
              </tr>
            </table>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 1px;">${dateStr}</span>
          </td>
        </tr>
      </table>
      <div data-ai-summary-slot></div>
      <div data-brief-cta-slot></div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 24px;">
        <tr>
          <td style="text-align: center; padding: 14px 8px; width: 33%; background: #161616; border: 1px solid #222;">
            <div style="font-size: 24px; font-weight: 800; color: #4ade80;">${totalCount}</div>
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 2px;">Events</div>
          </td>
          <td style="width: 1px;"></td>
          <td style="text-align: center; padding: 14px 8px; width: 33%; background: #161616; border: 1px solid #222;">
            <div style="font-size: 24px; font-weight: 800; color: #ef4444;">${criticalCount}</div>
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 2px;">Critical</div>
          </td>
          <td style="width: 1px;"></td>
          <td style="text-align: center; padding: 14px 8px; width: 33%; background: #161616; border: 1px solid #222;">
            <div style="font-size: 24px; font-weight: 800; color: #f97316;">${highCount}</div>
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 2px;">High</div>
          </td>
        </tr>
      </table>
      ${sectionsHtml}${options.fullBriefLink?.url ? `\n      ${fullBriefNoticeHtml(options.fullBriefLink)}` : ''}
      <div style="text-align: center; padding: 12px 0 36px;">
        <a href="https://worldmonitor.app/dashboard" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 12px 32px; text-decoration: none; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 3px;">Open Dashboard</a>
      </div>
    </div>
    <div style="background: #0a0a0a; border-top: 1px solid #1a1a1a; padding: 20px 36px; text-align: center;">
      <div style="margin-bottom: 12px;">
        <a href="https://x.com/worldmonitorai" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">X / Twitter</a>
        <a href="https://github.com/koala73/worldmonitor" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">GitHub</a>
      </div>
      <p style="font-size: 10px; color: #444; margin: 0; line-height: 1.5;">
        <a href="https://worldmonitor.app" style="color: #4ade80; text-decoration: none;">worldmonitor.app</a>
      </p>
      <p style="font-size: 10px; color: #444; margin: 8px 0 0; line-height: 1.5;"><!--wm-unsubscribe-slot--></p>
    </div>
  </div>
</div>`;
}

/**
 * Inject the "Open your brief" CTA into the email HTML. Placed near
 * the top of the body so recipients see the magazine link before the
 * story list. Uses inline styles only (Gmail / Outlook friendly).
 * When no magazineUrl is present (composer skipped / signing
 * failed), the slot is stripped so the email stays clean.
 */
export function injectBriefCta(html, magazineUrl) {
  if (!html) return html;
  if (!magazineUrl) return html.replace('<div data-brief-cta-slot></div>', '');
  const escapedUrl = String(magazineUrl)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const ctaHtml = `<div style="margin:0 0 24px 0;">
<a href="${escapedUrl}" style="display:inline-block;background:#f2ede4;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.08em;padding:14px 22px;border-radius:4px;">Open your WorldMonitor Brief →</a>
<div style="margin-top:10px;font-size:11px;color:#888;line-height:1.5;">Your personalised editorial magazine. Opens in the browser — scroll or swipe through today's threads.</div>
</div>`;
  return html.replace('<div data-brief-cta-slot></div>', ctaHtml);
}

function htmlBytes(html) {
  return Buffer.byteLength(html ?? '', 'utf8');
}

/**
 * Per-severity limits that show at most `budget` cards, filled in severity
 * order (critical first), never above the default limits.
 */
function limitsForBudget(counts, budget) {
  const limits = {};
  let left = budget;
  for (const severity of SEVERITY_ORDER) {
    const shown = Math.min(counts[severity] ?? 0, DEFAULT_SEVERITY_LIMITS[severity], left);
    limits[severity] = shown;
    left -= shown;
  }
  return limits;
}

/**
 * Render the full digest email (cards + synthesis + brief CTA) and keep it
 * under `maxBytes`.
 *
 * Under the cap this returns exactly what the cron sent before. Over it,
 * whole story cards are dropped from the bottom (medium, then high, then
 * critical, each in ranked order), the existing "... and N more" lines count
 * them, and a notice links to the full brief (the magazine URL, or the
 * dashboard when no brief was composed, e.g. the compose-miss fallback
 * path). Cards are removed before rendering, so markup is never cut
 * mid-tag. If the editorial block alone is over the cap it is dropped too,
 * since the brief link carries it.
 *
 * @returns {{ html: string | null, bytes: number, truncated: boolean, shownStories: number }}
 */
export function renderDigestEmailHtml({
  stories,
  nowMs,
  synthesis = null,
  magazineUrl = null,
  maxBytes = DIGEST_EMAIL_MAX_HTML_BYTES,
}) {
  const render = (options, withSynthesis = true) => {
    const raw = formatDigestHtml(stories, nowMs, options);
    if (!raw) return null;
    return injectBriefCta(injectEmailSummary(raw, withSynthesis ? synthesis : null), magazineUrl);
  };

  const counts = { critical: 0, high: 0, medium: 0 };
  for (const s of stories ?? []) {
    const severity = s?.severity in counts ? s.severity : 'high';
    counts[severity]++;
  }
  const fullShown = SEVERITY_ORDER.reduce(
    (n, sev) => n + Math.min(counts[sev], DEFAULT_SEVERITY_LIMITS[sev]),
    0,
  );

  const full = render({});
  if (full === null) return { html: null, bytes: 0, truncated: false, shownStories: 0 };
  const fullBytes = htmlBytes(full);
  if (fullBytes <= maxBytes) {
    return { html: full, bytes: fullBytes, truncated: false, shownStories: fullShown };
  }

  const fullBriefLink = magazineUrl
    ? { url: magazineUrl, label: 'Read the full brief' }
    : { url: DASHBOARD_URL, label: `See all ${stories.length} stories on the dashboard` };

  // Largest card budget that fits. Rendered size grows with the budget, so
  // binary search. With the synthesis, every card is already known not to
  // fit (that was the full render), so search [0, fullShown - 1]. Without
  // it, all cards may fit again, so search [0, fullShown].
  for (const withSynthesis of [true, false]) {
    const at = (budget) => render({ limits: limitsForBudget(counts, budget), fullBriefLink }, withSynthesis);
    const floor = at(0);
    if (htmlBytes(floor) > maxBytes) continue;
    let lo = 0;
    let hi = withSynthesis ? fullShown - 1 : fullShown;
    let best = floor;
    let bestBudget = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const html = at(mid);
      if (htmlBytes(html) <= maxBytes) {
        best = html;
        bestBudget = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return { html: best, bytes: htmlBytes(best), truncated: true, shownStories: bestBudget };
  }

  // Nothing fits even with zero cards and no editorial block (only possible
  // with a pathological maxBytes). Send the smallest version rather than
  // nothing; the caller logs the truncation.
  const smallest = render({ limits: limitsForBudget(counts, 0), fullBriefLink }, false);
  return { html: smallest, bytes: htmlBytes(smallest), truncated: true, shownStories: 0 };
}
