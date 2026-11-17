'use strict';

// Per-user record of the realtime alerts the relay delivered, read by
// ListSentAlerts (server/worldmonitor/news/v1/list-sent-alerts.ts) so the
// dashboard search can find a headline after it left the loaded news.
//
// One Redis list per user, newest first, capped and expiring. It is written
// only for a user who received the alert on at least one channel, so it holds
// what reached that user and nothing about anyone else.
//
// The key and the record shape are mirrored in
// server/_shared/sent-alert-history.ts; tests/list-sent-alerts.test.mts fails
// when the two drift.

const { AsyncLocalStorage } = require('node:async_hooks');

const SENT_ALERTS_KEY_PREFIX = 'wm:notif:sent:v1:';
const SENT_ALERTS_MAX = 200;
const SENT_ALERTS_TTL_SECONDS = 7 * 24 * 60 * 60;
const SENT_ALERT_TITLE_MAX = 300;
const SENT_ALERT_SOURCE_MAX = 120;
const SENT_ALERT_LINK_MAX = 2048;
const SENT_ALERT_LABEL_MAX = 64;
// Three commands per record; 100 records keeps one request well under the
// Upstash pipeline size limit.
const RECORDS_PER_PIPELINE = 100;

function sentAlertsKey(userId) {
  return `${SENT_ALERTS_KEY_PREFIX}${userId}`;
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function httpLink(value) {
  const link = boundedText(value, SENT_ALERT_LINK_MAX);
  if (!link) return '';
  try {
    const { protocol } = new URL(link);
    return protocol === 'https:' || protocol === 'http:' ? link : '';
  } catch {
    return '';
  }
}

/** The stored record, or null when there is no title to search for. */
function buildSentAlertRecord({ title, source, link, eventType, severity, channels, sentAt } = {}) {
  const shapedTitle = boundedText(title, SENT_ALERT_TITLE_MAX);
  if (!shapedTitle) return null;
  const shapedChannels = Array.isArray(channels)
    ? [...new Set(channels.filter((channel) => typeof channel === 'string' && channel))].map((channel) => channel.slice(0, SENT_ALERT_LABEL_MAX))
    : [];
  return {
    title: shapedTitle,
    source: boundedText(source, SENT_ALERT_SOURCE_MAX),
    link: httpLink(link),
    eventType: boundedText(eventType, SENT_ALERT_LABEL_MAX),
    severity: boundedText(severity, SENT_ALERT_LABEL_MAX),
    sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
    channels: shapedChannels,
  };
}

function createSentAlertLog({ upstashUrl, upstashToken, userAgent = 'worldmonitor-relay/1.0', logPrefix = '[relay]' }) {
  const pending = new AsyncLocalStorage();

  // Fail-soft: the alert already went out, and a lost history row only means
  // the search source misses it. Upstash /pipeline is not transactional, so a
  // per-command error is reported instead of assumed away.
  async function writeSentAlerts(entries) {
    for (let i = 0; i < entries.length; i += RECORDS_PER_PIPELINE) {
      const commands = entries.slice(i, i + RECORDS_PER_PIPELINE).flatMap(({ userId, record }) => {
        const key = sentAlertsKey(userId);
        return [
          ['LPUSH', key, JSON.stringify(record)],
          ['LTRIM', key, '0', String(SENT_ALERTS_MAX - 1)],
          ['EXPIRE', key, String(SENT_ALERTS_TTL_SECONDS)],
        ];
      });
      try {
        const res = await fetch(`${upstashUrl}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
          body: JSON.stringify(commands),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          console.warn(`${logPrefix} sent-alert history not recorded: HTTP ${res.status}`);
          continue;
        }
        const body = await res.json().catch(() => null);
        const failed = Array.isArray(body) ? body.filter((result) => result?.error).length : 0;
        if (failed > 0) console.warn(`${logPrefix} sent-alert history: ${failed} of ${commands.length} commands failed`);
      } catch (err) {
        console.warn(`${logPrefix} sent-alert history not recorded: ${err?.message ?? err}`);
      }
    }
  }

  /** Record one delivered alert for one user. Inside `withSentAlertLog` it is written when the delivery ends. */
  async function noteSentAlert(userId, fields) {
    if (typeof userId !== 'string' || !userId) return;
    const record = buildSentAlertRecord(fields);
    if (!record) return;
    const entries = pending.getStore();
    if (entries) entries.push({ userId, record });
    else await writeSentAlerts([{ userId, record }]);
  }

  /** Run one delivery pass and write its records in one request, also when the pass throws. */
  async function withSentAlertLog(deliver) {
    if (pending.getStore()) return deliver();
    const entries = [];
    return pending.run(entries, async () => {
      try {
        return await deliver();
      } finally {
        if (entries.length > 0) await writeSentAlerts(entries);
      }
    });
  }

  return { noteSentAlert, withSentAlertLog };
}

module.exports = {
  SENT_ALERTS_KEY_PREFIX,
  SENT_ALERTS_MAX,
  SENT_ALERTS_TTL_SECONDS,
  SENT_ALERT_TITLE_MAX,
  buildSentAlertRecord,
  createSentAlertLog,
  sentAlertsKey,
};
