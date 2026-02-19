import { t } from '@/services/i18n';

export function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t('popups.timeAgo.s', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('popups.timeAgo.m', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('popups.timeAgo.h', { count: hours });
  const days = Math.floor(hours / 24);
  return t('popups.timeAgo.d', { count: days });
}

export function getTimeUntil(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return t('popups.expired');
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return `${Math.floor(ms / (1000 * 60))}${t('popups.timeUnits.m')}`;
  if (hours < 24) return `${hours}${t('popups.timeUnits.h')}`;
  return `${Math.floor(hours / 24)}${t('popups.timeUnits.d')}`;
}

export function getMarketStatus(hours: { open: string; close: string; timezone: string }): 'open' | 'closed' | 'unknown' {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: hours.timezone,
    });
    const currentTime = formatter.format(now);
    const [openH = 0, openM = 0] = hours.open.split(':').map(Number);
    const [closeH = 0, closeM = 0] = hours.close.split(':').map(Number);
    const [currH = 0, currM = 0] = currentTime.split(':').map(Number);

    const openMins = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;
    const currMins = currH * 60 + currM;

    if (currMins >= openMins && currMins < closeMins) {
      return 'open';
    }
    return 'closed';
  } catch {
    return 'unknown';
  }
}

export function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return n.toString();
}
