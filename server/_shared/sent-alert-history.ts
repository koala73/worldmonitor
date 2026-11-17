// Per-user record of the realtime alerts the notification relay delivered.
// Written by scripts/lib/sent-alert-history.cjs (LPUSH + LTRIM + EXPIRE on an
// unprefixed key), read by ListSentAlerts. tests/list-sent-alerts.test.mts
// fails when the key, the cap or the retention drift from the relay module.

export const SENT_ALERTS_KEY_PREFIX = 'wm:notif:sent:v1:';
export const SENT_ALERTS_MAX = 200;
export const SENT_ALERTS_RETENTION_DAYS = 7;

export interface SentAlertRecord {
  title: string;
  source: string;
  link: string;
  eventType: string;
  severity: string;
  sentAt: number;
  channels: string[];
}

export function sentAlertsKey(userId: string): string {
  return `${SENT_ALERTS_KEY_PREFIX}${userId}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function httpLink(value: unknown): string {
  const link = text(value);
  if (!link) return '';
  try {
    const { protocol } = new URL(link);
    return protocol === 'https:' || protocol === 'http:' ? link : '';
  } catch {
    return '';
  }
}

/** One stored row as the API returns it, or null when it has no title or time. */
export function parseSentAlert(value: unknown): SentAlertRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const title = text(row.title);
  const sentAt = row.sentAt;
  if (!title || typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt <= 0) return null;
  return {
    title,
    source: text(row.source),
    // The browser opens this in one click, so the scheme is checked again here.
    link: httpLink(row.link),
    eventType: text(row.eventType),
    severity: text(row.severity),
    sentAt,
    channels: Array.isArray(row.channels) ? row.channels.filter((item): item is string => typeof item === 'string' && item !== '') : [],
  };
}
