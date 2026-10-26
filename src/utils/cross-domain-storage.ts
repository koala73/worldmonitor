import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';

const COOKIE_DOMAIN = '.worldmonitor.app';
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function usesCookies(): boolean {
  return location.hostname.endsWith('worldmonitor.app');
}

export function getDismissed(key: string): boolean {
  // The shared cookie carries a dismissal across *.worldmonitor.app. A browser
  // that drops that write still keeps the same-origin copy in localStorage.
  if (usesCookies() && document.cookie.split('; ').some((c) => c === `${key}=1`)) {
    return true;
  }
  const stored = safeStorageGet(key);
  return stored === '1' || stored === 'true';
}

export function setDismissed(key: string): void {
  if (usesCookies()) {
    document.cookie = `${key}=1; domain=${COOKIE_DOMAIN}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
  }
  safeStorageSet(key, '1');
}
