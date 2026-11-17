'use strict';

// HTML bodies for the relay's emails: a real-time alert, a quiet-hours batch,
// and the "connected" welcome. They share the daily digest's look
// (scripts/lib/digest-email-html.mjs): dark frame, logo header, severity
// cards with a coloured left edge, a green call to action and the same
// footer, so an alert does not arrive as bare text next to a designed brief.
//
// Inline styles and tables only (Gmail and Outlook drop <style> blocks and
// flex layouts). Every text field must already be shaped by the relay's
// notify-field sanitizers; this module escapes and lays them out. Links go
// through the same classifier as the text sinks: off-origin links name their
// host, an unresolvable link falls back to the dashboard.

const {
  classifyNotificationLink,
  isFirstPartyNotificationHost,
  NOTIFY_DASHBOARD_URL,
} = require('../shared/notify-fields.cjs');
const { UNSUBSCRIBE_SLOT } = require('./email-unsubscribe.cjs');

const LOGO_URL = 'https://www.worldmonitor.app/favico/android-chrome-192x192.png';
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SEVERITY_COLORS = { critical: '#ef4444', high: '#f97316', medium: '#eab308' };
const ACCENT = '#4ade80';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityLabel(severity) {
  const value = typeof severity === 'string' && severity.trim() ? severity.trim().toLowerCase() : 'high';
  return value.slice(0, 20);
}

function severityColor(severity) {
  return SEVERITY_COLORS[severityLabel(severity)] ?? ACCENT;
}

/** "Iran (IR)" for an ISO 3166-1 alpha-2 code, or null. */
function describeCountry(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code.trim())) return null;
  const iso2 = code.trim().toUpperCase();
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(iso2);
    return name ? `${name} (${iso2})` : iso2;
  } catch {
    return iso2;
  }
}

/**
 * Where a link goes and what its button says, or null when there is none.
 * Mirrors the Teams card and the text sinks' `(source: host)` disclosure.
 */
function resolveLink(rawLink, label = 'Read the original report') {
  const classified = classifyNotificationLink(rawLink);
  if (classified.kind === 'absent') return null;
  if (classified.kind === 'dashboard') return { url: NOTIFY_DASHBOARD_URL, label: 'Open WorldMonitor', host: null };
  const firstParty = isFirstPartyNotificationHost(classified.host);
  return { url: classified.url, label, host: firstParty ? null : classified.host };
}

function severityPill(severity) {
  const color = severityColor(severity);
  return `<span style="display: inline-block; padding: 3px 8px; border: 1px solid ${color}; color: ${color}; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; border-radius: 3px;">${escapeHtml(severityLabel(severity))}</span>`;
}

function primaryButton(href, label) {
  return `<a href="${escapeHtml(href)}" style="display: inline-block; background: ${ACCENT}; color: #0a0a0a; padding: 12px 28px; text-decoration: none; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 3px;">${escapeHtml(label)}</a>`;
}

function secondaryButton(href, label) {
  return `<a href="${escapeHtml(href)}" style="display: inline-block; border: 1px solid #333; color: #e0e0e0; padding: 11px 24px; text-decoration: none; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 3px;">${escapeHtml(label)}</a>`;
}

function factRow(label, value) {
  return `<tr>
              <td style="padding: 6px 0; width: 96px; vertical-align: top; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1.5px;">${escapeHtml(label)}</td>
              <td style="padding: 6px 0; vertical-align: top; font-size: 13px; color: #ccc; line-height: 1.45;">${escapeHtml(value)}</td>
            </tr>`;
}

/**
 * The shared frame: preheader, accent bar, logo header with a kicker on the
 * right, body, footer with the unsubscribe slot (filled by
 * injectUnsubscribeFooterHtml).
 */
