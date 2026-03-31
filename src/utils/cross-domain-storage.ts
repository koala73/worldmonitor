const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function getCookieDomain(): string {
  if (location.hostname.endsWith('worldmonitor.app')) return '.worldmonitor.app';
  if (location.hostname.endsWith('gantor.ir')) return '.gantor.ir';
  return '';
}

function usesCookies(): boolean {
  return location.hostname.endsWith('worldmonitor.app') || location.hostname.endsWith('gantor.ir');
}

export function getDismissed(key: string): boolean {
  if (usesCookies()) {
    return document.cookie.split('; ').some((c) => c === `${key}=1`);
  }
  return localStorage.getItem(key) === '1' || localStorage.getItem(key) === 'true';
}

export function setDismissed(key: string): void {
  if (usesCookies()) {
    const domain = getCookieDomain();
    const domainPart = domain ? `; domain=${domain}` : '';
    document.cookie = `${key}=1${domainPart}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
  }
  localStorage.setItem(key, '1');
}
