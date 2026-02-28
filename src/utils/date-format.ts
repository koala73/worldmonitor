/**
 * Date formatting utilities for World Monitor
 * @module utils/date-format
 */

/**
 * Format a date as relative time (e.g., "2 hours ago")
 * @param {Date | string | number} date - The date to format
 * @returns {string} Relative time string
 */
export function formatRelativeTime(date: Date | string | number): string {
  const now = new Date();
  const then = new Date(date);
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

  const intervals: { label: string; seconds: number }[] = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
    { label: 'second', seconds: 1 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
    }
  }

  return 'just now';
}

/**
 * Format a date for display in the UI
 * @param {Date | string | number} date - The date to format
 * @param {string} [locale='en-US'] - Locale for formatting
 * @returns {string} Formatted date string
 */
export function formatDisplayDate(
  date: Date | string | number,
  locale: string = 'en-US'
): string {
  const d = new Date(date);
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Check if a date is within the last N hours
 * @param {Date | string | number} date - The date to check
 * @param {number} hours - Number of hours
 * @returns {boolean} True if date is within the range
 */
export function isWithinHours(date: Date | string | number, hours: number): boolean {
  const now = new Date().getTime();
  const then = new Date(date).getTime();
  const diffMs = now - then;
  const hoursMs = hours * 60 * 60 * 1000;
  return diffMs <= hoursMs;
}