function emailShell({ preheader = '', kicker = '', body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>WorldMonitor</title>
</head>
<body style="margin: 0; padding: 0; background: #111;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: #111;">${escapeHtml(preheader)}</div>
<div style="font-family: ${FONT_STACK}; background: #111; color: #e0e0e0; padding: 0;">
  <div style="max-width: 680px; margin: 0 auto;">
    <div style="background: ${ACCENT}; height: 3px;"></div>
    <div style="background: #0d0d0d; padding: 32px 36px 8px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="margin-bottom: 28px;">
        <tr>
          <td style="vertical-align: middle;">
            <table cellpadding="0" cellspacing="0" border="0" role="presentation">
              <tr>
                <td style="width: 36px; height: 36px; vertical-align: middle;">
                  <img src="${LOGO_URL}" width="36" height="36" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
                </td>
                <td style="padding-left: 10px;">
                  <div style="font-size: 15px; font-weight: 800; color: #fff; letter-spacing: -0.3px;">WORLD MONITOR</div>
                </td>
              </tr>
            </table>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 1px;">${escapeHtml(kicker)}</span>
          </td>
        </tr>
      </table>
${body}
    </div>
    <div style="background: #0a0a0a; border-top: 1px solid #1a1a1a; padding: 20px 36px; text-align: center;">
      <div style="margin-bottom: 12px;">
        <a href="https://x.com/worldmonitorai" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">X / Twitter</a>
        <a href="https://github.com/koala73/worldmonitor" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">GitHub</a>
      </div>
      <p style="font-size: 10px; color: #444; margin: 0; line-height: 1.5;">
        <a href="https://worldmonitor.app" style="color: ${ACCENT}; text-decoration: none;">worldmonitor.app</a>
      </p>
      <p style="font-size: 10px; color: #444; margin: 8px 0 0; line-height: 1.5;">${UNSUBSCRIBE_SLOT}</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

/**
 * Real-time alert email. Same fields as the Teams card
 * (buildTeamsAlertPayload).
 *
 * @param {{ title: string; severity?: string; countryCode?: string | null;
 *   source?: string; coverage?: string; description?: string; link?: string;
 *   eventType?: string; impact?: string }} alert
 */
function buildAlertEmailHtml(alert) {
  const color = severityColor(alert.severity);
  const country = describeCountry(alert.countryCode);
  const link = resolveLink(alert.link);

  const facts = [
    country ? factRow('Country', country) : '',
    alert.source ? factRow('Source', alert.source) : '',
    alert.coverage ? factRow('Coverage', alert.coverage) : '',
    alert.eventType ? factRow('Type', alert.eventType.replace(/_/g, ' ')) : '',
  ].filter(Boolean).join('\n');

  const impact = alert.impact
    ? `<div style="margin-top: 16px; padding: 14px 16px; background: #161616; border: 1px solid #222;">
          <div style="font-size: 10px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px;">Impact</div>
          <div style="font-size: 13px; color: #ccc; line-height: 1.55; white-space: pre-line;">${escapeHtml(alert.impact)}</div>
        </div>`
    : '';

  const buttons = link && link.url !== NOTIFY_DASHBOARD_URL
    ? `${primaryButton(link.url, link.label)}<span style="display: inline-block; width: 10px;"></span>${secondaryButton(NOTIFY_DASHBOARD_URL, 'Open dashboard')}`
    : primaryButton(NOTIFY_DASHBOARD_URL, 'Open dashboard');
  const hostNote = link?.host
    ? `<div style="margin-top: 10px; font-size: 11px; color: #666;">The report opens on ${escapeHtml(link.host)}.</div>`
    : '';

  const body = `      <div style="margin-bottom: 10px;">${severityPill(alert.severity)}</div>
      <div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid ${color}; padding: 18px 20px; margin-bottom: 8px;">
        <div style="font-size: 18px; font-weight: 700; color: #fff; line-height: 1.35;">${escapeHtml(alert.title)}</div>
        ${alert.description ? `<div style="margin-top: 10px; font-size: 13px; color: #999; line-height: 1.55;">${escapeHtml(alert.description)}</div>` : ''}
        ${facts ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="margin-top: 14px; border-top: 1px solid #1f1f1f;">
${facts}
        </table>` : ''}
        ${impact}
      </div>
      <div style="padding: 20px 0 28px;">
        ${buttons}
        ${hostNote}
      </div>`;

  return emailShell({ preheader: alert.description || alert.title, kicker: 'Real-time alert', body });
}

/**
 * Quiet-hours batch: the alerts held while the user's quiet hours were on.
 *
 * @param {Array<{ title: string; severity?: string; coverage?: string; link?: string }>} items
 */
function buildHeldAlertsEmailHtml(items) {
  const count = items.length;
  const cards = items.map((item) => {
    const color = severityColor(item.severity);
    const link = resolveLink(item.link);
    const titleHtml = link && link.url !== NOTIFY_DASHBOARD_URL
      ? `<a href="${escapeHtml(link.url)}" style="color: #e0e0e0; text-decoration: none; font-size: 14px; font-weight: 600; line-height: 1.4;">${escapeHtml(item.title)}</a>`
      : `<span style="color: #e0e0e0; font-size: 14px; font-weight: 600; line-height: 1.4;">${escapeHtml(item.title)}</span>`;
    const meta = [
      `<span style="font-size: 10px; color: ${color}; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">${escapeHtml(severityLabel(item.severity))}</span>`,
      item.coverage ? `<span style="font-size: 11px; color: #888;">${escapeHtml(item.coverage)}</span>` : '',
      link?.host ? `<span style="font-size: 11px; color: #555;">${escapeHtml(link.host)}</span>` : '',
    ].filter(Boolean).join('<span style="color: #333; margin: 0 6px;">&bull;</span>');
    return `<div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid ${color}; padding: 12px 16px; margin-bottom: 8px;">${titleHtml}<div style="margin-top: 6px;">${meta}</div></div>`;
  }).join('\n      ');

  const heading = `${count} alert${count !== 1 ? 's' : ''} held during quiet hours`;
  const body = `      <div style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 6px;">${escapeHtml(heading)}</div>
      <div style="font-size: 13px; color: #888; line-height: 1.5; margin-bottom: 20px;">These matched your alert rules while quiet hours were on.</div>
      ${cards}
      <div style="text-align: center; padding: 20px 0 28px;">${primaryButton(NOTIFY_DASHBOARD_URL, 'Open dashboard')}</div>`;

  return emailShell({ preheader: heading, kicker: 'Quiet hours', body });
}

/** Sent when an email channel is connected. */
function buildWelcomeEmailHtml() {
  const body = `      <div style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 10px;">Email notifications are on</div>
      <div style="font-size: 14px; color: #bbb; line-height: 1.6; margin-bottom: 8px;">You'll get an email here when an event matches your alert rules.</div>
      <div style="font-size: 13px; color: #888; line-height: 1.6;">Choose the countries, event types and delivery schedule in your notification settings.</div>
      <div style="padding: 24px 0 28px;">
        ${primaryButton('https://www.worldmonitor.app/dashboard?settings=notifications', 'Notification settings')}
      </div>`;
  return emailShell({ preheader: "You'll get an email here when an event matches your alert rules.", kicker: 'Connected', body });
}

module.exports = {
  buildAlertEmailHtml,
  buildHeldAlertsEmailHtml,
  buildWelcomeEmailHtml,
  escapeHtml,
};
