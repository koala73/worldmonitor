'use strict';

function toLocalHour(nowMs, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const h = parts.find(p => p.type === 'hour');
    return h ? parseInt(h.value, 10) : -1;
  } catch {
    return -1;
  }
}

function isInQuietHours(rule, nowMs = Date.now()) {
  if (!rule.quietHoursEnabled) return false;
  const start = rule.quietHoursStart ?? 22;
  const end = rule.quietHoursEnd ?? 7;
  if (start === end) return false; // same hour = no quiet window
  const tz = rule.quietHoursTimezone ?? 'UTC';
  const localHour = toLocalHour(nowMs, tz);
  if (localHour === -1) return false;
  // spans midnight when start > end (e.g. 23:00-07:00)
  return start < end
    ? localHour >= start && localHour < end
    : localHour >= start || localHour < end;
}

module.exports = { toLocalHour, isInQuietHours };
