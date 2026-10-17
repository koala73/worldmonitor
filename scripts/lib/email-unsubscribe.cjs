'use strict';

/**
 * One-click unsubscribe (RFC 8058) helpers for the Railway mail workers
 * (seed-digest-notifications.mjs: daily brief; notification-relay.cjs: alerts).
 *
 * The workers never sign tokens. Convex `/relay/channels` returns each email
 * channel with pre-signed `unsubscribeUrls: { brief, alerts }` pointing at the
 * Convex `/email/unsubscribe` route (see convex/lib/emailUnsubscribe.ts). A
 * URL is only trusted when it is https; anything else (or a missing URL, e.g.
 * EMAIL_UNSUBSCRIBE_SECRET not set yet) drops the header and falls back to a
 * visible Settings link, so mail still goes out.
 */

const SETTINGS_URL = 'https://www.worldmonitor.app/dashboard?settings=notifications';
const UNSUBSCRIBE_SLOT = '<!--wm-unsubscribe-slot-->';

/** @param {unknown} channel @param {'brief' | 'alerts'} list */
function unsubscribeUrlFor(channel, list) {
  const url = channel && channel.unsubscribeUrls && channel.unsubscribeUrls[list];
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

/** @param {string | null | undefined} url */
function listUnsubscribeHeaders(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return undefined;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fill the footer slot with a visible unsubscribe link (or a Settings link
 * when no one-click URL is available). Appends before the end when the
 * template has no slot, so the link is never silently dropped.
 * @param {string} html @param {string | null | undefined} url @param {string} label
 */
function injectUnsubscribeFooterHtml(html, url, label) {
  const href = typeof url === 'string' && url.startsWith('https://') ? url : SETTINGS_URL;
  const text = href === SETTINGS_URL ? 'Manage email notifications' : label;
  const link = `<a href="${escapeAttr(href)}" style="color: #777; text-decoration: underline;">${escapeAttr(text)}</a>`;
  if (html.includes(UNSUBSCRIBE_SLOT)) return html.replace(UNSUBSCRIBE_SLOT, link);
  return `${html}<p style="font-size: 10px; color: #777; text-align: center;">${link}</p>`;
}

/** @param {string} text @param {string | null | undefined} url @param {string} label */
function appendUnsubscribeText(text, url, label) {
  const href = typeof url === 'string' && url.startsWith('https://') ? url : SETTINGS_URL;
  const line = href === SETTINGS_URL ? `Manage email notifications: ${href}` : `${label}: ${href}`;
  return `${text}\n\n${line}`;
}

module.exports = {
  SETTINGS_URL,
  UNSUBSCRIBE_SLOT,
  appendUnsubscribeText,
  injectUnsubscribeFooterHtml,
  listUnsubscribeHeaders,
  unsubscribeUrlFor,
};
